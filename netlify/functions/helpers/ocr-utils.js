const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');
const { getPixel } = require('./image-utils');
const { adaptiveThresholdBradley } = require('./threshold');

function findTrueTicks(nums) {
  if (nums.length === 0) return [];
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  if (sorted.length <= 2) return sorted;
  
  const diffs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    diffs.push(sorted[i+1] - sorted[i]);
  }
  
  const activeDiffs = diffs.filter(d => d > 0);
  if (activeDiffs.length === 0) return sorted;
  const minDiff = Math.min(...activeDiffs);
  
  const groups = [[sorted[0]]];
  for (let i = 0; i < sorted.length - 1; i++) {
    const val = sorted[i+1];
    const gap = diffs[i];
    if (gap > 15 * minDiff && gap > 0.5) {
      groups.push([val]);
    } else {
      groups[groups.length - 1].push(val);
    }
  }
  
  let bestGroup = groups[0];
  for (const g of groups) {
    if (g.length > bestGroup.length) {
      bestGroup = g;
    }
  }
  return bestGroup;
}

function correctArithmeticProgression(nums) {
  if (nums.length < 3) return nums;
  const sorted = [...nums].sort((a, b) => a - b);
  
  const diffs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    diffs.push(Number((sorted[i+1] - sorted[i]).toFixed(6)));
  }
  
  const counts = {};
  let maxCount = 0;
  let step = 0;
  for (const d of diffs) {
    if (d <= 0) continue;
    counts[d] = (counts[d] || 0) + 1;
    if (counts[d] > maxCount) {
      maxCount = counts[d];
      step = d;
    }
  }
  
  if (step === 0) return nums;
  
  let bestAnchor = sorted[0];
  let maxSubsetSize = 0;
  for (const anchor of sorted) {
    const subset = sorted.filter(x => {
      const div = (x - anchor) / step;
      return Math.abs(div - Math.round(div)) < 1e-4;
    });
    if (subset.length > maxSubsetSize) {
      maxSubsetSize = subset.length;
      bestAnchor = anchor;
    }
  }
  
  if (maxSubsetSize >= 2) {
    return sorted.map((x, idx) => {
      const div = (x - bestAnchor) / step;
      if (Math.abs(div - Math.round(div)) < 1e-4) {
        return x;
      }
      if (idx === 0) {
        return sorted[1] - step;
      }
      if (idx === sorted.length - 1) {
        return sorted[sorted.length - 2] + step;
      }
      const prev = sorted[idx - 1];
      const next = sorted[idx + 1];
      const prevDiv = (prev - bestAnchor) / step;
      const nextDiv = (next - bestAnchor) / step;
      if (Math.abs(prevDiv - Math.round(prevDiv)) < 1e-4 && Math.abs(nextDiv - Math.round(nextDiv)) < 1e-4) {
        if (Math.round(nextDiv - prevDiv) === 2) {
          return prev + step;
        }
      }
      return x;
    });
  }
  
  return nums;
}

const unicodeSuperscripts = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-'
};

const superMapServer = { '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 };

function parseScientificOrLogLabel(text, isLogHypothesis) {
  if (!text) return NaN;
  let clean = text.replace(/\s+/g, '');

  if (isLogHypothesis) {
    if (/^10-(\d+)$/.test(clean)) {
      const exp = parseInt(clean.substring(3));
      return Math.pow(10, -exp);
    }
    if (/^10\+(\d+)$/.test(clean)) {
      const exp = parseInt(clean.substring(3));
      return Math.pow(10, exp);
    }
    if (/^10\^(-?\d+)$/.test(clean)) {
      const match = clean.match(/^10\^(-?\d+)$/);
      if (match) return Math.pow(10, parseInt(match[1]));
    }
    if (/^10[⁻⁺+-]?([⁰¹²³⁴⁵⁶⁷⁸⁹])$/.test(clean)) {
      const match = clean.match(/^10([⁻⁺+-]?)([⁰¹²³⁴⁵⁶⁷⁸⁹])$/);
      if (match) {
        const isNeg = match[1] === '⁻' || match[1] === '-';
        const exp = superMapServer[match[2]];
        return Math.pow(10, isNeg ? -exp : exp);
      }
    }
    const sciRegex = /^(-?\d+(?:\.\d+)?)[eE](-?\d+)$/;
    const sciMatch = clean.match(sciRegex);
    if (sciMatch) {
      const coeff = parseFloat(sciMatch[1]);
      const exp = parseInt(sciMatch[2]);
      return coeff * Math.pow(10, exp);
    }
    const logRegex = /^log(?:10)?\(?([0-9.eE+-^]+)\)?$/i;
    const logMatch = clean.match(logRegex);
    if (logMatch) {
      const innerVal = parseScientificOrLogLabel(logMatch[1], true);
      if (!isNaN(innerVal)) {
        return Math.log10(innerVal);
      }
    }
    if (/^-?\d+(?:\.\d+)?$/.test(clean)) {
      return parseFloat(clean);
    }
  } else {
    const sciRegex = /^(-?\d+(?:\.\d+)?)[eE](-?\d+)$/;
    const sciMatch = clean.match(sciRegex);
    if (sciMatch) {
      const coeff = parseFloat(sciMatch[1]);
      const exp = parseInt(sciMatch[2]);
      return coeff * Math.pow(10, exp);
    }
    if (/^-?\d+(?:\.\d+)?$/.test(clean)) {
      return parseFloat(clean);
    }
  }

  let cleanMapped = text.split('').map(c => unicodeSuperscripts[c] || c).join('').replace(/\s+/g, '');
  const parsed = parseFloat(cleanMapped);
  return isNaN(parsed) ? NaN : parsed;
}

function snapToPowerOf10(val) {
  if (val <= 0) return val;
  const logVal = Math.log10(val);
  const roundedLog = Math.round(logVal);
  if (Math.abs(logVal - roundedLog) < 0.15) {
    return Number(Math.pow(10, roundedLog).toFixed(6));
  }
  return Number(val.toFixed(6));
}

function linearRegression(xArr, yArr) {
  const n = xArr.length;
  if (n < 2) return { r2: 0, slope: 0, intercept: 0, stdError: Infinity };
  
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;
  for (let i = 0; i < n; i++) {
    const x = xArr[i];
    const y = yArr[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
  }
  
  const num = n * sumXY - sumX * sumY;
  const den = n * sumXX - sumX * sumX;
  if (den === 0) return { r2: 0, slope: 0, intercept: 0, stdError: Infinity };
  
  const slope = num / den;
  const intercept = (sumY - slope * sumX) / n;
  
  let ssErr = 0;
  let ssTot = 0;
  const meanY = sumY / n;
  for (let i = 0; i < n; i++) {
    const predY = slope * xArr[i] + intercept;
    ssErr += Math.pow(yArr[i] - predY, 2);
    ssTot += Math.pow(yArr[i] - meanY, 2);
  }
  
  const r2 = ssTot === 0 ? 1 : 1 - (ssErr / ssTot);
  const stdError = Math.sqrt(ssErr / (n - 2 || 1));
  
  return { r2, slope, intercept, stdError };
}

function detectXTickMarks(bitmap, origin, xMaxV, isDarkBg, avgBg) {
  const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const yOrigin = origin.y;
  const xOrigin = origin.x;
  const xEnd = xMaxV.x;
  
  const tickCounts = new Int32Array(xEnd - xOrigin + 1);
  for (let x = xOrigin; x <= xEnd; x++) {
    let count = 0;
    for (let dy = 1; dy <= 8; dy++) {
      if (yOrigin + dy >= bitmap.height) continue;
      const { r, g, b } = getPixel(bitmap, x, yOrigin + dy);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) count++;
    }
    for (let dy = 1; dy <= 8; dy++) {
      if (yOrigin - dy < 0) continue;
      const { r, g, b } = getPixel(bitmap, x, yOrigin - dy);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) count++;
    }
    tickCounts[x - xOrigin] = count;
  }
  
  const ticks = [];
  for (let i = 5; i < tickCounts.length - 5; i++) {
    const val = tickCounts[i];
    if (val >= 3) {
      let isLocalMax = true;
      for (let j = -3; j <= 3; j++) {
        if (tickCounts[i + j] > val) {
          isLocalMax = false;
          break;
        }
      }
      if (isLocalMax) {
        ticks.push(xOrigin + i);
        i += 5;
      }
    }
  }
  return ticks;
}

function detectYTickMarks(bitmap, origin, yMaxV, isDarkBg, avgBg) {
  const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const xOrigin = origin.x;
  const yOrigin = origin.y;
  const yEnd = yMaxV.y;
  
  const tickCounts = new Int32Array(yOrigin - yEnd + 1);
  for (let y = yEnd; y <= yOrigin; y++) {
    let count = 0;
    for (let dx = 1; dx <= 8; dx++) {
      if (xOrigin - dx < 0) continue;
      const { r, g, b } = getPixel(bitmap, xOrigin - dx, y);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) count++;
    }
    for (let dx = 1; dx <= 8; dx++) {
      if (xOrigin + dx >= bitmap.width) continue;
      const { r, g, b } = getPixel(bitmap, xOrigin + dx, y);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) count++;
    }
    tickCounts[y - yEnd] = count;
  }
  
  const ticks = [];
  for (let i = 5; i < tickCounts.length - 5; i++) {
    const val = tickCounts[i];
    if (val >= 3) {
      let isLocalMax = true;
      for (let j = -3; j <= 3; j++) {
        if (tickCounts[i + j] > val) {
          isLocalMax = false;
          break;
        }
      }
      if (isLocalMax) {
        ticks.push(yEnd + i);
        i += 5;
      }
    }
  }
  return ticks;
}

function snapLabelsToTicks(labels, detectedTicks, maxDist = 20) {
  return labels.map(label => {
    let bestTick = label.coord;
    let minDist = maxDist;
    for (const t of detectedTicks) {
      const dist = Math.abs(label.coord - t);
      if (dist < minDist) {
        minDist = dist;
        bestTick = t;
      }
    }
    return {
      val: label.val,
      coord: bestTick,
      text: label.text
    };
  });
}

function filterLinearTicks(ticks, coordKey) {
  if (ticks.length <= 2) return ticks;
  let bestSubset = [];
  
  for (let i = 0; i < ticks.length; i++) {
    for (let j = 0; j < ticks.length; j++) {
      if (i === j) continue;
      const t1 = ticks[i];
      const t2 = ticks[j];
      if (Math.abs(t1.val - t2.val) < 1e-4) continue;
      
      const scale = (t2[coordKey] - t1[coordKey]) / (t2.val - t1.val);
      if (coordKey === 'x' && scale <= 0) continue;
      if (coordKey === 'y' && scale >= 0) continue;
      
      const subset = [t1, t2];
      for (let k = 0; k < ticks.length; k++) {
        if (k === i || k === j) continue;
        const tk = ticks[k];
        const predCoord = t1[coordKey] + scale * (tk.val - t1.val);
        if (Math.abs(tk[coordKey] - predCoord) < 20) {
          subset.push(tk);
        }
      }
      
      if (subset.length > bestSubset.length) {
        bestSubset = subset;
      }
    }
  }
  
  return bestSubset.length >= 2 ? bestSubset : ticks;
}

function filterTicksLog(ticks, coordKey) {
  const validTicks = ticks.filter(t => t.val > 0);
  if (validTicks.length <= 2) return validTicks;
  let bestSubset = [];
  
  for (let i = 0; i < validTicks.length; i++) {
    for (let j = 0; j < validTicks.length; j++) {
      if (i === j) continue;
      const t1 = validTicks[i];
      const t2 = validTicks[j];
      const logVal1 = Math.log10(t1.val);
      const logVal2 = Math.log10(t2.val);
      if (Math.abs(logVal1 - logVal2) < 1e-4) continue;
      
      const scale = (t2[coordKey] - t1[coordKey]) / (logVal2 - logVal1);
      if (coordKey === 'x' && scale <= 0) continue;
      if (coordKey === 'y' && scale >= 0) continue;
      
      const subset = [t1, t2];
      for (let k = 0; k < validTicks.length; k++) {
        if (k === i || k === j) continue;
        const tk = validTicks[k];
        const logValK = Math.log10(tk.val);
        const predCoord = t1[coordKey] + scale * (logValK - logVal1);
        if (Math.abs(tk[coordKey] - predCoord) < 25) {
          subset.push(tk);
        }
      }
      if (subset.length > bestSubset.length) {
        bestSubset = subset;
      }
    }
  }
  return bestSubset.length >= 2 ? bestSubset : validTicks;
}

async function recognizeAxesLimits(jimpImg, vertices) {
  let Tesseract;
  try { Tesseract = require('tesseract.js'); } catch (e) { Tesseract = null; }

  const [origin, xMaxV, yMaxV] = vertices;
  const W = jimpImg.bitmap.width, H = jimpImg.bitmap.height;

  let xRange = [null, null];
  let yRange = [null, null];
  let xScaleType = 'linear';
  let yScaleType = 'linear';
  const xLabel = 'Wavelength (nm)', yLabel = 'Absorbance';

  if (!Tesseract) {
    return { xRange: [300, 1000], yRange: [0.0, 1.0], xScaleType, yScaleType, xLabel, yLabel };
  }

  async function ocrRegion(clone) {
    if (clone.bitmap.width < 3 || clone.bitmap.height < 3) {
      return { data: { text: "", words: [] } };
    }
    clone.resize(clone.bitmap.width * 3, clone.bitmap.height * 3, Jimp.RESIZE_BICUBIC);
    clone.greyscale();

    let darkPixels = 0;
    const totalPixels = clone.bitmap.width * clone.bitmap.height;
    clone.scan(0, 0, clone.bitmap.width, clone.bitmap.height, function(x, y, idx) {
      if (this.bitmap.data[idx] < 128) {
        darkPixels++;
      }
    });
    const isStripDark = darkPixels > totalPixels * 0.5;

    adaptiveThresholdBradley(clone.bitmap, 0.15, 0.15);

    if (isStripDark) {
      clone.scan(0, 0, clone.bitmap.width, clone.bitmap.height, function(x, y, idx) {
        const val = this.bitmap.data[idx] === 0 ? 255 : 0;
        this.bitmap.data[idx] = val;
        this.bitmap.data[idx+1] = val;
        this.bitmap.data[idx+2] = val;
      });
    }

    const buf = await clone.getBufferAsync(Jimp.MIME_PNG);
    const options = {
      logger: () => {},
      tessedit_char_whitelist: '0123456789.eE+-^logLOG*xX()⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'
    };
    
    // Check if training data exists in __dirname or process.cwd(), otherwise fall back to CDN
    if (fs.existsSync(path.join(__dirname, 'eng.traineddata'))) {
      options.langPath = __dirname;
    } else if (fs.existsSync(path.join(process.cwd(), 'eng.traineddata'))) {
      options.langPath = process.cwd();
    }
    
    const r = await Tesseract.recognize(buf, 'eng', options);
    return r;
  }

  const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const corners = [
    getPixel(jimpImg.bitmap, Math.floor(W * 0.2), Math.floor(H * 0.2)),
    getPixel(jimpImg.bitmap, Math.floor(W * 0.8), Math.floor(H * 0.2)),
    getPixel(jimpImg.bitmap, Math.floor(W * 0.2), Math.floor(H * 0.8)),
    getPixel(jimpImg.bitmap, Math.floor(W * 0.8), Math.floor(H * 0.8))
  ];
  const avgBg = corners.map(p => getLuminance(p.r, p.g, p.b)).reduce((a, b) => a + b, 0) / 4;
  const isDarkBg = avgBg < 120;

  const xTickMarks = detectXTickMarks(jimpImg.bitmap, origin, xMaxV, isDarkBg, avgBg);
  const yTickMarks = detectYTickMarks(jimpImg.bitmap, origin, yMaxV, isDarkBg, avgBg);

  try {
    const stripY = Math.max(0, origin.y - 5);
    const stripH = H - stripY;
    const stripX = Math.max(0, origin.x - 20);
    const stripW = W - stripX;

    const xStrip = jimpImg.clone().crop(stripX, stripY, stripW, stripH);
    const ocrResX = await ocrRegion(xStrip);
    const txtX = ocrResX.data.text;
    
    const xTicksRaw = [];
    if (ocrResX.data && ocrResX.data.words) {
      for (const word of ocrResX.data.words) {
        const x_orig = stripX + (word.bbox.x0 + word.bbox.x1) / 6;
        xTicksRaw.push({ text: word.text, coord: x_orig });
      }
    }

    const isPowerOf10X = xTicksRaw.some(t => /10\s*-\s*\d/.test(t.text) || /10\s*[\^⁻]/.test(t.text)) ||
                         (xTicksRaw.length >= 2 && xTicksRaw.filter(t => /^10[-+^⁰¹²³⁴⁵⁶⁷⁸⁹\d]./.test(t.text.replace(/\s+/g, ''))).length >= xTicksRaw.length * 0.5);

    const xTicksLinear = [];
    const xTicksLog = [];
    for (const t of xTicksRaw) {
      const valLinear = parseScientificOrLogLabel(t.text, false);
      const valLog = parseScientificOrLogLabel(t.text, true);
      
      if (!isNaN(valLinear)) xTicksLinear.push({ val: valLinear, x: t.coord, text: t.text });
      if (!isNaN(valLog) && valLog > 0) xTicksLog.push({ val: valLog, x: t.coord, text: t.text });
    }

    const snappedLinearX = snapLabelsToTicks(xTicksLinear, xTickMarks).map(t => ({ val: t.val, x: t.coord }));
    const snappedLogX = snapLabelsToTicks(xTicksLog, xTickMarks).map(t => ({ val: t.val, x: t.coord }));

    const filteredLinearX = filterLinearTicks(snappedLinearX, 'x');
    const filteredLogX = filterTicksLog(snappedLogX, 'x');

    let finalXTicks = filteredLinearX;

    const regLinearX = linearRegression(filteredLinearX.map(t => t.x), filteredLinearX.map(t => t.val));
    const regLogX = linearRegression(filteredLogX.map(t => t.x), filteredLogX.map(t => Math.log10(t.val)));

    if (filteredLogX.length >= 2 && filteredLinearX.length >= 2) {
      if (regLogX.r2 > 0.9 && (regLogX.r2 > regLinearX.r2 || isPowerOf10X || txtX.includes('log') || txtX.includes('Log'))) {
        xScaleType = 'log';
        finalXTicks = filteredLogX;
      }
    } else if (filteredLogX.length >= 2) {
      xScaleType = 'log';
      finalXTicks = filteredLogX;
    } else if (filteredLinearX.length >= 2) {
      xScaleType = 'linear';
      finalXTicks = filteredLinearX;
    } else {
      if (isPowerOf10X || txtX.includes('log') || txtX.includes('Log')) {
        xScaleType = 'log';
      }
    }

    if (finalXTicks.length >= 2) {
      finalXTicks.sort((a, b) => a.x - b.x);
      const firstTick = finalXTicks[0];
      const lastTick = finalXTicks[finalXTicks.length - 1];
      
      if (xScaleType === 'log') {
        const logFirst = Math.log10(firstTick.val);
        const logLast = Math.log10(lastTick.val);
        if (Math.abs(logLast - logFirst) > 1e-4) {
          const scale_x = (lastTick.x - firstTick.x) / (logLast - logFirst);
          const logV0 = logFirst - (firstTick.x - origin.x) / scale_x;
          const logV1 = logFirst + (xMaxV.x - firstTick.x) / scale_x;
          xRange[0] = snapToPowerOf10(Math.pow(10, logV0));
          xRange[1] = snapToPowerOf10(Math.pow(10, logV1));
        } else {
          xRange = [300, 1000];
        }
      } else {
        if (Math.abs(lastTick.val - firstTick.val) > 1e-4) {
          const scale_x = (lastTick.x - firstTick.x) / (lastTick.val - firstTick.val);
          const v0 = firstTick.val - (firstTick.x - origin.x) / scale_x;
          const v1 = firstTick.val + (xMaxV.x - firstTick.x) / scale_x;
          xRange[0] = Math.abs(v0) > 10 ? Math.round(v0) : Number(v0.toFixed(4));
          xRange[1] = Math.abs(v1) > 10 ? Math.round(v1) : Number(v1.toFixed(4));
        } else {
          xRange = [300, 1000];
        }
      }
    } else if (finalXTicks.length === 1) {
      if (xScaleType === 'log') {
        xRange = [snapToPowerOf10(finalXTicks[0].val / 10), snapToPowerOf10(finalXTicks[0].val * 10)];
      } else {
        xRange = [finalXTicks[0].val - 100, finalXTicks[0].val + 100];
      }
    }

    const yStripX = 0;
    const yStripW = Math.max(10, origin.x - 5);
    const yStripY = Math.max(0, yMaxV.y - 15);
    const yStripH = Math.min(origin.y - yMaxV.y + 30, H - yStripY);

    const yStrip = jimpImg.clone().crop(yStripX, yStripY, yStripW, yStripH);
    const ocrResY = await ocrRegion(yStrip);
    const txtY = ocrResY.data.text;
    
    const yTicksRaw = [];
    if (ocrResY.data && ocrResY.data.words) {
      for (const word of ocrResY.data.words) {
        const y_orig = yStripY + (word.bbox.y0 + word.bbox.y1) / 6;
        yTicksRaw.push({ text: word.text, coord: y_orig });
      }
    }

    const isPowerOf10Y = yTicksRaw.some(t => /10\s*-\s*\d/.test(t.text) || /10\s*[\^⁻]/.test(t.text)) ||
                         (yTicksRaw.length >= 2 && yTicksRaw.filter(t => /^10[-+^⁰¹²³⁴⁵⁶⁷⁸⁹\d]./.test(t.text.replace(/\s+/g, ''))).length >= yTicksRaw.length * 0.5);

    const yTicksLinear = [];
    const yTicksLog = [];
    for (const t of yTicksRaw) {
      const valLinear = parseScientificOrLogLabel(t.text, false);
      const valLog = parseScientificOrLogLabel(t.text, true);
      
      if (!isNaN(valLinear)) yTicksLinear.push({ val: valLinear, y: t.coord, text: t.text });
      if (!isNaN(valLog) && valLog > 0) yTicksLog.push({ val: valLog, y: t.coord, text: t.text });
    }

    const snappedLinearY = snapLabelsToTicks(yTicksLinear, yTickMarks).map(t => ({ val: t.val, y: t.coord }));
    const snappedLogY = snapLabelsToTicks(yTicksLog, yTickMarks).map(t => ({ val: t.val, y: t.coord }));

    const filteredLinearY = filterLinearTicks(snappedLinearY, 'y');
    const filteredLogY = filterTicksLog(snappedLogY, 'y');

    let finalYTicks = filteredLinearY;

    const regLinearY = linearRegression(filteredLinearY.map(t => t.y), filteredLinearY.map(t => t.val));
    const regLogY = linearRegression(filteredLogY.map(t => t.y), filteredLogY.map(t => Math.log10(t.val)));

    if (filteredLogY.length >= 2 && filteredLinearY.length >= 2) {
      if (regLogY.r2 > 0.9 && (regLogY.r2 > regLinearY.r2 || isPowerOf10Y || txtY.includes('log') || txtY.includes('Log'))) {
        yScaleType = 'log';
        finalYTicks = filteredLogY;
      }
    } else if (filteredLogY.length >= 2) {
      yScaleType = 'log';
      finalYTicks = filteredLogY;
    } else if (filteredLinearY.length >= 2) {
      yScaleType = 'linear';
      finalYTicks = filteredLinearY;
    } else {
      if (isPowerOf10Y || txtY.includes('log') || txtY.includes('Log')) {
        yScaleType = 'log';
      }
    }

    if (finalYTicks.length >= 2) {
      finalYTicks.sort((a, b) => a.y - b.y);
      const topTick = finalYTicks[0];
      const bottomTick = finalYTicks[finalYTicks.length - 1];
      
      if (yScaleType === 'log') {
        const logTop = Math.log10(topTick.val);
        const logBottom = Math.log10(bottomTick.val);
        if (Math.abs(logTop - logBottom) > 1e-4) {
          const scale_y = (bottomTick.y - topTick.y) / (logTop - logBottom);
          const logV0 = logBottom - (origin.y - bottomTick.y) / scale_y;
          const logV1 = logTop + (topTick.y - yMaxV.y) / scale_y;
          yRange[0] = snapToPowerOf10(Math.pow(10, logV0));
          yRange[1] = snapToPowerOf10(Math.pow(10, logV1));
        } else {
          yRange = [0.1, 10];
        }
      } else {
        if (Math.abs(topTick.val - bottomTick.val) > 1e-4) {
          const scale_y = (bottomTick.y - topTick.y) / (topTick.val - bottomTick.val);
          const v0 = bottomTick.val - (origin.y - bottomTick.y) / scale_y;
          const v1 = topTick.val + (topTick.y - yMaxV.y) / scale_y;
          yRange[0] = Math.abs(v0) > 10 ? Math.round(v0) : Number(v0.toFixed(4));
          yRange[1] = Math.abs(v1) > 10 ? Math.round(v1) : Number(v1.toFixed(4));
        } else {
          yRange = [0.0, 1.0];
        }
      }
    } else if (finalYTicks.length === 1) {
      if (yScaleType === 'log') {
        yRange = [snapToPowerOf10(finalYTicks[0].val / 10), snapToPowerOf10(finalYTicks[0].val * 10)];
      } else {
        yRange = [finalYTicks[0].val - 0.5, finalYTicks[0].val + 0.5];
      }
    }
  } catch (err) {
    console.warn('[OCR error]', err.message);
  }

  if (xRange[0] === null || isNaN(xRange[0])) xRange[0] = 300;
  if (xRange[1] === null || isNaN(xRange[1]) || xRange[1] <= xRange[0]) xRange[1] = 1000;
  if (yRange[0] === null || isNaN(yRange[0])) yRange[0] = 0.0;
  if (yRange[1] === null || isNaN(yRange[1]) || yRange[1] <= yRange[0]) yRange[1] = 1.0;

  return { xRange, yRange, xScaleType, yScaleType, xLabel, yLabel };
}

module.exports = {
  findTrueTicks,
  correctArithmeticProgression,
  parseScientificOrLogLabel,
  snapToPowerOf10,
  linearRegression,
  detectXTickMarks,
  detectYTickMarks,
  snapLabelsToTicks,
  filterLinearTicks,
  filterTicksLog,
  recognizeAxesLimits
};
