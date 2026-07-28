// ═══════════════════════════════════════════════════════════════════
//  SPECTRAL AI SYSTEM — Full Client-Side AI Engine
//  Integrates: OpenCV.js · Tesseract.js · UpscalerJS · TensorFlow.js
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
//  MODULE STATUS TRACKER
// ─────────────────────────────────────────────────────────────────
window.AIEngine = {
  opencv: { ready: false, name: 'PureJS Engine', icon: '🔬' },
  tesseract: { ready: false, name: 'Tesseract', icon: '📝' },
  upscaler: { ready: false, name: 'UpscaleAI', icon: '🔭' },
  tensorflow: { ready: false, name: 'TF.js', icon: '🧠' }
};

function updateAIStatus(module, ready, errorMsg) {
  if (!window.AIEngine[module]) return;
  window.AIEngine[module].ready = ready;
  const badge = document.getElementById('ai-badge-' + module);
  if (!badge) return;
  const { icon, name } = window.AIEngine[module];
  if (ready) {
    badge.textContent = icon + ' ' + name + ' ✓';
    badge.className = 'ai-badge ai-badge--ready';
  } else if (errorMsg) {
    badge.textContent = icon + ' ' + name + ' ✗';
    badge.className = 'ai-badge ai-badge--error';
    badge.title = errorMsg;
  }
}

// ─────────────────────────────────────────────────────────────────
//  1. OPENCV.JS — wait for the promise set by opencv_digitizer.js
// ─────────────────────────────────────────────────────────────────
(function waitForOpenCV() {
  if (window.cvReadyPromise) {
    window.cvReadyPromise
      .then(() => updateAIStatus('opencv', true))
      .catch(e => updateAIStatus('opencv', false, e.message));
  } else {
    // cvReadyPromise not defined yet — retry after a short delay
    setTimeout(waitForOpenCV, 200);
  }
})();

// ─────────────────────────────────────────────────────────────────
//  2. TENSORFLOW.JS — poll until window.tf is available
// ─────────────────────────────────────────────────────────────────
(function waitForTF(attempts) {
  if (window.tf) {
    window.tf.setBackend('cpu')
      .then(() => window.tf.ready())
      .then(() => {
        updateAIStatus('tensorflow', true);
        console.log('[TF.js] Ready. Backend:', window.tf.getBackend());
        // Now try UpscalerJS which depends on TF
        initUpscaler();
      })
      .catch(e => updateAIStatus('tensorflow', false, e.message));
  } else if (attempts > 0) {
    setTimeout(() => waitForTF(attempts - 1), 500);
  } else {
    updateAIStatus('tensorflow', false, 'TF.js not loaded');
    // Still try UpscalerJS in case it has its own tf bundled
    initUpscaler();
  }
})(30); // try for 15 seconds

// ─────────────────────────────────────────────────────────────────
//  3. UPSCALERJS — depends on TF.js
// ─────────────────────────────────────────────────────────────────
let _upscaler = null;
let _upscalerReady = false;

function initUpscaler() {
  if (!window.Upscaler) {
    updateAIStatus('upscaler', false, 'UpscalerJS UMD not loaded');
    return;
  }
  try {
    // Explicitly pass the pre-loaded default model UMD configuration
    _upscaler = new window.Upscaler({
      model: window.DefaultUpscalerJSModel
    });
    _upscalerReady = true;
    updateAIStatus('upscaler', true);
    console.log('[UpscalerJS] Ready (warmup skipped to prevent main thread blocking)');
  } catch (e) {
    updateAIStatus('upscaler', false, e.message);
    console.warn('[UpscalerJS] Init failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
//  4. TESSERACT.JS — client-side OCR
// ─────────────────────────────────────────────────────────────────
let _tesseractWorker = null;

async function getTesseractWorker() {
  if (_tesseractWorker) return _tesseractWorker;

  // Wait for Tesseract to be available
  for (let i = 0; i < 20; i++) {
    if (window.Tesseract) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!window.Tesseract) throw new Error('Tesseract.js script not available');

  try {
    // Instantiate Tesseract using local worker/core/lang resources served by Node
    _tesseractWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract-core/',
      langPath: '/vendor/tesseract-lang',
      workerBlobURL: false
    });
    await _tesseractWorker.setParameters({
      tessedit_char_whitelist: '0123456789.-eE'
    });
    updateAIStatus('tesseract', true);
    console.log('[Tesseract.js] Worker ready');
    return _tesseractWorker;
  } catch (e) {
    updateAIStatus('tesseract', false, e.message);
    console.warn('[Tesseract.js] Worker init failed:', e.message);
    throw e;
  }
}

// Pre-init Tesseract.js in the background after load (prevents page load hangs)
window.addEventListener('load', () => {
  setTimeout(async () => {
    try { await getTesseractWorker(); }
    catch (e) { console.warn('[Tesseract.js pre-init failed]', e.message); }
  }, 1500);
});

// ─────────────────────────────────────────────────────────────────
//  OCR CANVAS REGION using Tesseract.js
// ─────────────────────────────────────────────────────────────────
async function ocrCanvasRegion(canvas, x, y, w, h) {
  const worker = await getTesseractWorker();

  // Crop the region
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, w);
  crop.height = Math.max(1, h);
  crop.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);

  // Scale 4× for better OCR accuracy
  const scale = 4;
  const scaled = document.createElement('canvas');
  scaled.width = crop.width * scale;
  scaled.height = crop.height * scale;
  const sctx = scaled.getContext('2d');
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(crop, 0, 0, scaled.width, scaled.height);

  // Binarize (high contrast black/white)
  const idata = sctx.getImageData(0, 0, scaled.width, scaled.height);
  const d = idata.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    const v = grey < 180 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  sctx.putImageData(idata, 0, 0);

  const result = await worker.recognize(scaled);
  return result.data;
}

// ─────────────────────────────────────────────────────────────────
//  LINEAR TICK CONSENSUS FILTER (same algorithm as server.js)
// ─────────────────────────────────────────────────────────────────
function filterLinearTicksClient(ticks, coordKey) {
  if (ticks.length <= 2) return ticks;
  let bestSubset = [];
  for (let i = 0; i < ticks.length; i++) {
    for (let j = 0; j < ticks.length; j++) {
      if (i === j) continue;
      const t1 = ticks[i], t2 = ticks[j];
      if (Math.abs(t1.val - t2.val) < 1e-4) continue;
      const scale = (t2[coordKey] - t1[coordKey]) / (t2.val - t1.val);
      if (coordKey === 'x' && scale <= 0) continue;
      if (coordKey === 'y' && scale >= 0) continue;
      const subset = [t1, t2];
      for (const tk of ticks) {
        if (tk === t1 || tk === t2) continue;
        const pred = t1[coordKey] + scale * (tk.val - t1.val);
        if (Math.abs(tk[coordKey] - pred) < 20) subset.push(tk);
      }
      if (subset.length > bestSubset.length) bestSubset = subset;
    }
  }
  return bestSubset.length >= 2 ? bestSubset : ticks;
}

// ─────────────────────────────────────────────────────────────────
//  cvReadAxisLimits — Tesseract.js OCR for axis tick labels
// ─────────────────────────────────────────────────────────────────
const unicodeSuperscriptsClient = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-'
};

const superMapClient = { '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 };

function parseScientificOrLogLabelClient(text, isLogHypothesis) {
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
        const exp = superMapClient[match[2]];
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
      const innerVal = parseScientificOrLogLabelClient(logMatch[1], true);
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

  let cleanMapped = text.split('').map(c => unicodeSuperscriptsClient[c] || c).join('').replace(/\s+/g, '');
  const parsed = parseFloat(cleanMapped);
  return isNaN(parsed) ? NaN : parsed;
}

function snapToPowerOf10Client(val) {
  if (val <= 0) return val;
  const logVal = Math.log10(val);
  const roundedLog = Math.round(logVal);
  if (Math.abs(logVal - roundedLog) < 0.15) {
    return Number(Math.pow(10, roundedLog).toFixed(6));
  }
  return Number(val.toFixed(6));
}

function linearRegressionClient(xArr, yArr) {
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

function detectXTickMarksClient(imgData, origin, xMaxV, isDarkBg, avgBg) {
  const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const yOrigin = origin.y;
  const xOrigin = origin.x;
  const xEnd = xMaxV.x;

  const tickCounts = new Int32Array(xEnd - xOrigin + 1);
  for (let x = xOrigin; x <= xEnd; x++) {
    let count = 0;
    for (let dy = 1; dy <= 8; dy++) {
      if (yOrigin + dy >= imgData.height) continue;
      const idx = ((yOrigin + dy) * imgData.width + x) * 4;
      const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) count++;
    }
    for (let dy = 1; dy <= 8; dy++) {
      if (yOrigin - dy < 0) continue;
      const idx = ((yOrigin - dy) * imgData.width + x) * 4;
      const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
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

function detectYTickMarksClient(imgData, origin, yMaxV, isDarkBg, avgBg) {
  const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const xOrigin = origin.x;
  const yOrigin = origin.y;
  const yEnd = yMaxV.y;

  const tickCounts = new Int32Array(yOrigin - yEnd + 1);
  for (let y = yEnd; y <= yOrigin; y++) {
    let count = 0;
    for (let dx = 1; dx <= 8; dx++) {
      if (xOrigin - dx < 0) continue;
      const idx = (y * imgData.width + (xOrigin - dx)) * 4;
      const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
      const lum = getLuminance(r, g, b);
      const isAxis = isDarkBg ? (lum > avgBg + 25) : (lum < avgBg - 25);
      if (isAxis) count++;
    }
    for (let dx = 1; dx <= 8; dx++) {
      if (xOrigin + dx >= imgData.width) continue;
      const idx = (y * imgData.width + (xOrigin + dx)) * 4;
      const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
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

function snapLabelsToTicksClient(labels, detectedTicks, maxDist = 20) {
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

function filterTicksLogClient(ticks, coordKey) {
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
        const pred = t1[coordKey] + scale * (logValK - logVal1);
        if (Math.abs(tk[coordKey] - pred) < 25) {
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

async function cvReadAxisLimits(srcCanvas, vertices) {
  const [origin, xMaxV, yMaxV] = vertices;
  const W = srcCanvas.width, H = srcCanvas.height;
  let xRange = [null, null];
  let yRange = [null, null];
  let xScaleType = 'linear';
  let yScaleType = 'linear';

  try {
    const ctx = srcCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, W, H);

    // Detect background info
    const getLuminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

    // Sample corner pixels
    const cornerCoords = [
      { x: Math.floor(W * 0.2), y: Math.floor(H * 0.2) },
      { x: Math.floor(W * 0.8), y: Math.floor(H * 0.2) },
      { x: Math.floor(W * 0.2), y: Math.floor(H * 0.8) },
      { x: Math.floor(W * 0.8), y: Math.floor(H * 0.8) }
    ];
    let sumBg = 0;
    for (const pt of cornerCoords) {
      const idx = (pt.y * W + pt.x) * 4;
      sumBg += getLuminance(imgData.data[idx], imgData.data[idx + 1], imgData.data[idx + 2]);
    }
    const avgBg = sumBg / 4;
    const isDarkBg = avgBg < 120;

    const xTickMarks = detectXTickMarksClient(imgData, origin, xMaxV, isDarkBg, avgBg);
    const yTickMarks = detectYTickMarksClient(imgData, origin, yMaxV, isDarkBg, avgBg);

    // ── X-axis strip (below the x-axis line) ──────────────────
    const xSX = Math.max(0, origin.x - 30);
    const xSY = Math.max(0, origin.y - 5);
    const xSW = Math.min(W - xSX, xMaxV.x - origin.x + 60);
    const xSH = Math.min(H - xSY, 65);
    const xData = await ocrCanvasRegion(srcCanvas, xSX, xSY, xSW, xSH);

    const xTicksRaw = [];
    let txtX = "";
    if (xData && xData.words) {
      txtX = xData.text || "";
      for (const word of xData.words) {
        const midX = xSX + (word.bbox.x0 + word.bbox.x1) / (2 * 4);
        xTicksRaw.push({ text: word.text, coord: midX });
      }
    }
    console.log('[Tesseract Client Raw X]', xTicksRaw);

    const isPowerOf10X = xTicksRaw.some(t => /10\s*-\s*\d/.test(t.text) || /10\s*[\^⁻]/.test(t.text)) ||
      (xTicksRaw.length >= 2 && xTicksRaw.filter(t => /^10[-+^⁰¹²³⁴⁵⁶⁷⁸⁹\d]./.test(t.text.replace(/\s+/g, ''))).length >= xTicksRaw.length * 0.5);

    const xTicksLinear = [];
    const xTicksLog = [];
    for (const t of xTicksRaw) {
      const valLinear = parseScientificOrLogLabelClient(t.text, false);
      const valLog = parseScientificOrLogLabelClient(t.text, true);
      if (!isNaN(valLinear)) xTicksLinear.push({ val: valLinear, coord: t.coord, text: t.text });
      if (!isNaN(valLog) && valLog > 0) xTicksLog.push({ val: valLog, coord: t.coord, text: t.text });
    }

    const snappedLinearX = snapLabelsToTicksClient(xTicksLinear, xTickMarks).map(t => ({ val: t.val, x: t.coord }));
    const snappedLogX = snapLabelsToTicksClient(xTicksLog, xTickMarks).map(t => ({ val: t.val, x: t.coord }));

    const filteredLinearX = filterLinearTicksClient(snappedLinearX, 'x');
    const filteredLogX = filterTicksLogClient(snappedLogX, 'x');

    let finalXTicks = filteredLinearX;
    const regLinearX = linearRegressionClient(filteredLinearX.map(t => t.x), filteredLinearX.map(t => t.val));
    const regLogX = linearRegressionClient(filteredLogX.map(t => t.x), filteredLogX.map(t => Math.log10(t.val)));

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
          xRange[0] = snapToPowerOf10Client(Math.pow(10, logV0));
          xRange[1] = snapToPowerOf10Client(Math.pow(10, logV1));
        } else {
          xRange = [300, 1000];
        }
      } else {
        if (Math.abs(lastTick.val - firstTick.val) > 1e-4) {
          const scale_x = (lastTick.x - firstTick.x) / (lastTick.val - firstTick.val);
          const v0 = firstTick.val - (firstTick.x - origin.x) / scale_x;
          const v1 = firstTick.val + (xMaxV.x - firstTick.x) / scale_x;
          xRange[0] = Math.abs(v0) > 10 ? Math.round(v0) : parseFloat(v0.toFixed(4));
          xRange[1] = Math.abs(v1) > 10 ? Math.round(v1) : parseFloat(v1.toFixed(4));
        } else {
          xRange = [300, 1000];
        }
      }
    } else if (finalXTicks.length === 1) {
      if (xScaleType === 'log') {
        xRange = [snapToPowerOf10Client(finalXTicks[0].val / 10), snapToPowerOf10Client(finalXTicks[0].val * 10)];
      } else {
        xRange = [finalXTicks[0].val - 100, finalXTicks[0].val + 100];
      }
    }

    // ── Y-axis strip (left of the y-axis line) ─────────────────
    const ySX = 0;
    const ySW = Math.max(10, origin.x - 5);
    const ySY = Math.max(0, yMaxV.y - 20);
    const ySH = Math.min(H - ySY, origin.y - yMaxV.y + 40);
    const yData = await ocrCanvasRegion(srcCanvas, ySX, ySY, ySW, ySH);

    const yTicksRaw = [];
    let txtY = "";
    if (yData && yData.words) {
      txtY = yData.text || "";
      for (const word of yData.words) {
        const midY = ySY + (word.bbox.y0 + word.bbox.y1) / (2 * 4);
        yTicksRaw.push({ text: word.text, coord: midY });
      }
    }
    console.log('[Tesseract Client Raw Y]', yTicksRaw);

    const isPowerOf10Y = yTicksRaw.some(t => /10\s*-\s*\d/.test(t.text) || /10\s*[\^⁻]/.test(t.text)) ||
      (yTicksRaw.length >= 2 && yTicksRaw.filter(t => /^10[-+^⁰¹²³⁴⁵⁶⁷⁸⁹\d]./.test(t.text.replace(/\s+/g, ''))).length >= yTicksRaw.length * 0.5);

    const yTicksLinear = [];
    const yTicksLog = [];
    for (const t of yTicksRaw) {
      const valLinear = parseScientificOrLogLabelClient(t.text, false);
      const valLog = parseScientificOrLogLabelClient(t.text, true);
      if (!isNaN(valLinear)) yTicksLinear.push({ val: valLinear, coord: t.coord, text: t.text });
      if (!isNaN(valLog) && valLog > 0) yTicksLog.push({ val: valLog, coord: t.coord, text: t.text });
    }

    const snappedLinearY = snapLabelsToTicksClient(yTicksLinear, yTickMarks).map(t => ({ val: t.val, y: t.coord }));
    const snappedLogY = snapLabelsToTicksClient(yTicksLog, yTickMarks).map(t => ({ val: t.val, y: t.coord }));

    const filteredLinearY = filterLinearTicksClient(snappedLinearY, 'y');
    const filteredLogY = filterTicksLogClient(snappedLogY, 'y');

    let finalYTicks = filteredLinearY;
    const regLinearY = linearRegressionClient(filteredLinearY.map(t => t.y), filteredLinearY.map(t => t.val));
    const regLogY = linearRegressionClient(filteredLogY.map(t => t.y), filteredLogY.map(t => Math.log10(t.val)));

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
          yRange[0] = snapToPowerOf10Client(Math.pow(10, logV0));
          yRange[1] = snapToPowerOf10Client(Math.pow(10, logV1));
        } else {
          yRange = [0.1, 10];
        }
      } else {
        if (Math.abs(topTick.val - bottomTick.val) > 1e-4) {
          const scale_y = (bottomTick.y - topTick.y) / (topTick.val - bottomTick.val);
          const v0 = bottomTick.val - (origin.y - bottomTick.y) / scale_y;
          const v1 = topTick.val + (topTick.y - yMaxV.y) / scale_y;
          yRange[0] = Math.abs(v0) > 10 ? Math.round(v0) : parseFloat(v0.toFixed(4));
          yRange[1] = Math.abs(v1) > 10 ? Math.round(v1) : parseFloat(v1.toFixed(4));
        } else {
          yRange = [0.0, 1.0];
        }
      }
    } else if (finalYTicks.length === 1) {
      if (yScaleType === 'log') {
        yRange = [snapToPowerOf10Client(finalYTicks[0].val / 10), snapToPowerOf10Client(finalYTicks[0].val * 10)];
      } else {
        yRange = [finalYTicks[0].val - 0.5, finalYTicks[0].val + 0.5];
      }
    }
  } catch (err) {
    console.warn('[Tesseract OCR error]', err.message);
  }

  if (xRange[0] === null || isNaN(xRange[0])) xRange[0] = 300;
  if (xRange[1] === null || isNaN(xRange[1]) || xRange[1] <= xRange[0]) xRange[1] = 1000;
  if (yRange[0] === null || isNaN(yRange[0])) yRange[0] = 0.0;
  if (yRange[1] === null || isNaN(yRange[1]) || yRange[1] <= yRange[0]) yRange[1] = 1.0;

  console.log('[Tesseract OCR Result] xRange=', xRange, 'yRange=', yRange, 'xScaleType=', xScaleType, 'yScaleType=', yScaleType);
  return { xRange, yRange, xScaleType, yScaleType, xLabel: 'Wavelength (nm)', yLabel: 'Absorbance' };
}

// ─────────────────────────────────────────────────────────────────
//  AI UPSCALE — UpscalerJS or OpenCV bicubic fallback
// ─────────────────────────────────────────────────────────────────
async function aiUpscaleCanvas(srcCanvas) {
  const W = srcCanvas.width, H = srcCanvas.height;
  if (W >= 1000 && H >= 700) return null; // already high-res

  // Try UpscalerJS
  if (_upscalerReady && _upscaler) {
    try {
      console.log('[UpscalerJS] Upscaling', W, 'x', H);
      const result = await _upscaler.upscale(srcCanvas);
      console.log('[UpscalerJS] Done');
      return result; // base64 data URL
    } catch (e) {
      console.warn('[UpscalerJS] upscale() failed:', e.message);
    }
  }

  // Fallback: OpenCV bicubic 2× resize
  if (window.cv && window.cv.Mat) {
    const cv = window.cv;
    const ctx = srcCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, W, H);
    const src = cv.matFromImageData(imgData);
    const dst = new cv.Mat();
    cv.resize(src, dst, new cv.Size(W * 2, H * 2), 0, 0, cv.INTER_CUBIC);
    const out = document.createElement('canvas');
    out.width = W * 2; out.height = H * 2;
    cv.imshow(out, dst);
    src.delete(); dst.delete();
    console.log('[OpenCV] Bicubic upscale', W, 'x', H, '->', out.width, 'x', out.height);
    return out.toDataURL('image/png');
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
//  UTILITY — data URL → canvas
// ─────────────────────────────────────────────────────────────────
function dataUrlToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ─────────────────────────────────────────────────────────────────
//  FULL CALIBRATION PIPELINE
//  1. Upscale (UpscalerJS → OpenCV bicubic)
//  2. CLAHE contrast enhancement (OpenCV)
//  3. Hough Line axis detection (OpenCV)
//  4. OCR tick labels (Tesseract.js)
// ─────────────────────────────────────────────────────────────────
async function fullClientCalibration(srcCanvas) {
  let workCanvas = srcCanvas;
  let enhancedDataUrl = null;
  const log = [];

  // Step 1: Upscale if low-res
  try {
    const upUrl = await aiUpscaleCanvas(srcCanvas);
    if (upUrl) {
      enhancedDataUrl = upUrl;
      workCanvas = await dataUrlToCanvas(upUrl);
      log.push('Upscaled: ' + srcCanvas.width + 'x' + srcCanvas.height + ' → ' + workCanvas.width + 'x' + workCanvas.height);
    }
  } catch (e) {
    log.push('Upscale skipped: ' + e.message);
  }

  // Step 2: CLAHE enhancement (OpenCV)
  try {
    await window.cvReadyPromise;
    const claheUrl = await cvEnhanceImage(workCanvas);
    enhancedDataUrl = claheUrl;
    workCanvas = await dataUrlToCanvas(claheUrl);
    log.push('CLAHE enhancement applied');
  } catch (e) {
    log.push('CLAHE skipped: ' + e.message);
  }

  // Step 3: Hough Line axis detection (OpenCV)
  let vertices = null;
  try {
    vertices = await cvDetectPlotVertices(workCanvas);
    log.push('Axes detected: origin=(' + vertices[0].x + ',' + vertices[0].y + '), xEnd=' + vertices[1].x + ', yEnd=' + vertices[2].y);
  } catch (e) {
    log.push('Axis detection failed: ' + e.message);
    vertices = [
      { x: Math.floor(workCanvas.width * 0.12), y: Math.floor(workCanvas.height * 0.82) },
      { x: Math.floor(workCanvas.width * 0.93), y: Math.floor(workCanvas.height * 0.82) },
      { x: Math.floor(workCanvas.width * 0.12), y: Math.floor(workCanvas.height * 0.08) }
    ];
  }

  // Step 4: Tesseract.js OCR
  let axisLimits = { xRange: [300, 1000], yRange: [0, 1], xLabel: 'Wavelength (nm)', yLabel: 'Absorbance' };
  try {
    axisLimits = await cvReadAxisLimits(workCanvas, vertices);
    log.push('OCR: X=' + JSON.stringify(axisLimits.xRange) + ', Y=' + JSON.stringify(axisLimits.yRange));
  } catch (e) {
    log.push('OCR failed: ' + e.message);
  }

  return { vertices, enhancedDataUrl, workCanvas, ...axisLimits, log };
}
