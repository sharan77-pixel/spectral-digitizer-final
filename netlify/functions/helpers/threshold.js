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

module.exports = {
  adaptiveThresholdBradley,
  morphErode,
  morphDilate,
  morphClosing,
  morphOpening
};
