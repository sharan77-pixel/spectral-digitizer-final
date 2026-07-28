const { getPixel, classifyColor, smoothArray, COLOR_DEFS } = require('./image-utils');

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

    // Now filter paths and convert to real-world coordinates
    const finalCurves = [];
    let curveIndex = 1;
    for (const path of stitchedPaths) {
      const pixelYs = path.points.map(pt => pt[1]);
      const meanY = pixelYs.reduce((a, b) => a + b, 0) / pixelYs.length;
      const variance = pixelYs.reduce((sum, y) => sum + Math.pow(y - meanY, 2), 0) / pixelYs.length;
      const stdDev = Math.sqrt(variance);
      
      if (stdDev < 4.0 && path.points.length < plotW * 0.40) {
        console.log(`[tracer] ${colorName}: skipped flat short segment (stdDev=${stdDev.toFixed(2)}, len=${path.points.length})`);
        continue;
      }

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
    for (const c of COLOR_DEFS) {
      if (c.name === 'black') continue;
      const curves = buildCurves(colPixels[c.name], c.name);
      results.push(...curves);
    }
    const blackCurves = buildCurves(colPixels['black'], 'black');
    results.push(...blackCurves);

  } else {
    const curves = buildCurves(colPixels[colorMode], colorMode);
    results.push(...curves);
    if (curves.length === 0) {
      const fb = buildCurves(colPixels['black'], 'black');
      results.push(...fb);
    }
  }

  const deduplicated = [];
  for (let i = 0; i < results.length; i++) {
    let isDuplicate = false;
    const c1 = results[i];
    
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      const c2 = results[j];
      if (c1.color !== c2.color) continue;
      
      if (c2.data.length > c1.data.length) {
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

module.exports = {
  traceCurves
};
