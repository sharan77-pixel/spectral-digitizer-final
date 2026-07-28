const Jimp = require('jimp');

function getPixel(bitmap, x, y) {
  const idx = (y * bitmap.width + x) * 4;
  return {
    r: bitmap.data[idx],
    g: bitmap.data[idx + 1],
    b: bitmap.data[idx + 2]
  };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, v };
}

// Simple moving-average smoother
function smoothArray(arr, win) {
  if (win <= 1) return [...arr];
  const half = Math.floor(win / 2);
  return arr.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let w = -half; w <= half; w++) {
      const j = i + w;
      if (j >= 0 && j < arr.length) { sum += arr[j]; cnt++; }
    }
    return sum / cnt;
  });
}

const COLOR_DEFS = [
  {
    name: 'orange',
    test: (r, g, b, h, s, v) =>
      r > 100 && r > g + 15 && r > b + 35 && s > 0.12 && v > 0.15 &&
      h >= 10 && h <= 50
  },
  {
    name: 'yellow',
    test: (r, g, b, h, s, v) =>
      r > 120 && g > 120 && r > b + 30 && g > b + 30 && s > 0.15 && v > 0.30 &&
      h >= 50 && h <= 75
  },
  {
    name: 'red',
    test: (r, g, b, h, s, v) =>
      r > 100 && r > g + 20 && r > b + 20 && s > 0.15 && v > 0.15 &&
      (h <= 20 || h >= 330)
  },
  {
    name: 'blue',
    test: (r, g, b, h, s, v) =>
      b > 80 && b > r + 20 && b > g + 10 && s > 0.15 && v > 0.15 &&
      h >= 190 && h <= 270
  },
  {
    name: 'green',
    test: (r, g, b, h, s, v) =>
      g > 80 && g > r + 20 && g > b + 15 && s > 0.15 && v > 0.15 &&
      h >= 75 && h <= 170
  },
  {
    name: 'cyan',
    test: (r, g, b, h, s, v) =>
      g > 80 && b > 80 && g > r + 15 && b > r + 15 && s > 0.15 && v > 0.15 &&
      h >= 165 && h <= 205
  },
  {
    name: 'magenta',
    test: (r, g, b, h, s, v) =>
      r > 80 && b > 80 && r > g + 15 && b > g + 15 && s > 0.15 && v > 0.15 &&
      h >= 270 && h <= 340
  },
  {
    name: 'black',
    test: (r, g, b, h, s, v) =>
      v < 0.45 && s < 0.20 && r < 130 && g < 130 && b < 130
  }
];

function classifyColor(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);
  for (const c of COLOR_DEFS) {
    if (c.test(r, g, b, h, s, v)) return c.name;
  }
  return null;
}

function detectPlotVertices(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // Sample inner points to detect dark vs light theme backgrounds, avoiding black borders/margins
  const corners = [
    getPixel(bitmap, Math.floor(W * 0.2), Math.floor(H * 0.2)),
    getPixel(bitmap, Math.floor(W * 0.8), Math.floor(H * 0.2)),
    getPixel(bitmap, Math.floor(W * 0.2), Math.floor(H * 0.8)),
    getPixel(bitmap, Math.floor(W * 0.8), Math.floor(H * 0.8))
  ];
  const avgBg = corners.map(p => getLuminance(p.r, p.g, p.b)).reduce((a, b) => a + b, 0) / 4;
  const isDarkBg = avgBg < 120;

  // Count axis line candidate pixels inside inner area (excluding outer 5% margins)
  const colDark = new Int32Array(W);
  const rowDark = new Int32Array(H);
  const scanMinX = Math.floor(W * 0.05);
  const scanMaxX = Math.floor(W * 0.95);
  const scanMinY = Math.floor(H * 0.05);
  const scanMaxY = Math.floor(H * 0.95);

  for (let y = scanMinY; y < scanMaxY; y++) {
    for (let x = scanMinX; x < scanMaxX; x++) {
      const { r, g, b } = getPixel(bitmap, x, y);
      const lum = getLuminance(r, g, b);
      
      const isAxisPixel = isDarkBg 
        ? (lum > avgBg + 35) && (r > 100 || g > 100 || b > 100)
        : (lum < avgBg - 35) && (r < 150 && g < 150 && b < 150);
      
      if (isAxisPixel) {
        colDark[x]++;
        rowDark[y]++;
      }
    }
  }

  // Y-axis col: peak dark column in left 4–42% of image
  let xOrigin = Math.floor(W * 0.12);
  let best = 0;
  for (let x = Math.floor(W * 0.04); x < Math.floor(W * 0.42); x++) {
    if (colDark[x] > best) { best = colDark[x]; xOrigin = x; }
  }

  // X-axis row: peak dark row in bottom 55–97%
  // To avoid caption text, we only count dark pixels to the right of xOrigin
  let yOrigin = Math.floor(H * 0.82);
  best = 0;
  for (let y = Math.floor(H * 0.55); y < Math.floor(H * 0.97); y++) {
    let darkCount = 0;
    for (let x = xOrigin + 10; x < W - 10; x++) {
      const { r, g, b } = getPixel(bitmap, x, y);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 30) : (lum < avgBg - 30);
      if (isAxis) {
        darkCount++;
      }
    }
    if (darkCount > best) {
      best = darkCount;
      yOrigin = y;
    }
  }

  // xEnd: trace X-axis horizontal line RIGHTWARDS from xOrigin
  let xEnd = xOrigin + 50;
  let gapCount = 0;
  const maxGapX = Math.max(60, Math.floor(W * 0.08));
  for (let x = xOrigin + 1; x < W - 5; x++) {
    let foundDark = false;
    for (let dy = -4; dy <= 4; dy++) {
      const { r, g, b } = getPixel(bitmap, x, yOrigin + dy);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) {
        foundDark = true;
        break;
      }
    }
    if (foundDark) {
      xEnd = x;
      gapCount = 0;
    } else {
      gapCount++;
      if (gapCount > maxGapX) {
        break;
      }
    }
  }

  // yEnd: trace Y-axis vertical line UPWARDS from yOrigin
  let yEnd = yOrigin - 50;
  gapCount = 0;
  const maxGapY = Math.max(60, Math.floor(H * 0.08));
  for (let y = yOrigin - 1; y >= 5; y--) {
    let foundDark = false;
    for (let dx = -4; dx <= 4; dx++) {
      const { r, g, b } = getPixel(bitmap, xOrigin + dx, y);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) {
        foundDark = true;
        break;
      }
    }
    if (foundDark) {
      yEnd = y;
      gapCount = 0;
    } else {
      gapCount++;
      if (gapCount > maxGapY) {
        break;
      }
    }
  }

  console.log(`[vertices] origin=(${xOrigin},${yOrigin}), xEnd=(${xEnd},${yOrigin}), yEnd=(${xOrigin},${yEnd})`);

  return [
    { x: xOrigin, y: yOrigin },
    { x: xEnd,    y: yOrigin },
    { x: xOrigin, y: yEnd }
  ];
}

function assessQuality(bitmap, detectedVertices = null, ocrData = null) {
  const W = bitmap.width, H = bitmap.height;
  const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  
  // Grayscale copy to calculate metrics
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    gray[i] = Math.round((bitmap.data[idx] + bitmap.data[idx+1] + bitmap.data[idx+2]) / 3);
  }
  
  // 1. Blur Score (B, weight 0.20) — Variance of Laplacian (Threshold > 100)
  let lapSum = 0;
  const laplacian = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      const val = gray[(y+1)*W + x] + gray[(y-1)*W + x] + gray[y*W + (x+1)] + gray[y*W + (x-1)] - 4 * gray[idx];
      laplacian[idx] = val;
      lapSum += val;
    }
  }
  const lapMean = lapSum / ((W-2) * (H-2));
  let lapVar = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      lapVar += Math.pow(laplacian[idx] - lapMean, 2);
    }
  }
  const lapVariance = lapVar / ((W-2) * (H-2));
  
  let blurScore = 0;
  let blurStatus = "High";
  if (lapVariance >= 400) { blurScore = 100; blurStatus = "Low"; }
  else if (lapVariance >= 100) { blurScore = 70 + Math.round(((lapVariance - 100) / 300) * 30); blurStatus = "Medium"; }
  else { blurScore = Math.max(10, Math.round((lapVariance / 100) * 70)); blurStatus = "High"; }
  
  // 2. Resolution Score (R, weight 0.15) — Width x Height (Threshold > 1000 x 700)
  let resScore = 0;
  let resStatus = "Low";
  if (W >= 1500 && H >= 1000) { resScore = 100; resStatus = "Good"; }
  else if (W >= 1000 && H >= 700) { resScore = 80; resStatus = "Medium"; }
  else { resScore = Math.max(20, Math.min(80, Math.round(((W * H) / 700000) * 80))); resStatus = "Low"; }
  
  // 3. Noise Score (N, weight 0.15) — Signal-to-Noise Ratio (Threshold SNR > 20 dB)
  let sumGray = 0;
  for (let i = 0; i < W * H; i++) sumGray += gray[i];
  const meanGray = sumGray / (W * H);
  
  let localVarSum = 0;
  let blockCount = 0;
  for (let y = 5; y < H - 5; y += 10) {
    for (let x = 5; x < W - 5; x += 10) {
      let bSum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          bSum += gray[(y + dy) * W + (x + dx)];
        }
      }
      const bMean = bSum / 25;
      let bVar = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          bVar += Math.pow(gray[(y + dy) * W + (x + dx)] - bMean, 2);
        }
      }
      localVarSum += bVar / 25;
      blockCount++;
    }
  }
  const noiseVar = localVarSum / blockCount;
  
  let sigVar = 0;
  for (let i = 0; i < W * H; i++) {
    sigVar += Math.pow(gray[i] - meanGray, 2);
  }
  const signalVar = sigVar / (W * H);
  
  const snr = noiseVar > 0 ? 10 * Math.log10(signalVar / noiseVar) : 40;
  let noiseScore = 0;
  let noiseStatus = "High";
  if (snr >= 25) { noiseScore = 100; noiseStatus = "Low"; }
  else if (snr >= 12) { noiseScore = 60 + Math.round(((snr - 12) / 13) * 40); noiseStatus = "Medium"; }
  else { noiseScore = Math.max(10, Math.round((snr / 12) * 60)); noiseStatus = "High"; }
  
  // 4. Contrast Score (C, weight 0.15) — Standard Deviation of Pixels (Threshold SD > 45)
  const stdev = Math.sqrt(signalVar);
  let contrastScore = 0;
  let contrastStatus = "Low";
  if (stdev >= 55) { contrastScore = 100; contrastStatus = "Good"; }
  else if (stdev >= 35) { contrastScore = 70 + Math.round(((stdev - 35) / 20) * 30); contrastStatus = "Medium"; }
  else { contrastScore = Math.max(10, Math.round((stdev / 35) * 70)); contrastStatus = "Low"; }
  
  // 5. Calibration Score (Cal, weight 0.15)
  let calScore = detectedVertices && detectedVertices.length >= 3 ? 100 : 0;
  let calStatus = calScore === 100 ? "Yes" : "No";
  
  // 6. OCR Accuracy Score (A, weight 0.10)
  let ocrScore = 0;
  let ocrStatus = "No Data";
  if (ocrData) {
    if (ocrData.xRange && ocrData.xRange[0] !== null && ocrData.yRange && ocrData.yRange[0] !== null) {
      ocrScore = 100;
      ocrStatus = "Success";
    } else if (ocrData.xRange && ocrData.xRange[0] !== null) {
      ocrScore = 60;
      ocrStatus = "Partial X";
    } else {
      ocrScore = 10;
      ocrStatus = "Failed";
    }
  }
  
  // 7. OCR Confidence Score (O, weight 0.10)
  let ocrConfScore = ocrData && ocrData.confidence ? Math.round(ocrData.confidence) : 0;
  let ocrConfStatus = ocrConfScore >= 80 ? "High" : ocrConfScore >= 45 ? "Medium" : "Low";
  
  const finalScore = Math.round(
    blurScore * 0.20 +
    resScore * 0.15 +
    noiseScore * 0.15 +
    contrastScore * 0.15 +
    calScore * 0.15 +
    ocrScore * 0.10 +
    ocrConfScore * 0.10
  );
  
  let recommendations = [];
  if (blurScore < 70) recommendations.push("Avoid camera shake or improve lighting to reduce image blur.");
  if (resScore < 80)  recommendations.push("Upload a higher-resolution image (minimum 1000x700px recommended).");
  if (noiseScore < 80) recommendations.push("Reduce noise by using a cleaner digital source rather than a low-quality camera photo.");
  if (contrastScore < 70) recommendations.push("Increase image contrast or use a chart with darker gridlines.");
  if (calScore < 100) recommendations.push("Calibration clicks failed. Verify that axes limits are fully visible.");
  if (ocrScore < 60)  recommendations.push("OCR tick label recognition failed. Ensure numbers near axes are clearly legible.");
  
  return {
    score: finalScore,
    blur: blurScore,
    blurStatus,
    resolution: resScore,
    resStatus,
    noise: noiseScore,
    noiseStatus,
    contrast: contrastScore,
    contrastStatus,
    recommendations
  };
}

async function detectSkewAngle(jimpImg) {
  const thumb = jimpImg.clone().resize(200, Jimp.AUTO);
  const W = thumb.bitmap.width;
  const H = thumb.bitmap.height;
  
  const binary = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    const gray = (thumb.bitmap.data[idx] + thumb.bitmap.data[idx+1] + thumb.bitmap.data[idx+2]) / 3;
    binary[i] = gray < 180 ? 1 : 0;
  }
  
  let bestAngle = 0;
  let maxVariance = 0;
  
  for (let angle = -5.0; angle <= 5.0; angle += 0.5) {
    if (angle === 0) continue;
    
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = W / 2;
    const cy = H / 2;
    
    const rowSums = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const srcX = Math.round((x - cx) * cos + (y - cy) * sin + cx);
        const srcY = Math.round(-(x - cx) * sin + (y - cy) * cos + cy);
        if (srcX >= 0 && srcX < W && srcY >= 0 && srcY < H) {
          rowSums[y] += binary[srcY * W + srcX];
        }
      }
    }
    
    let sum = 0;
    for (let y = 0; y < H; y++) sum += rowSums[y];
    const mean = sum / H;
    
    let variance = 0;
    for (let y = 0; y < H; y++) {
      variance += Math.pow(rowSums[y] - mean, 2);
    }
    
    if (variance > maxVariance) {
      maxVariance = variance;
      bestAngle = angle;
    }
  }
  
  const rowSums0 = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      rowSums0[y] += binary[y * W + x];
    }
  }
  let sum0 = 0;
  for (let y = 0; y < H; y++) sum0 += rowSums0[y];
  const mean0 = sum0 / H;
  let var0 = 0;
  for (let y = 0; y < H; y++) var0 += Math.pow(rowSums0[y] - mean0, 2);
  
  if (var0 > maxVariance) {
    bestAngle = 0;
  }
  
  return bestAngle;
}

async function preprocessImage(img) {
  let upscaled = false;
  let W = img.bitmap.width;
  let H = img.bitmap.height;
  
  if (W < 1000 || H < 700) {
    img.resize(W * 2, H * 2, Jimp.RESIZE_BICUBIC);
    upscaled = true;
    W = img.bitmap.width;
    H = img.bitmap.height;
  }
  
  img.normalize();
  
  const sharpenKernel = [
    [ 0, -1,  0],
    [-1,  5, -1],
    [ 0, -1,  0]
  ];
  img.convolute(sharpenKernel);
  
  const angle = await detectSkewAngle(img);
  if (angle !== 0) {
    img.rotate(-angle, false);
  }
  
  return { upscaled, skewAngle: angle };
}

module.exports = {
  getPixel,
  rgbToHsv,
  smoothArray,
  COLOR_DEFS,
  classifyColor,
  detectPlotVertices,
  assessQuality,
  detectSkewAngle,
  preprocessImage
};
