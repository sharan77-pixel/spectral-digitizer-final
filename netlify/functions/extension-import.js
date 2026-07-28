const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());

const queueFile = path.join(os.tmpdir(), 'extension_queue.json');

function readQueue() {
  try {
    if (fs.existsSync(queueFile)) {
      return JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading queue file:', e);
  }
  return [];
}

function writeQueue(queue) {
  try {
    fs.writeFileSync(queueFile, JSON.stringify(queue), 'utf8');
  } catch (e) {
    console.error('Error writing queue file:', e);
  }
}

app.post('/api/extension-import', (req, res) => {
  const { images } = req.body;
  if (!images || !Array.isArray(images)) {
    return res.status(400).json({ error: 'Payload must include an images array' });
  }

  const queue = readQueue();
  images.forEach(img => {
    queue.push({
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      url: img.url,
      title: img.title || 'Google Images Spectrum',
      thumbnail: img.thumbnail || img.url,
      timestamp: new Date().toISOString()
    });
  });

  writeQueue(queue);
  console.log(`[Extension] Received ${images.length} images. Total queue size: ${queue.length}`);
  res.json({ success: true, count: images.length, totalQueue: queue.length });
});

app.get('/api/extension-import', (req, res) => {
  const queue = readQueue();
  if (req.query.clear === 'true') {
    writeQueue([]);
  }
  res.json({ images: queue });
});

const handler = serverless(app);
module.exports.handler = async (event, context) => {
  if (event.path && event.path.startsWith('/.netlify/functions/extension-import')) {
    event.path = event.path.replace('/.netlify/functions/extension-import', '/api/extension-import');
  }
  return await handler(event, context);
};
