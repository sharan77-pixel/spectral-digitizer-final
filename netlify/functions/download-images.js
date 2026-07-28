const express = require('express');
const cors = require('cors');
const Jimp = require('jimp');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());

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

const handler = serverless(app);
module.exports.handler = async (event, context) => {
  if (event.path && event.path.startsWith('/.netlify/functions/download-images')) {
    event.path = event.path.replace('/.netlify/functions/download-images', '/api/download-images');
  }
  return await handler(event, context);
};
