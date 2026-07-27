const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Jimp = require('jimp');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const app = express();
const PORT = 3000;

// Load .env file automatically if present
if (fs.existsSync(path.join(__dirname, '.env'))) {
    try {
        const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        envContent.split('\n').forEach(line => {
            const cleanLine = line.trim();
            if (cleanLine && !cleanLine.startsWith('#')) {
                const parts = cleanLine.split('=');
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    let val = parts.slice(1).join('=').trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1);
                    }
                    if (!process.env[key]) {
                        process.env[key] = val;
                    }
                }
            }
        });
        console.log('[Server] Loaded environment variables from .env file.');
    } catch (e) {
        console.warn('[Server] Could not parse .env file:', e.message);
    }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
const staticOptions = {
    setHeaders: (res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    }
};

app.use(express.static(path.join(__dirname, 'public'), staticOptions));
// Serve browser builds of npm packages directly (only locally; Netlify serves them as static assets directly from the CDN)
if (!process.env.NETLIFY) {
  app.use('/vendor/tf', express.static(path.join(__dirname, 'node_modules/@tensorflow/tfjs/dist'), staticOptions));
  app.use('/vendor/upscaler', express.static(path.join(__dirname, 'node_modules/upscaler/dist/browser/umd'), staticOptions));
  app.use('/vendor/default-model', express.static(path.join(__dirname, 'node_modules/@upscalerjs/default-model/dist/umd'), staticOptions));
  app.use('/vendor/tesseract', express.static(path.join(__dirname, 'node_modules/tesseract.js/dist'), staticOptions));
  app.use('/vendor/tesseract-core', express.static(path.join(__dirname, 'node_modules/tesseract.js-core'), staticOptions));
  app.use('/vendor/tesseract-lang', express.static(__dirname, staticOptions));
  app.use('/models', express.static(path.join(__dirname, 'node_modules/@upscalerjs/default-model/models'), staticOptions));
}



const storage = multer.memoryStorage();
const upload = multer({ storage: storage }).array('files', 100);

// ─────────────────────────────────────────────────────────────────
//  PIXEL HELPERS
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
//  COLOR CLASSIFIER
//  Strategy: use RGB ratio tests + loose HSV checks so that faint
//  curve strokes (low saturation) still get detected.
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
//  VERTEX DETECTION
//  Finds the three corners of the plot area:
//    P0 = Origin     (bottom-left)
//    P1 = X-axis end (bottom-right)
//    P2 = Y-axis end (top-left)
// ─────────────────────────────────────────────────────────────────
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

// Helper to group parsed numbers by gaps to isolate the true tick label values
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

// Helper to correct any outlier/misread ticks using arithmetic progression spacing
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
    // 1. Pattern: 10^-3 or 10-3
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
    // 2. Pattern with actual unicode superscript: 10³, 10⁻³, 10⁻²
    if (/^10[⁻⁺+-]?([⁰¹²³⁴⁵⁶⁷⁸⁹])$/.test(clean)) {
      const match = clean.match(/^10([⁻⁺+-]?)([⁰¹²³⁴⁵⁶⁷⁸⁹])$/);
      if (match) {
        const isNeg = match[1] === '⁻' || match[1] === '-';
        const exp = superMapServer[match[2]];
        return Math.pow(10, isNeg ? -exp : exp);
      }
    }
    // 3. Pattern: 1e-3, 1E-3
    const sciRegex = /^(-?\d+(?:\.\d+)?)[eE](-?\d+)$/;
    const sciMatch = clean.match(sciRegex);
    if (sciMatch) {
      const coeff = parseFloat(sciMatch[1]);
      const exp = parseInt(sciMatch[2]);
      return coeff * Math.pow(10, exp);
    }
    // 4. Pattern: log(100)
    const logRegex = /^log(?:10)?\(?([0-9.eE+-^]+)\)?$/i;
    const logMatch = clean.match(logRegex);
    if (logMatch) {
      const innerVal = parseScientificOrLogLabel(logMatch[1], true);
      if (!isNaN(innerVal)) {
        return Math.log10(innerVal);
      }
    }
    // 5. Standard float
    if (/^-?\d+(?:\.\d+)?$/.test(clean)) {
      return parseFloat(clean);
    }
  } else {
    // Linear Hypothesis: parse as regular float or standard scientific notation
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

  // Fallback with unicode superscript mapping
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
  
  // R2 calculation
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
    // Check below axis (typically ticks go outwards)
    for (let dy = 1; dy <= 8; dy++) {
      if (yOrigin + dy >= bitmap.height) continue;
      const { r, g, b } = getPixel(bitmap, x, yOrigin + dy);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) count++;
    }
    // Also check above axis just in case ticks point inwards
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
  // Find local maxima
  for (let i = 5; i < tickCounts.length - 5; i++) {
    const val = tickCounts[i];
    if (val >= 3) { // Must be at least 3 pixels long
      let isLocalMax = true;
      for (let j = -3; j <= 3; j++) {
        if (tickCounts[i + j] > val) {
          isLocalMax = false;
          break;
        }
      }
      if (isLocalMax) {
        ticks.push(xOrigin + i);
        i += 5; // Skip close duplicates
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
    // Check left of axis (typically ticks go outwards)
    for (let dx = 1; dx <= 8; dx++) {
      if (xOrigin - dx < 0) continue;
      const { r, g, b } = getPixel(bitmap, xOrigin - dx, y);
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) count++;
    }
    // Also check right of axis in case ticks point inwards
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
  // Find local maxima
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
        i += 5; // Skip close duplicates
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

// Consensus filter to find the largest subset of ticks that conform to a linear scale
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
      // Coordinate layout direction:
      // X-axis: pixel coordinate increases as value increases -> scale > 0
      // Y-axis: pixel coordinate decreases as value increases -> scale < 0
      if (coordKey === 'x' && scale <= 0) continue;
      if (coordKey === 'y' && scale >= 0) continue;
      
      const subset = [t1, t2];
      for (let k = 0; k < ticks.length; k++) {
        if (k === i || k === j) continue;
        const tk = ticks[k];
        const predCoord = t1[coordKey] + scale * (tk.val - t1.val);
        if (Math.abs(tk[coordKey] - predCoord) < 20) { // 20 pixels tolerance
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
        if (Math.abs(tk[coordKey] - predCoord) < 25) { // 25 pixels tolerance
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

// ─────────────────────────────────────────────────────────────────
//  OCR AXIS LIMITS
//  Reads the numeric tick labels from the plot to get the real-
//  world x/y range.
// ─────────────────────────────────────────────────────────────────
async function recognizeAxesLimits(jimpImg, vertices) {
  let Tesseract;
  try { Tesseract = require('tesseract.js'); } catch (e) { Tesseract = null; }

  const [origin, xMaxV, yMaxV] = vertices;
  const W = jimpImg.bitmap.width, H = jimpImg.bitmap.height;

  // Fallback defaults — will be overwritten by OCR if successful
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
    // Scale up crop region using bicubic to preserve font detail, then greyscale
    clone.resize(clone.bitmap.width * 3, clone.bitmap.height * 3, Jimp.RESIZE_BICUBIC);
    clone.greyscale();

    // Check if background of this cropped strip is dark
    let darkPixels = 0;
    const totalPixels = clone.bitmap.width * clone.bitmap.height;
    clone.scan(0, 0, clone.bitmap.width, clone.bitmap.height, function(x, y, idx) {
      if (this.bitmap.data[idx] < 128) {
        darkPixels++;
      }
    });
    const isStripDark = darkPixels > totalPixels * 0.5;

    // Apply local adaptive Bradley binarization
    adaptiveThresholdBradley(clone.bitmap, 0.15, 0.15);

    // If background is dark, invert black (0) and white (255) to ensure black text on white background
    if (isStripDark) {
      clone.scan(0, 0, clone.bitmap.width, clone.bitmap.height, function(x, y, idx) {
        const val = this.bitmap.data[idx] === 0 ? 255 : 0;
        this.bitmap.data[idx] = val;
        this.bitmap.data[idx+1] = val;
        this.bitmap.data[idx+2] = val;
      });
    }

    const buf = await clone.getBufferAsync(Jimp.MIME_PNG);
    const relativeLangPath = path.relative(process.cwd(), __dirname) || '.';
    const r = await Tesseract.recognize(buf, 'eng', {
      langPath: relativeLangPath,
      logger: () => {},
      tessedit_char_whitelist: '0123456789.eE+-^logLOG*xX()⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻'
    });
    return r;
  }

  // Detect background information for tick marks
  const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const corners = [
    getPixel(jimpImg.bitmap, Math.floor(W * 0.2), Math.floor(H * 0.2)),
    getPixel(jimpImg.bitmap, Math.floor(W * 0.8), Math.floor(H * 0.2)),
    getPixel(jimpImg.bitmap, Math.floor(W * 0.2), Math.floor(H * 0.8)),
    getPixel(jimpImg.bitmap, Math.floor(W * 0.8), Math.floor(H * 0.8))
  ];
  const avgBg = corners.map(p => getLuminance(p.r, p.g, p.b)).reduce((a, b) => a + b, 0) / 4;
  const isDarkBg = avgBg < 120;

  // Detect structural tick marks on axes lines
  const xTickMarks = detectXTickMarks(jimpImg.bitmap, origin, xMaxV, isDarkBg, avgBg);
  const yTickMarks = detectYTickMarks(jimpImg.bitmap, origin, yMaxV, isDarkBg, avgBg);

  // ── Scan ALL tick labels along the X-axis row ─────────────────
  try {
    const stripY = Math.max(0, origin.y - 5);
    const stripH = H - stripY;
    const stripX = Math.max(0, origin.x - 20);
    const stripW = W - stripX;

    const xStrip = jimpImg.clone().crop(stripX, stripY, stripW, stripH);
    const ocrResX = await ocrRegion(xStrip);
    const txtX = ocrResX.data.text;
    
    // Extract raw text and coordinates of X axis labels
    const xTicksRaw = [];
    if (ocrResX.data && ocrResX.data.words) {
      for (const word of ocrResX.data.words) {
        const x_orig = stripX + (word.bbox.x0 + word.bbox.x1) / 6;
        xTicksRaw.push({ text: word.text, coord: x_orig });
      }
    }

    console.log('[OCR x-axis raw labels found]', xTicksRaw);

    const isPowerOf10X = xTicksRaw.some(t => /10\s*-\s*\d/.test(t.text) || /10\s*[\^⁻]/.test(t.text)) ||
                         (xTicksRaw.length >= 2 && xTicksRaw.filter(t => /^10[-+^⁰¹²³⁴⁵⁶⁷⁸⁹\d]./.test(t.text.replace(/\s+/g, ''))).length >= xTicksRaw.length * 0.5);

    // Build Linear and Log candidate tick sets
    const xTicksLinear = [];
    const xTicksLog = [];
    for (const t of xTicksRaw) {
      const valLinear = parseScientificOrLogLabel(t.text, false);
      const valLog = parseScientificOrLogLabel(t.text, true);
      
      if (!isNaN(valLinear)) xTicksLinear.push({ val: valLinear, x: t.coord, text: t.text });
      if (!isNaN(valLog) && valLog > 0) xTicksLog.push({ val: valLog, x: t.coord, text: t.text });
    }

    // Snap to tick marks
    const snappedLinearX = snapLabelsToTicks(xTicksLinear, xTickMarks).map(t => ({ val: t.val, x: t.coord }));
    const snappedLogX = snapLabelsToTicks(xTicksLog, xTickMarks).map(t => ({ val: t.val, x: t.coord }));

    // Run consensus filtering
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

    console.log(`[Calibration X] Detected scale type: ${xScaleType}, Linear R2: ${regLinearX.r2.toFixed(4)}, Log R2: ${regLogX.r2.toFixed(4)}`);

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

    // ── Scan ALL tick labels along Y-axis column ───────────────
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

    console.log('[OCR y-axis raw labels found]', yTicksRaw);

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

    console.log(`[Calibration Y] Detected scale type: ${yScaleType}, Linear R2: ${regLinearY.r2.toFixed(4)}, Log R2: ${regLogY.r2.toFixed(4)}`);

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

  // Final fallback if OCR found nothing useful
  if (xRange[0] === null || isNaN(xRange[0])) xRange[0] = 300;
  if (xRange[1] === null || isNaN(xRange[1]) || xRange[1] <= xRange[0]) xRange[1] = 1000;
  if (yRange[0] === null || isNaN(yRange[0])) yRange[0] = 0.0;
  if (yRange[1] === null || isNaN(yRange[1]) || yRange[1] <= yRange[0]) yRange[1] = 1.0;

  console.log(`[OCR result] xRange=${JSON.stringify(xRange)}, yRange=${JSON.stringify(yRange)}, xScaleType=${xScaleType}, yScaleType=${yScaleType}`);
  return { xRange, yRange, xScaleType, yScaleType, xLabel, yLabel };
}


// ─────────────────────────────────────────────────────────────────
//  MAIN CURVE TRACER
//  For every pixel column inside the plot area:
//    1. Collect all colored pixels in that column
//    2. Use centroid Y of each color's cluster
//    3. Convert pixel → real-world coordinates
//    4. Smooth with moving average
// ─────────────────────────────────────────────────────────────────
function traceCurves(bitmap, vertices, xRange, yRange, configs) {
  const [origin, xMaxV, yMaxV] = vertices;
  const xMinVal = xRange[0], xMaxVal = xRange[1];
  const yMinVal = yRange[0], yMaxVal = yRange[1];
  const W = bitmap.width, H = bitmap.height;

  const colorMode  = configs.colorMode  || 'grayscale';
  const smoothWin  = Math.max(1, Math.round(configs.smoothingWindow || 7));
  const whiteThr   = configs.whitenessThresh || 220;
  const xScaleType = configs.xScaleType || 'linear';
  const yScaleType = configs.yScaleType || 'linear';

  const xMin = Math.min(xMinVal, xMaxVal);
  const xMax = Math.max(xMinVal, xMaxVal);
  const yMin = Math.min(yMinVal, yMaxVal);
  const yMax = Math.max(yMinVal, yMaxVal);

  // Plot area with 6px safety margin from axis lines to avoid tracing tick marks and border lines
  const pxLeft   = origin.x + 6;
  const pxRight  = xMaxV.x  - 6;
  const pxTop    = yMaxV.y  + 6;
  const pxBottom = origin.y - 6;

  if (pxRight <= pxLeft || pxBottom <= pxTop) {
    console.warn('[tracer] Invalid plot bounds, aborting');
    return [];
  }

  const plotW = pxRight - pxLeft;

  // colPixels[colorName][x] = [y1, y2, ...]
  const colPixels = {};
  for (const c of COLOR_DEFS) colPixels[c.name] = {};

  // Scan every pixel inside the plot area
  for (let y = pxTop; y <= pxBottom; y++) {
    for (let x = pxLeft; x <= pxRight; x++) {
      const { r, g, b } = getPixel(bitmap, x, y);

      // Skip white/near-white background
      if (r > whiteThr && g > whiteThr && b > whiteThr) continue;

      const color = classifyColor(r, g, b);
      if (color) {
        if (!colPixels[color][x]) colPixels[color][x] = [];
        colPixels[color][x].push(y);
      }
    }
  }

  // Convert pixel → real coordinates with support for Logarithmic axes
  function pixToReal(px, py) {
    const xPct = (px - origin.x) / (xMaxV.x - origin.x);
    const yPct = (origin.y - py)  / (origin.y - yMaxV.y);
    
    let rx, ry;
    if (xScaleType === 'log') {
      if (xMinVal > 0 && xMaxVal > 0) {
        const logMin = Math.log10(xMinVal);
        const logMax = Math.log10(xMaxVal);
        rx = Math.pow(10, logMin + xPct * (logMax - logMin));
      } else {
        rx = xMinVal + xPct * (xMaxVal - xMinVal);
      }
    } else {
      rx = xMinVal + xPct * (xMaxVal - xMinVal);
    }
    
    if (yScaleType === 'log') {
      if (yMinVal > 0 && yMaxVal > 0) {
        const logMin = Math.log10(yMinVal);
        const logMax = Math.log10(yMaxVal);
        ry = Math.pow(10, logMin + yPct * (logMax - logMin));
      } else {
        ry = yMinVal + yPct * (yMaxVal - yMinVal);
      }
    } else {
      ry = yMinVal + yPct * (yMaxVal - yMinVal);
    }
    
    return [rx, ry];
  }

  // Scale-independent validation helper to handle scientific notation & log limits safely
  function isValidPt(rx, ry) {
    if (isNaN(rx) || isNaN(ry)) return false;
    const xMargin = (xMax - xMin) * 0.02 || 2;
    const yMargin = (yMax - yMin) * 0.05 || 0.05;
    return (rx >= xMin - xMargin && rx <= xMax + xMargin &&
            ry >= yMin - yMargin && ry <= yMax + yMargin);
  }

  // Build multiple smooth curves from a column→ys map using continuous nearest-neighbor tracking of multiple paths
  function buildCurves(colMap, colorName) {
    const cols = Object.keys(colMap).map(Number).sort((a, b) => a - b);
    const minCols = Math.max(15, Math.floor(plotW * 0.08));
    if (cols.length < 5) return [];

    // Group Y coordinates in each column into clusters
    const colClusters = {};
    for (const x of cols) {
      const ys = colMap[x];
      if (!ys || ys.length === 0) continue;
      const sortedYs = [...ys].sort((a, b) => a - b);
      
      const clusters = [];
      let currentCluster = [sortedYs[0]];
      for (let i = 1; i < sortedYs.length; i++) {
        if (sortedYs[i] - sortedYs[i-1] <= 4) { // group pixels within 4px of each other
          currentCluster.push(sortedYs[i]);
        } else {
          clusters.push(currentCluster);
          currentCluster = [sortedYs[i]];
        }
      }
      clusters.push(currentCluster);
      
      // Calculate centroid of each cluster
      colClusters[x] = clusters.map(c => {
        const sum = c.reduce((a, b) => a + b, 0);
        return sum / c.length;
      });
    }

    const paths = []; // all paths
    const activePaths = []; // references to currently active paths
    
    // We scan every column from pxLeft to pxRight to ensure we cover the entire plot area
    for (let x = pxLeft; x <= pxRight; x++) {
      const candidates = colClusters[x] ? [...colClusters[x]] : [];
      
      // Matched states
      const matchedPaths = new Set();
      const matchedCandidates = new Set();
      const pathsToDeactivate = [];
      
      // Greedy momentum-based matching: match closest path-candidate pairs first
      const matches = [];
      for (let pIdx = 0; pIdx < activePaths.length; pIdx++) {
        const path = activePaths[pIdx];
        if (candidates.length === 0) continue;
        
        for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
          const c = candidates[cIdx];
          const dist = Math.abs(c - path.lastY);
          if (dist <= 250) { // 250px proximity radius to support extremely steep curves
            matches.push({ pIdx, cIdx, dist });
          }
        }
      }
      
      // Sort matches by distance ascending
      matches.sort((a, b) => a.dist - b.dist);
      
      for (const match of matches) {
        if (matchedPaths.has(match.pIdx) || matchedCandidates.has(match.cIdx)) continue;
        
        matchedPaths.add(match.pIdx);
        matchedCandidates.add(match.cIdx);
        
        const path = activePaths[match.pIdx];
        const c = candidates[match.cIdx];
        
        // Update slope using EMA
        const dy = c - (path.points[path.points.length - 1][1]);
        path.slope = path.points.length < 2 ? dy : 0.7 * path.slope + 0.3 * dy;
        
        path.points.push([x, c]);
        path.lastY = c;
        path.gapCount = 0;
      }
      
      // For paths that didn't match:
      for (let pIdx = 0; pIdx < activePaths.length; pIdx++) {
        if (matchedPaths.has(pIdx)) continue;
        const path = activePaths[pIdx];
        
        path.gapCount++;
        if (path.gapCount > 20) {
          pathsToDeactivate.push(path);
        } else {
          // Carry forward predicted Y based on current slope
          const predY = path.lastY + path.slope;
          path.points.push([x, predY]);
          path.lastY = predY;
        }
      }
      
      // Deactivate paths
      for (const p of pathsToDeactivate) {
        const idx = activePaths.indexOf(p);
        if (idx !== -1) activePaths.splice(idx, 1);
      }
      
      // Start new paths for unmatched candidates
      for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
        if (matchedCandidates.has(cIdx)) continue;
        const c = candidates[cIdx];
        const newPath = {
          points: [[x, c]],
          lastY: c,
          slope: 0,
          gapCount: 0
        };
        paths.push(newPath);
        activePaths.push(newPath);
      }
    }

    // Path stitching (stitching broken curves of the same color)
    const sortedPaths = [...paths].sort((a, b) => a.points[0][0] - b.points[0][0]);
    const stitchedPaths = [];
    
    for (const p of sortedPaths) {
      if (p.points.length === 0) continue;
      
      let merged = false;
      for (const existing of stitchedPaths) {
        const firstPt = p.points[0];
        let lastPt = existing.points[existing.points.length - 1];
        if (!lastPt) continue;
        
        let gapX = firstPt[0] - lastPt[0];
        
        // If there is a slight overlap in X (up to 80px), truncate the existing path to resolve the overlap
        if (gapX <= 0 && gapX > -80) {
          const overlapIdx = existing.points.findIndex(pt => pt[0] >= firstPt[0]);
          if (overlapIdx !== -1) {
            existing.points = existing.points.slice(0, overlapIdx);
            const newLastPt = existing.points[existing.points.length - 1];
            if (newLastPt) {
              lastPt = newLastPt;
              gapX = firstPt[0] - lastPt[0];
            } else {
              // Path became empty, cannot stitch
              continue;
            }
          }
        }
        
        if (gapX > 0 && gapX < 125) {
          const gapY = Math.abs(firstPt[1] - lastPt[1]);
          if (gapY < 300) { // Support vertical gaps up to 300px on steep curves
            // Check slope direction similarity
            const predictedY = lastPt[1] + existing.slope * gapX;
            const diffY = Math.abs(firstPt[1] - predictedY);
            
            if (diffY < 60) {
              // Fill the gap with linear interpolation
              for (let x = lastPt[0] + 1; x < firstPt[0]; x++) {
                const pct = (x - lastPt[0]) / gapX;
                const interpY = lastPt[1] + pct * (firstPt[1] - lastPt[1]);
                existing.points.push([x, interpY]);
              }
              // Append path points
              existing.points.push(...p.points);
              existing.slope = p.slope;
              merged = true;
              break;
            }
          }
        }
      }
      
      if (!merged) {
        stitchedPaths.push(p);
      }
    }

    // Now filter paths and convert to real-world coordinates
    const finalCurves = [];
    let curveIndex = 1;
    for (const path of stitchedPaths) {
      // Filter out flat, short legend segments or grid line pieces
      const pixelYs = path.points.map(pt => pt[1]);
      const meanY = pixelYs.reduce((a, b) => a + b, 0) / pixelYs.length;
      const variance = pixelYs.reduce((sum, y) => sum + Math.pow(y - meanY, 2), 0) / pixelYs.length;
      const stdDev = Math.sqrt(variance);
      
      if (stdDev < 4.0 && path.points.length < plotW * 0.40) {
        console.log(`[tracer] ${colorName}: skipped flat short segment (stdDev=${stdDev.toFixed(2)}, len=${path.points.length})`);
        continue;
      }

      // Filter out top and bottom borders (paths running close to pxTop or pxBottom)
      if (meanY < pxTop + 10 || meanY > pxBottom - 10) {
        console.log(`[tracer] ${colorName}: skipped border segment (avgY=${meanY.toFixed(2)}, top=${pxTop}, bottom=${pxBottom})`);
        continue;
      }

      const rawX = [];
      const rawY = [];
      for (const [px, py] of path.points) {
        const [rx, ry] = pixToReal(px, py);
        if (isValidPt(rx, ry)) {
          rawX.push(rx);
          rawY.push(Math.max(yMin, Math.min(yMax, ry)));
        }
      }
      
      if (rawX.length >= minCols) {
        const smoothY = smoothArray(rawY, smoothWin);
        finalCurves.push({
          color: colorName,
          name: `${colorName}_curve_${curveIndex++}`,
          data: rawX.map((x, i) => [x, smoothY[i]])
        });
      }
    }
    
    return finalCurves;
  }

  const results = [];

  if (colorMode === 'grayscale') {
    // Try every color class (except black — handled separately below)
    for (const c of COLOR_DEFS) {
      if (c.name === 'black') continue;
      const curves = buildCurves(colPixels[c.name], c.name);
      results.push(...curves);
    }
    // Also always try black/dark curves (many published spectra use black)
    const blackCurves = buildCurves(colPixels['black'], 'black');
    results.push(...blackCurves);

  } else {
    // Single specific color requested
    const curves = buildCurves(colPixels[colorMode], colorMode);
    results.push(...curves);
    if (curves.length === 0) {
      // Fallback: try black pixels
      const fb = buildCurves(colPixels['black'], 'black');
      results.push(...fb);
    }
  }

  // Deduplicate parallel/duplicate curves of the same color
  const deduplicated = [];
  for (let i = 0; i < results.length; i++) {
    let isDuplicate = false;
    const c1 = results[i];
    
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      const c2 = results[j];
      if (c1.color !== c2.color) continue;
      
      // If c2 is longer than c1, check if c1 is duplicate of c2
      if (c2.data.length > c1.data.length) {
        // Find overlap
        let sharedCount = 0;
        let sumDiffY = 0;
        
        for (const pt1 of c1.data) {
          const rx = pt1[0];
          const matchPt2 = c2.data.find(pt => Math.abs(pt[0] - rx) < 1e-4);
          if (matchPt2) {
            sharedCount++;
            sumDiffY += Math.abs(pt1[1] - matchPt2[1]);
          }
        }
        
        if (sharedCount > 30 && sharedCount > c1.data.length * 0.5) {
          const avgDiffY = sumDiffY / sharedCount;
          const yRangeSpan = Math.abs(yRange[1] - yRange[0]) || 1.0;
          const avgDiffYPixels = (avgDiffY / yRangeSpan) * (origin.y - yMaxV.y);
          
          if (avgDiffYPixels < 20.0) {
            isDuplicate = true;
            console.log(`[tracer] Discarded duplicate curve: ${c1.name} (duplicate of ${c2.name}, avgDiffYPixels=${avgDiffYPixels.toFixed(2)})`);
            break;
          }
        }
      }
    }
    if (!isDuplicate) {
      deduplicated.push(c1);
    }
  }

  // Re-index final curve names
  const colorCounts = {};
  const finalResults = deduplicated.map(c => {
    colorCounts[c.color] = (colorCounts[c.color] || 0) + 1;
    return {
      color: c.color,
      name: `${c.color}_curve_${colorCounts[c.color]}`,
      data: c.data
    };
  });

  console.log(`[tracer] Total curves returned after deduplication: ${finalResults.length} (${finalResults.map(c=>c.name).join(', ')})`);
  return finalResults;
}

// ─────────────────────────────────────────────────────────────────
//  IMAGE QUALITY ASSESSMENT & PREPROCESSING PIPELINE
// ─────────────────────────────────────────────────────────────────

function assessQuality(bitmap, detectedVertices = null, ocrData = null) {
  const W = bitmap.width;
  const H = bitmap.height;
  
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
  const avgNoiseDev = Math.sqrt(localVarSum / (blockCount || 1));
  const snrDb = 20 * Math.log10((meanGray + 1) / (avgNoiseDev + 0.1));
  let noiseScore = 0;
  if (snrDb >= 25) noiseScore = 100;
  else if (snrDb >= 20) noiseScore = 80 + Math.round(((snrDb - 20) / 5) * 20);
  else noiseScore = Math.max(10, Math.round((snrDb / 20) * 80));

  // 4. Contrast Score (C, weight 0.10) — RMS Contrast (Threshold > 40)
  let variance = 0;
  for (let i = 0; i < W * H; i++) variance += Math.pow(gray[i] - meanGray, 2);
  const rms = Math.sqrt(variance / (W * H));
  
  let contrastScore = 0;
  let contrastStatus = "Low";
  if (rms >= 45) { contrastScore = 100; contrastStatus = "Good"; }
  else if (rms >= 25) { contrastScore = 75 + Math.round(((rms - 25) / 20) * 25); contrastStatus = "Medium"; }
  else { contrastScore = Math.max(10, Math.round((rms / 25) * 75)); contrastStatus = "Low"; }

  // 5. Lighting Score (L, weight 0.10) — Mean Intensity (Threshold 70-200)
  let lightingScore = 0;
  if (meanGray >= 70 && meanGray <= 200) lightingScore = 100;
  else if (meanGray >= 50 && meanGray <= 220) lightingScore = 75;
  else lightingScore = Math.max(20, Math.round(100 - Math.abs(meanGray - 135) * 0.6));

  // 6. Axis Detection Score (A, weight 0.10) — Both axes detected
  let axisScore = 80;
  if (detectedVertices && detectedVertices.length >= 3) {
    const origin = detectedVertices[0], xMaxV = detectedVertices[1], yMaxV = detectedVertices[2];
    const dx = Math.abs(xMaxV.x - origin.x);
    const dy = Math.abs(origin.y - yMaxV.y);
    if (dx > W * 0.3 && dy > H * 0.3) axisScore = 100;
    else if (dx > W * 0.15 || dy > H * 0.15) axisScore = 60;
    else axisScore = 30;
  }

  // 7. OCR Confidence Score (O, weight 0.10) — Tesseract tick label recognition (>80%)
  let ocrScore = 80;
  if (ocrData) {
    if (ocrData.words && ocrData.words.length >= 4) ocrScore = 100;
    else if (ocrData.words && ocrData.words.length >= 2) ocrScore = 75;
    else ocrScore = 40;
  }

  // 8. Graph Area Completeness Score (G, weight 0.10) — Contour graph area (>60%)
  let graphScore = 80;
  if (detectedVertices && detectedVertices.length >= 3) {
    const origin = detectedVertices[0], xMaxV = detectedVertices[1], yMaxV = detectedVertices[2];
    const plotArea = (xMaxV.x - origin.x) * (origin.y - yMaxV.y);
    const totalArea = W * H;
    const ratio = plotArea / totalArea;
    if (ratio >= 0.50) graphScore = 100;
    else if (ratio >= 0.35) graphScore = 80;
    else graphScore = Math.max(20, Math.round((ratio / 0.50) * 100));
  }

  // Final Weighted Quality Score Q:
  // Q = 0.20B + 0.15R + 0.15N + 0.10C + 0.10L + 0.10A + 0.10O + 0.10G
  const overallScore = Math.round(
    0.20 * blurScore +
    0.15 * resScore +
    0.15 * noiseScore +
    0.10 * contrastScore +
    0.10 * lightingScore +
    0.10 * axisScore +
    0.10 * ocrScore +
    0.10 * graphScore
  );

  // Decision Thresholds
  let decision = "pass";
  let qualityLevel = "Good";
  if (overallScore >= 90) { decision = "pass"; qualityLevel = "Excellent"; }
  else if (overallScore >= 75) { decision = "pass"; qualityLevel = "Good"; }
  else if (overallScore >= 60) { decision = "warning"; qualityLevel = "Acceptable"; }
  else { decision = "reject"; qualityLevel = "Rejected"; }

  // Recommendations
  const recommendations = [];
  if (blurScore < 70) recommendations.push("Blur detected (Laplacian Var < 100). Keep camera steady or use higher focus.");
  if (resScore < 70) recommendations.push("Resolution is low (< 1000x700). Upload higher resolution scan.");
  if (noiseScore < 70) recommendations.push("High noise level (SNR < 20 dB). Use denoise filter in pre-processing.");
  if (contrastScore < 70) recommendations.push("Low contrast (RMS < 40). Increase contrast slider in pre-processing.");
  if (lightingScore < 70) recommendations.push("Sub-optimal lighting. Ensure even illumination without heavy shadows.");
  if (axisScore < 70) recommendations.push("Axis detection weak. Use 'Calibrate by Clicks' to trace axes manually.");
  if (recommendations.length === 0) recommendations.push("SIQA Quality Assessment Passed! Excellent spectrum image.");

  return {
    width: W,
    height: H,
    overallScore,
    decision,
    qualityLevel,
    siqa: {
      blurScore,
      resScore,
      noiseScore,
      contrastScore,
      lightingScore,
      axisScore,
      ocrScore,
      graphScore,
      snrDb: snrDb.toFixed(1),
      rmsContrast: rms.toFixed(1),
      laplacianVariance: lapVariance.toFixed(1),
      meanGray: Math.round(meanGray)
    },
    resolutionStatus: resStatus,
    blurStatus,
    contrastStatus,
    recommendations
  };
}

async function detectSkewAngle(jimpImg) {
  // Crop a low-res thumbnail to compute projection profiles extremely fast
  const thumb = jimpImg.clone().resize(200, Jimp.AUTO);
  const W = thumb.bitmap.width;
  const H = thumb.bitmap.height;
  
  const binary = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    const gray = (thumb.bitmap.data[idx] + thumb.bitmap.data[idx+1] + thumb.bitmap.data[idx+2]) / 3;
    binary[i] = gray < 180 ? 1 : 0; // 1 for dark/black, 0 for white
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
  
  // Compare with 0-degree
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
  
  // 1. Auto-upscale if low resolution
  if (W < 1000 || H < 700) {
    img.resize(W * 2, H * 2, Jimp.RESIZE_BICUBIC);
    upscaled = true;
    W = img.bitmap.width;
    H = img.bitmap.height;
  }
  
  // 2. Contrast normalization (stretch pixel levels to full scale)
  img.normalize();
  
  // 3. Custom sharpening kernel to enhance vertical/horizontal lines and numbers
  const sharpenKernel = [
    [ 0, -1,  0],
    [-1,  5, -1],
    [ 0, -1,  0]
  ];
  img.convolute(sharpenKernel);
  
  // 4. Skew correction
  const angle = await detectSkewAngle(img);
  if (angle !== 0) {
    img.rotate(-angle, false);
  }
  
  return { upscaled, skewAngle: angle };
}

function adaptiveThresholdBradley(bitmap, sRatio = 0.125, t = 0.15) {
  const W = bitmap.width;
  const H = bitmap.height;
  
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    gray[i] = Math.round((bitmap.data[idx] + bitmap.data[idx+1] + bitmap.data[idx+2]) / 3);
  }
  
  const integral = new Float64Array(W * H);
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = 0; y < H; y++) {
      sum += gray[y * W + x];
      if (x === 0) {
        integral[y * W + x] = sum;
      } else {
        integral[y * W + x] = integral[y * W + (x - 1)] + sum;
      }
    }
  }
  
  const s = Math.round(W * sRatio);
  const halfS = Math.floor(s / 2);
  const out = new Uint8Array(W * H);
  
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      
      const x1 = Math.max(0, x - halfS);
      const x2 = Math.min(W - 1, x + halfS);
      const y1 = Math.max(0, y - halfS);
      const y2 = Math.min(H - 1, y + halfS);
      
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      
      let sum = integral[y2 * W + x2];
      if (x1 > 0) sum -= integral[y2 * W + (x1 - 1)];
      if (y1 > 0) sum -= integral[(y1 - 1) * W + x2];
      if (x1 > 0 && y1 > 0) sum += integral[(y1 - 1) * W + (x1 - 1)];
      
      const avg = sum / count;
      if (gray[idx] < avg * (1.0 - t)) {
        out[idx] = 0;
      } else {
        out[idx] = 255;
      }
    }
  }
  
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    const v = out[i] === 0 ? 0 : 255;
    bitmap.data[idx] = bitmap.data[idx+1] = bitmap.data[idx+2] = v;
    bitmap.data[idx+3] = 255;
  }
}

function morphErode(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const temp = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    temp[i] = bitmap.data[i * 4] === 0 ? 1 : 0;
  }
  
  const out = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      let allBlack = true;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          if (temp[(y + ky) * W + (x + kx)] === 0) {
            allBlack = false;
            break;
          }
        }
        if (!allBlack) break;
      }
      out[idx] = allBlack ? 1 : 0;
    }
  }
  
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    const v = out[i] === 1 ? 0 : 255;
    bitmap.data[idx] = bitmap.data[idx+1] = bitmap.data[idx+2] = v;
  }
}

function morphDilate(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const temp = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    temp[i] = bitmap.data[i * 4] === 0 ? 1 : 0;
  }
  
  const out = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      let anyBlack = false;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          if (temp[(y + ky) * W + (x + kx)] === 1) {
            anyBlack = true;
            break;
          }
        }
        if (anyBlack) break;
      }
      out[idx] = anyBlack ? 1 : 0;
    }
  }
  
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    const v = out[i] === 1 ? 0 : 255;
    bitmap.data[idx] = bitmap.data[idx+1] = bitmap.data[idx+2] = v;
  }
}

function morphClosing(bitmap) {
  morphDilate(bitmap);
  morphErode(bitmap);
}

function morphOpening(bitmap) {
  morphErode(bitmap);
  morphDilate(bitmap);
}

// ─────────────────────────────────────────────────────────────────
//  EXPRESS ROUTES
// ─────────────────────────────────────────────────────────────────

app.post('/api/auto-detect', upload, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: 'No files uploaded.' });

    const img = await Jimp.read(req.files[0].buffer);
    
    // Perform upscaling, skew correction, sharpening, noise removal
    const enhancedImg = img.clone();
    const preprocessInfo = await preprocessImage(enhancedImg);
    
    // Detect vertices & ranges on preprocessed image
    const vertices = detectPlotVertices(enhancedImg.bitmap);
    const ranges = await recognizeAxesLimits(enhancedImg, vertices);

    // SIQA Quality Assessment on original image using detected vertices & ranges
    const quality = assessQuality(img.bitmap, vertices, ranges);

    // Compute threshold mask on the enhanced image
    const maskImg = enhancedImg.clone();
    adaptiveThresholdBradley(maskImg.bitmap);
    morphClosing(maskImg.bitmap);
    morphOpening(maskImg.bitmap);

    // Convert both images to base64 for preview display
    const enhancedBuf = await enhancedImg.getBufferAsync(Jimp.MIME_PNG);
    const maskBuf = await maskImg.getBufferAsync(Jimp.MIME_PNG);

    const enhancedBase64 = `data:image/png;base64,${enhancedBuf.toString('base64')}`;
    const maskBase64 = `data:image/png;base64,${maskBuf.toString('base64')}`;

    res.json({ 
      fileName: req.files[0].originalname, 
      vertices, 
      ...ranges,
      quality,
      preprocessInfo,
      enhancedImage: enhancedBase64,
      thresholdMask: maskBase64
    });
  } catch (err) {
    console.error('auto-detect error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/digitize', upload, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: 'No image uploaded.' });

    const img     = await Jimp.read(req.files[0].buffer);
    await preprocessImage(img);
    let vertices  = JSON.parse(req.body.vertices || '[]');
    const xRange  = JSON.parse(req.body.xRange   || '[300,1000]');
    const yRange  = JSON.parse(req.body.yRange   || '[0,1]');
    const configs = JSON.parse(req.body.configs  || '{}');

    if (!vertices || vertices.length < 3) {
      return res.status(422).json({
        error: "Graph extraction failed: Could not detect axis bounds. Please run calibration clicks first."
      });
    }

    const curves = traceCurves(img.bitmap, vertices, xRange, yRange, configs);
    
    // Validate that each curve contains enough points (e.g., at least 15 points)
    const validCurves = curves.filter(c => c.data.length >= 15);

    if (validCurves.length === 0) {
      return res.status(422).json({
        error: "Graph extraction was unsuccessful. Please upload a clearer image."
      });
    }

    res.json({ fileName: req.files[0].originalname, curves: validCurves });
  } catch (err) {
    console.error('digitize error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search-images', async (req, res) => {
  const query = req.query.q;
  const specType = req.query.type || 'uv-vis';
  const minRes = parseInt(req.query.minRes || '700');
  const limit = Math.min(parseInt(req.query.limit || '5'), 10);
  const apiKey = req.query.apiKey || req.headers['x-api-key'] || process.env.SERPER_API_KEY;

  if (!query) return res.status(400).json({ error: 'Query parameter q is required' });

  try {
    const rawQuery = query.toLowerCase().trim();
    let typeKeyword = 'absorbance spectrum graph';
    if (specType === 'uv-vis') typeKeyword = 'UV-Vis absorbance spectrum graph';
    else if (specType === 'ftir') typeKeyword = 'FTIR transmittance spectrum graph';
    else if (specType === 'nmr') typeKeyword = 'NMR spectrum graph';
    else if (specType === 'fluorescence') typeKeyword = 'fluorescence emission spectrum graph';
    else if (specType === 'mass') typeKeyword = 'mass spectrometry spectrum graph';

    let searchQuery = query.trim();
    if (!rawQuery.includes('spectrum')) {
      searchQuery += ` ${typeKeyword}`;
    } else if (!rawQuery.includes(specType) && specType !== 'uv-vis') {
      searchQuery += ` ${specType}`;
    }

    if (apiKey) {
      // ─────────────────────────────────────────────────────────────
      // SERPER API INTEGRATION (google.serper.dev/images)
      // ─────────────────────────────────────────────────────────────
      const serperData = JSON.stringify({
        q: searchQuery,
        num: limit
      });

      const options = {
        hostname: 'google.serper.dev',
        path: '/images',
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(serperData)
        }
      };

      const serperReq = https.request(options, (serperRes) => {
        let body = '';
        serperRes.on('data', chunk => body += chunk);
        serperRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.message) {
              return res.status(400).json({ error: `Serper API Error: ${parsed.message}` });
            }

            const rawImages = parsed.images || [];
            let images = [];

            const processImg = (img, enforceRes) => {
              const title = img.title || 'Spectrum Image';
              const lowerTitle = title.toLowerCase();
              const w = img.imageWidth || 800;
              const h = img.imageHeight || 600;

              if (enforceRes && w < minRes && minRes > 400) return null;

              const keywords = ['spectrum', 'absorbance', 'wavelength', 'uv', 'ir', 'nm', 'transmittance', 'graph', 'plot', 'ppm', 'm/z', specType];
              let score = 60;
              keywords.forEach(kw => { if (lowerTitle.includes(kw)) score += 10; });

              return {
                title: title,
                url: img.imageUrl,
                thumbnail: img.thumbnailUrl || img.imageUrl,
                width: w,
                height: h,
                specType: specType,
                source: img.domain || 'Google Images (Serper)',
                imageyeScore: Math.min(100, score)
              };
            };

            rawImages.forEach(img => {
              const item = processImg(img, true);
              if (item) images.push(item);
            });

            // Fallback if strict resolution filter returned no images
            if (images.length === 0 && rawImages.length > 0) {
              rawImages.forEach(img => {
                const item = processImg(img, false);
                if (item) images.push(item);
              });
            }

            images.sort((a, b) => b.imageyeScore - a.imageyeScore);
            if (limit > 0) images = images.slice(0, limit);

            return res.json({
              provider: 'Serper API (Google Images)',
              query: searchQuery,
              specType,
              minRes,
              count: images.length,
              images
            });
          } catch (err) {
            return res.status(500).json({ error: 'Failed to parse Serper API response: ' + err.message });
          }
        });
      });

      serperReq.on('error', (err) => {
        return res.status(500).json({ error: 'Serper API Request Failed: ' + err.message });
      });

      serperReq.write(serperData);
      serperReq.end();
    } else {
      // ─────────────────────────────────────────────────────────────
      // FALLBACK TO WIKIMEDIA SCIENTIFIC COMMONS REPOSITORY
      // (Used when SERPER_API_KEY is not configured yet)
      // ─────────────────────────────────────────────────────────────
      const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query + ' spectrum')}&gsrnamespace=6&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;

      https.get(wikiUrl, (wikiRes) => {
        let body = '';
        wikiRes.on('data', chunk => body += chunk);
        wikiRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const pages = parsed.query?.pages || {};
            let images = [];

            Object.values(pages).forEach(page => {
              const info = page.imageinfo?.[0];
              if (!info) return;

              const title = page.title.replace(/^File:/i, '');
              const url = info.url;
              const w = info.width || 800;
              const h = info.height || 600;

              if (w < minRes && minRes > 400) return;

              images.push({
                title: title,
                url: url,
                thumbnail: info.thumburl || url,
                width: w,
                height: h,
                specType: specType,
                source: 'Wikimedia Scientific Repository',
                imageyeScore: 85
              });
            });

            if (limit > 0) images = images.slice(0, limit);

            return res.json({
              provider: 'Wikimedia Scientific Repository (Serper Key optional)',
              query: searchQuery,
              specType,
              minRes,
              count: images.length,
              images
            });
          } catch (err) {
            return res.status(500).json({ error: 'Wikimedia search failed: ' + err.message });
          }
        });
      }).on('error', (err) => {
        return res.status(500).json({ error: 'Search request failed: ' + err.message });
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// CHROME EXTENSION RECEIVER ENDPOINTS
// ─────────────────────────────────────────────────────────────────
let extensionImportsQueue = [];

app.post('/api/extension-import', (req, res) => {
  const { images } = req.body;
  if (!images || !Array.isArray(images)) {
    return res.status(400).json({ error: 'Payload must include an images array' });
  }

  images.forEach(img => {
    extensionImportsQueue.push({
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      url: img.url,
      title: img.title || 'Google Images Spectrum',
      thumbnail: img.thumbnail || img.url,
      timestamp: new Date().toISOString()
    });
  });

  console.log(`[Extension] Received ${images.length} images from Chrome Extension. Total queue: ${extensionImportsQueue.length}`);
  res.json({ success: true, count: images.length, totalQueue: extensionImportsQueue.length });
});

app.get('/api/extension-import', (req, res) => {
  const images = [...extensionImportsQueue];
  if (req.query.clear === 'true') {
    extensionImportsQueue = [];
  }
  res.json({ images });
});

app.get('/api/proxy-image', (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing url parameter');

  const handleRequest = (url) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, (proxyRes) => {
      // Handle redirect
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        let redirectUrl = proxyRes.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const parsed = new URL(url);
          redirectUrl = parsed.protocol + '//' + parsed.host + redirectUrl;
        }
        return handleRequest(redirectUrl);
      }

      if (proxyRes.statusCode !== 200) {
        return res.status(proxyRes.statusCode).send('Failed to fetch image: status ' + proxyRes.statusCode);
      }

      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/png');
      proxyRes.pipe(res);
    }).on('error', (err) => {
      console.error('Proxy request error:', err);
      res.status(500).send(err.message);
    });
  };

  handleRequest(imageUrl);
});

const fetchBufferWithUserAgent = (url) => {
  return new Promise((resolve, reject) => {
    const fetchRec = (targetUrl, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      if (targetUrl.startsWith('data:image/')) {
        const base64Data = targetUrl.split(',')[1];
        return resolve(Buffer.from(base64Data, 'base64'));
      }
      const client = targetUrl.startsWith('https') ? https : http;
      const req = client.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.google.com/'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith('http')) {
            const parsed = new URL(targetUrl);
            redirectUrl = parsed.protocol + '//' + parsed.host + redirectUrl;
          }
          return fetchRec(redirectUrl, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
    };
    fetchRec(url);
  });
};

app.post('/api/download-images', async (req, res) => {
  const { images } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Payload must contain a non-empty images array.' });
  }

  const downloaded = [];
  const os = require('os');
  const uploadsDir = path.join(os.tmpdir(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  for (let idx = 0; idx < images.length; idx++) {
    const item = images[idx];
    try {
      const imgUrl = item.url;
      let imgBuffer;
      try {
        imgBuffer = await fetchBufferWithUserAgent(imgUrl);
      } catch (fetchErr) {
        const jimpDirect = await Jimp.read(imgUrl);
        imgBuffer = await jimpDirect.getBufferAsync(Jimp.MIME_PNG);
      }

      const img = await Jimp.read(imgBuffer);
      const filename = `spectrum_${Date.now()}_${idx + 1}.png`;
      const filePath = path.join(uploadsDir, filename);
      await img.writeAsync(filePath);
      const buf = await img.getBufferAsync(Jimp.MIME_PNG);
      const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;

      downloaded.push({
        id: Date.now() + '_' + idx,
        name: item.title || filename,
        url: item.url,
        localPath: filePath,
        dataUrl,
        width: img.bitmap.width,
        height: img.bitmap.height
      });
    } catch (err) {
      console.warn(`[Download] Failed to download image ${idx + 1} (${item.url}): ${err.message}`);
    }
  }

  res.json({ success: true, count: downloaded.length, images: downloaded });
});

if (!process.env.NETLIFY) {
  app.listen(PORT, () =>
    console.log(`Spectral AI System running at http://localhost:${PORT}`)
  );
}

module.exports = app;
