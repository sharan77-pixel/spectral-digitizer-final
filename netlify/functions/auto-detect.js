const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Jimp = require('jimp');
const serverless = require('serverless-http');

const { preprocessImage, detectPlotVertices, assessQuality } = require('./helpers/image-utils');
const { recognizeAxesLimits } = require('./helpers/ocr-utils');
const { adaptiveThresholdBradley, morphClosing, morphOpening } = require('./helpers/threshold');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage }).array('files', 100);

app.post('/api/auto-detect', upload, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: 'No files uploaded.' });

    const img = await Jimp.read(req.files[0].buffer);
    
    const enhancedImg = img.clone();
    const preprocessInfo = await preprocessImage(enhancedImg);
    
    const vertices = detectPlotVertices(enhancedImg.bitmap);
    const ranges = await recognizeAxesLimits(enhancedImg, vertices);

    const quality = assessQuality(img.bitmap, vertices, ranges);

    const maskImg = enhancedImg.clone();
    adaptiveThresholdBradley(maskImg.bitmap);
    morphClosing(maskImg.bitmap);
    morphOpening(maskImg.bitmap);

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

const handler = serverless(app, {
  binary: ['image/*', 'multipart/form-data']
});
module.exports.handler = async (event, context) => {
  if (event.path && event.path.startsWith('/.netlify/functions/auto-detect')) {
    event.path = event.path.replace('/.netlify/functions/auto-detect', '/api/auto-detect');
  }
  return await handler(event, context);
};
