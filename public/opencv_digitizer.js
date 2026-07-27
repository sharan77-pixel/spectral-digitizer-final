// ═══════════════════════════════════════════════════════════════════
//  SPECTRAL AI SYSTEM – Pure JavaScript Digitizer Engine (OpenCV-Free)
//  All image processing runs locally in pure JS.
//  No external WebAssembly compilation or script download is required!
// ═══════════════════════════════════════════════════════════════════

// Direct resolve since JS engine is active immediately
window.cvReady = true;
window.cvReadyPromise = Promise.resolve();

// Mock cv object to prevent reference errors
window.cv = {
    Mat: class {},
    Rect: class {}
};

// ─────────────────────────────────────────────────────────────────
//  HSV COLOR RANGES  (h: 0-180, s/v: 0-255)
//  Matches OpenCV's internal color thresholds.
// ─────────────────────────────────────────────────────────────────
const CV_COLOR_RANGES = {
    red: [
        { lower: [0, 20, 20],   upper: [12, 255, 255] },
        { lower: [160, 20, 20], upper: [180, 255, 255] }
    ],
    yellow: [
        { lower: [20, 30, 50],  upper: [38, 255, 255] }
    ],
    green: [
        { lower: [35, 20, 20],  upper: [85, 255, 255] }
    ],
    cyan: [
        { lower: [80, 20, 20],  upper: [102, 255, 255] }
    ],
    blue: [
        { lower: [90, 20, 20],  upper: [138, 255, 255] }
    ],
    magenta: [
        { lower: [138, 20, 20], upper: [165, 255, 255] }
    ],
    orange: [
        { lower: [8, 25, 25],  upper: [25, 255, 255] }
    ],
    black: [
        { lower: [0, 0, 0],     upper: [180, 60, 130] }
    ]
};

// ─────────────────────────────────────────────────────────────────
//  HSV & COLOR CLASSIFIER IN PURE JAVASCRIPT
// ─────────────────────────────────────────────────────────────────
function rgbToCvHsv(r, g, b) {
    let r_n = r / 255, g_n = g / 255, b_n = b / 255;
    let max = Math.max(r_n, g_n, b_n), min = Math.min(r_n, g_n, b_n);
    let d = max - min;
    let h = 0;
    let s = max === 0 ? 0 : d / max;
    let v = max;
    if (d !== 0) {
        if (max === r_n)      h = ((g_n - b_n) / d + (g_n < b_n ? 6 : 0)) / 6;
        else if (max === g_n) h = ((b_n - r_n) / d + 2) / 6;
        else                  h = ((r_n - g_n) / d + 4) / 6;
    }
    return {
        h: Math.round(h * 180),
        s: Math.round(s * 255),
        v: Math.round(v * 255)
    };
}

function isColorMatch(r, g, b, colorMode, whitenessThresh = 255) {
    if (r >= whitenessThresh && g >= whitenessThresh && b >= whitenessThresh) {
        return false;
    }
    if (colorMode === 'grayscale') {
        return !(r >= 250 && g >= 250 && b >= 250);
    }
    const { h, s, v } = rgbToCvHsv(r, g, b);
    const ranges = CV_COLOR_RANGES[colorMode];
    if (!ranges) return false;

    for (const range of ranges) {
        if (h >= range.lower[0] && h <= range.upper[0] &&
            s >= range.lower[1] && s <= range.upper[1] &&
            v >= range.lower[2] && v <= range.upper[2]) {
            return true;
        }
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────
//  IMAGE ENHANCEMENT & VERTEX DETECTION FALLBACKS (Pure JS)
// ─────────────────────────────────────────────────────────────────
async function cvEnhanceImage(srcCanvas) {
    // Client-side CLAHE is bypassed, filters can be run manually
    return srcCanvas.toDataURL();
}

async function cvDetectPlotVertices(srcCanvas) {
    // Default calibration bounds (server-side handles actual Hough Line detection)
    return [
        { x: Math.floor(srcCanvas.width * 0.12), y: Math.floor(srcCanvas.height * 0.82) },
        { x: Math.floor(srcCanvas.width * 0.93), y: Math.floor(srcCanvas.height * 0.82) },
        { x: Math.floor(srcCanvas.width * 0.12), y: Math.floor(srcCanvas.height * 0.08) }
    ];
}

async function cvReadAxisLimits(srcCanvas, vertices) {
    return { xRange: [300, 1000], yRange: [0.0, 1.0], xLabel: 'Wavelength (nm)', yLabel: 'Absorbance' };
}

// ─────────────────────────────────────────────────────────────────
//  LIVE MASK PREVIEW
// ─────────────────────────────────────────────────────────────────
async function cvRenderLiveMask(srcCanvas, maskCanvas, colorMode, whitenessThresh = 255) {
    const sctx = srcCanvas.getContext('2d');
    const mctx = maskCanvas.getContext('2d');
    const W = srcCanvas.width, H = srcCanvas.height;

    const srcImgData = sctx.getImageData(0, 0, W, H);
    const srcData = srcImgData.data;

    // Retrieve scribble masks to ignore erased spots
    const scribble = document.getElementById('scribble-canvas');
    let scribbleData = null;
    if (scribble) {
        const sctx2 = scribble.getContext('2d');
        scribbleData = sctx2.getImageData(0, 0, W, H).data;
    }

    const maskImgData = mctx.createImageData(W, H);
    const maskData = maskImgData.data;

    for (let i = 0; i < srcData.length; i += 4) {
        const r = srcData[i], g = srcData[i+1], b = srcData[i+2];
        if (scribbleData && scribbleData[i+3] > 0) {
            // Mask out scribble pixels
            maskData[i] = 0;
            maskData[i+1] = 0;
            maskData[i+2] = 0;
            maskData[i+3] = 255;
            continue;
        }

        if (isColorMatch(r, g, b, colorMode, whitenessThresh)) {
            maskData[i] = 255;
            maskData[i+1] = 255;
            maskData[i+2] = 255;
            maskData[i+3] = 255;
        } else {
            maskData[i] = 0;
            maskData[i+1] = 0;
            maskData[i+2] = 0;
            maskData[i+3] = 255;
        }
    }
    mctx.putImageData(maskImgData, 0, 0);
}

// ─────────────────────────────────────────────────────────────────
//  PITCH-TRACKING CURVE TRACER (Pure JS Connected-Lines Sweep)
// ─────────────────────────────────────────────────────────────────
async function cvTraceCurves(srcCanvas, colorMode, vertices, xRange, yRange, configs) {
    const origin = vertices[0];
    const xMaxV  = vertices[1];
    const yMaxV  = vertices[2];

    const xMinVal = xRange[0], xMaxVal = xRange[1];
    const yMinVal = yRange[0], yMaxVal = yRange[1];
    const smoothWin = configs.smoothingWindow || 5;
    const xScaleType = configs.xScaleType || 'linear';
    const yScaleType = configs.yScaleType || 'linear';

    function pixToReal(px, py) {
        const xPct = (px - origin.x) / (xMaxV.x - origin.x);
        const yPct = (origin.y - py)  / (origin.y - yMaxV.y);
        let rx, ry;
        if (xScaleType === 'log' && xMinVal > 0 && xMaxVal > 0) {
            const logMin = Math.log10(xMinVal), logMax = Math.log10(xMaxVal);
            rx = Math.pow(10, logMin + xPct * (logMax - logMin));
        } else {
            rx = xMinVal + xPct * (xMaxVal - xMinVal);
        }
        if (yScaleType === 'log' && yMinVal > 0 && yMaxVal > 0) {
            const logMin = Math.log10(yMinVal), logMax = Math.log10(yMaxVal);
            ry = Math.pow(10, logMin + yPct * (logMax - logMin));
        } else {
            ry = yMinVal + yPct * (yMaxVal - yMinVal);
        }
        return [rx, ry];
    }

    function isValidPt(rx, ry) {
        if (isNaN(rx) || isNaN(ry)) return false;
        const minX = Math.min(xMinVal, xMaxVal);
        const maxX = Math.max(xMinVal, xMaxVal);
        const minY = Math.min(yMinVal, yMaxVal);
        const maxY = Math.max(yMinVal, yMaxVal);
        
        const xMargin = (maxX - minX) * 0.02 || 2;
        const yMargin = (maxY - minY) * 0.05 || 0.05;
        
        return (rx >= minX - xMargin && rx <= maxX + xMargin &&
                ry >= minY - yMargin && ry <= maxY + yMargin);
    }

    let colorNames = colorMode === 'grayscale' 
        ? ['red','yellow','orange','blue','green','cyan','magenta','black']
        : [colorMode];

    const allCurves = [];

    const ctx = srcCanvas.getContext('2d');
    const W = srcCanvas.width, H = srcCanvas.height;
    const pixels = ctx.getImageData(0, 0, W, H).data;

    const scribble = document.getElementById('scribble-canvas');
    let scribbleData = null;
    if (scribble) {
        scribbleData = scribble.getContext('2d').getImageData(0, 0, W, H).data;
    }

    const startX = Math.max(0, Math.floor(origin.x));
    const endX = Math.min(W, Math.floor(xMaxV.x));
    const startY = Math.max(0, Math.floor(yMaxV.y));
    const endY = Math.min(H, Math.floor(origin.y));

    for (const colorName of colorNames) {
        const activeLines = [];
        const completedLines = [];

        for (let px = startX; px < endX; px++) {
            const matchYCoords = [];
            let inRun = false;
            let runStart = 0;

            for (let py = startY; py < endY; py++) {
                const idx = (py * W + px) * 4;
                const r = pixels[idx], g = pixels[idx+1], b = pixels[idx+2];
                
                if (scribbleData && scribbleData[idx+3] > 0) {
                    if (inRun) {
                        matchYCoords.push(Math.floor((runStart + py - 1) / 2));
                        inRun = false;
                    }
                    continue;
                }

                if (isColorMatch(r, g, b, colorName, configs.whitenessThresh)) {
                    if (!inRun) {
                        runStart = py;
                        inRun = true;
                    }
                } else {
                    if (inRun) {
                        matchYCoords.push(Math.floor((runStart + py - 1) / 2));
                        inRun = false;
                    }
                }
            }
            if (inRun) {
                matchYCoords.push(Math.floor((runStart + endY - 1) / 2));
            }

            const matchedYCoords = new Set();
            const matchedActiveIdxs = new Set();

            // 1. Match existing active lines to the closest coordinate
            for (let li = 0; li < activeLines.length; li++) {
                const line = activeLines[li];
                let bestY = -1;
                let minDistance = 250; // 250px proximity radius to support extremely steep curves

                for (const py of matchYCoords) {
                    if (matchedYCoords.has(py)) continue;
                    const dist = Math.abs(line.lastY - py);
                    if (dist < minDistance) {
                        minDistance = dist;
                        bestY = py;
                    }
                }

                if (bestY !== -1) {
                    line.points.push([px, bestY]);
                    line.lastY = bestY;
                    line.gap = 0;
                    matchedActiveIdxs.add(li);
                    matchedYCoords.add(bestY);
                }
            }

            // 2. Start new lines only for coordinates far from all active curves
            for (const py of matchYCoords) {
                if (matchedYCoords.has(py)) continue;

                let isDuplicate = false;
                for (const line of activeLines) {
                    if (Math.abs(line.lastY - py) < 15) {
                        isDuplicate = true;
                        break;
                    }
                }

                if (!isDuplicate) {
                    activeLines.push({
                        lastY: py,
                        points: [[px, py]],
                        gap: 0
                    });
                    // Mark as matched so gap count doesn't increment immediately
                    matchedActiveIdxs.add(activeLines.length - 1);
                }
            }

            for (let li = activeLines.length - 1; li >= 0; li--) {
                if (!matchedActiveIdxs.has(li)) {
                    activeLines[li].gap++;
                    if (activeLines[li].gap > 20) { // 20 columns gap limit (matching server)
                        const completed = activeLines.splice(li, 1)[0];
                        if (completed.points.length >= 15) {
                            completedLines.push(completed.points);
                        }
                    }
                }
            }
        }

        for (const line of activeLines) {
            if (line.points.length >= 15) {
                completedLines.push(line.points);
            }
        }

        // ── Path stitching (stitching broken curves of the same color) ──
        const paths = completedLines.map(pts => {
            let slope = 0;
            if (pts.length >= 2) {
                slope = pts[pts.length - 1][1] - pts[pts.length - 2][1];
            }
            return { points: pts, slope };
        });

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

                // Resolve slight overlap in X (up to 80px), truncate the existing path to resolve the overlap
                if (gapX <= 0 && gapX > -80) {
                    const overlapIdx = existing.points.findIndex(pt => pt[0] >= firstPt[0]);
                    if (overlapIdx !== -1) {
                        existing.points = existing.points.slice(0, overlapIdx);
                        const newLastPt = existing.points[existing.points.length - 1];
                        if (newLastPt) {
                            lastPt = newLastPt;
                            gapX = firstPt[0] - lastPt[0];
                        } else {
                            continue;
                        }
                    }
                }

                if (gapX > 0 && gapX < 125) {
                    const gapY = Math.abs(firstPt[1] - lastPt[1]);
                    if (gapY < 300) { // Support vertical gaps up to 300px on steep curves
                        const predictedY = lastPt[1] + existing.slope * gapX;
                        const diffY = Math.abs(firstPt[1] - predictedY);

                        if (diffY < 60) {
                            // Interpolate the gap with linear interpolation
                            for (let x = lastPt[0] + 1; x < firstPt[0]; x++) {
                                const pct = (x - lastPt[0]) / gapX;
                                const interpY = lastPt[1] + pct * (firstPt[1] - lastPt[1]);
                                existing.points.push([x, interpY]);
                            }
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

        let curveIndex = 1;
        const plotW = endX - startX;
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

            // Filter out top and bottom borders
            if (meanY < startY + 10 || meanY > endY - 10) {
                console.log(`[tracer] ${colorName}: skipped border segment (avgY=${meanY.toFixed(2)}, top=${startY}, bottom=${endY})`);
                continue;
            }

            const minY = Math.min(yMinVal, yMaxVal);
            const maxY = Math.max(yMinVal, yMaxVal);
            const rawX = [], rawY = [];
            for (const [px, py] of path.points) {
                const [rx, ry] = pixToReal(px, py);
                if (isValidPt(rx, ry)) {
                    rawX.push(rx);
                    rawY.push(Math.max(minY, Math.min(maxY, ry)));
                }
            }

            if (rawX.length >= 15) {
                const smoothY = smoothArray(rawY, smoothWin);
                allCurves.push({
                    color: colorName,
                    name: `${colorName}_curve_${curveIndex++}`,
                    rawPoints: path.points,
                    data: rawX.map((x, i) => [x, smoothY[i]])
                });
            }
        }
    }

    console.log(`[jsTrace] Total curves: ${allCurves.length} (${allCurves.map(c => c.name).join(', ')})`);
    return allCurves;
}

// Helper smoothArray function locally in case script.js doesn't expose it
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
