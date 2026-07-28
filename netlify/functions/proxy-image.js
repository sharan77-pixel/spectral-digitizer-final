const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const serverless = require('serverless-http');

const app = express();
app.use(cors());

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
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        let redirectUrl = proxyRes.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const parsed = new URL(url);
          redirectUrl = parsed.protocol + '//' + parsed.host + redirectUrl;
        }
        return handleRequest(redirectUrl);
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

const handler = serverless(app);
module.exports.handler = async (event, context) => {
  if (event.path && event.path.startsWith('/.netlify/functions/proxy-image')) {
    event.path = event.path.replace('/.netlify/functions/proxy-image', '/api/proxy-image');
  }
  return await handler(event, context);
};
