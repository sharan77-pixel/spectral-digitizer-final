const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/search-images', async (req, res) => {
  const query = req.query.q;
  const specType = req.query.type || 'uv-vis';
  const minRes = parseInt(req.query.minRes || '700');
  const limit = Math.min(parseInt(req.query.limit || '5'), 10);
  const apiKey = req.query.apiKey || req.headers['x-api-key'] || process.env.SERPER_API_KEY;

  if (!query) return res.status(400).json({ error: 'Query parameter q is required' });

  try {
    const rawQuery = query.toLowerCase().trim();
    let typeKeyword = 'absorbance spectrum graph';
    if (specType === 'uv-vis') typeKeyword = 'UV-Vis absorbance spectrum graph';
    else if (specType === 'ftir') typeKeyword = 'FTIR transmittance spectrum graph';
    else if (specType === 'nmr') typeKeyword = 'NMR spectrum graph';
    else if (specType === 'fluorescence') typeKeyword = 'fluorescence emission spectrum graph';
    else if (specType === 'mass') typeKeyword = 'mass spectrometry spectrum graph';

    let searchQuery = query.trim();
    if (!rawQuery.includes('spectrum')) {
      searchQuery += ` ${typeKeyword}`;
    } else if (!rawQuery.includes(specType) && specType !== 'uv-vis') {
      searchQuery += ` ${specType}`;
    }

    if (apiKey) {
      const serperData = JSON.stringify({
        q: searchQuery,
        num: limit
      });

      const options = {
        hostname: 'google.serper.dev',
        path: '/images',
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(serperData)
        }
      };

      const serperReq = https.request(options, (serperRes) => {
        let body = '';
        serperRes.on('data', chunk => body += chunk);
        serperRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.message) {
              return res.status(400).json({ error: `Serper API Error: ${parsed.message}` });
            }

            const rawImages = parsed.images || [];
            let images = [];

            const processImg = (img, enforceRes) => {
              const title = img.title || 'Spectrum Image';
              const lowerTitle = title.toLowerCase();
              const w = img.imageWidth || 800;
              const h = img.imageHeight || 600;

              if (enforceRes && w < minRes && minRes > 400) return null;

              const keywords = ['spectrum', 'absorbance', 'wavelength', 'uv', 'ir', 'nm', 'transmittance', 'graph', 'plot', 'ppm', 'm/z', specType];
              let score = 60;
              keywords.forEach(kw => { if (lowerTitle.includes(kw)) score += 10; });

              return {
                title: title,
                url: img.imageUrl,
                thumbnail: img.thumbnailUrl || img.imageUrl,
                width: w,
                height: h,
                specType: specType,
                source: img.domain || 'Google Images (Serper)',
                imageyeScore: Math.min(100, score)
              };
            };

            rawImages.forEach(img => {
              const item = processImg(img, true);
              if (item) images.push(item);
            });

            if (images.length === 0 && rawImages.length > 0) {
              rawImages.forEach(img => {
                const item = processImg(img, false);
                if (item) images.push(item);
              });
            }

            images.sort((a, b) => b.imageyeScore - a.imageyeScore);
            if (limit > 0) images = images.slice(0, limit);

            return res.json({
              provider: 'Serper API (Google Images)',
              query: searchQuery,
              specType,
              minRes,
              count: images.length,
              images
            });
          } catch (err) {
            return res.status(500).json({ error: 'Failed to parse Serper API response: ' + err.message });
          }
        });
      });

      serperReq.on('error', (err) => {
        return res.status(500).json({ error: 'Serper API Request Failed: ' + err.message });
      });

      serperReq.write(serperData);
      serperReq.end();
    } else {
      const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query + ' spectrum')}&gsrnamespace=6&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*`;

      https.get(wikiUrl, (wikiRes) => {
        let body = '';
        wikiRes.on('data', chunk => body += chunk);
        wikiRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const pages = parsed.query?.pages || {};
            let images = [];

            Object.values(pages).forEach(page => {
              const info = page.imageinfo?.[0];
              if (!info) return;

              const title = page.title.replace(/^File:/i, '');
              const url = info.url;
              const w = info.width || 800;
              const h = info.height || 600;

              if (w < minRes && minRes > 400) return;

              images.push({
                title: title,
                url: url,
                thumbnail: info.thumburl || url,
                width: w,
                height: h,
                specType: specType,
                source: 'Wikimedia Scientific Repository',
                imageyeScore: 85
              });
            });

            if (limit > 0) images = images.slice(0, limit);

            return res.json({
              provider: 'Wikimedia Scientific Repository (Serper Key optional)',
              query: searchQuery,
              specType,
              minRes,
              count: images.length,
              images
            });
          } catch (err) {
            return res.status(500).json({ error: 'Wikimedia search failed: ' + err.message });
          }
        });
      }).on('error', (err) => {
        return res.status(500).json({ error: 'Search request failed: ' + err.message });
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const handler = serverless(app);
module.exports.handler = async (event, context) => {
  if (event.path && event.path.startsWith('/.netlify/functions/search-images')) {
    event.path = event.path.replace('/.netlify/functions/search-images', '/api/search-images');
  }
  return await handler(event, context);
};
