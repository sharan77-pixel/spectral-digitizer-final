const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  console.log(`Copying ${src} -> ${dest}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

// 1. Copy TensorFlow.js
copyDir(
  path.join(__dirname, 'node_modules/@tensorflow/tfjs/dist'),
  path.join(__dirname, 'public/vendor/tf')
);

// 2. Copy UpscalerJS
copyDir(
  path.join(__dirname, 'node_modules/upscaler/dist/browser/umd'),
  path.join(__dirname, 'public/vendor/upscaler')
);

// 3. Copy Default Model
copyDir(
  path.join(__dirname, 'node_modules/@upscalerjs/default-model/dist/umd'),
  path.join(__dirname, 'public/vendor/default-model')
);

// 4. Copy Tesseract.js
copyDir(
  path.join(__dirname, 'node_modules/tesseract.js/dist'),
  path.join(__dirname, 'public/vendor/tesseract')
);

// 5. Copy Tesseract.js-core
copyDir(
  path.join(__dirname, 'node_modules/tesseract.js-core'),
  path.join(__dirname, 'public/vendor/tesseract-core')
);

// 6. Copy models
copyDir(
  path.join(__dirname, 'node_modules/@upscalerjs/default-model/models'),
  path.join(__dirname, 'public/models')
);

// 7. Copy Tesseract Language data
const langDest = path.join(__dirname, 'public/vendor/tesseract-lang');
fs.mkdirSync(langDest, { recursive: true });
fs.copyFileSync(
  path.join(__dirname, 'eng.traineddata'),
  path.join(langDest, 'eng.traineddata')
);
fs.copyFileSync(
  path.join(__dirname, 'eng.traineddata.gz'),
  path.join(langDest, 'eng.traineddata.gz')
);

console.log('Build steps completed successfully.');
