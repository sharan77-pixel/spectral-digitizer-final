const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Jimp = require('jimp');
const serverless = require('serverless-http');

const { preprocessImage } = require('./helpers/image-utils');
const { traceCurves } = require('./helpers/curve-trace');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage }).array('files', 100);

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

const handler = serverless(app);
module.exports.handler = async (event, context) => {
  if (event.path && event.path.startsWith('/.netlify/functions/digitize')) {
    event.path = event.path.replace('/.netlify/functions/digitize', '/api/digitize');
  }
  return await handler(event, context);
};
