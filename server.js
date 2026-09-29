const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.geojson': 'application/geo+json'
};

// Helper for proxying HTTP/HTTPS requests
function proxyRequest(targetUrl, req, res, extraHeaders = {}) {
  const parsedUrl = url.parse(targetUrl);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.path,
    method: req.method,
    headers: {
      'User-Agent': 'AlcorquesGijonDetector/1.0 (https://github.com/alcorques)',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'es,en;q=0.9',
      ...extraHeaders
    }
  };

  const proxyReq = client.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*'
    });
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`Proxy Error [${targetUrl}]:`, err.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Proxy request failed', details: err.message }));
  });

  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    req.pipe(proxyReq, { end: true });
  } else {
    proxyReq.end();
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers for all requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. IGN PNOA WMS Proxy
  if (pathname.startsWith('/api/proxy/pnoa-wms')) {
    const layer = parsedUrl.query.layer || 'OI.OrthoimageCoverage';
    const style = parsedUrl.query.style || '';
    const bbox = parsedUrl.query.bbox || '';
    const width = parsedUrl.query.width || '512';
    const height = parsedUrl.query.height || '512';
    const format = parsedUrl.query.format || 'image/jpeg';
    const crs = parsedUrl.query.crs || 'EPSG:3857';

    // IGN PNOA WMS Inspire (PNOA Máxima Actualidad)
    const baseUrl = 'https://www.ign.es/wms-inspire/pnoa-ma';

    const targetUrl = `${baseUrl}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
      `&LAYERS=${encodeURIComponent(layer)}` +
      `&STYLES=${encodeURIComponent(style)}` +
      `&CRS=${encodeURIComponent(crs)}` +
      `&BBOX=${bbox}` +
      `&WIDTH=${width}&HEIGHT=${height}` +
      `&FORMAT=${encodeURIComponent(format)}`;

    return proxyRequest(targetUrl, req, res);
  }

const overpassCache = new Map();

  // 2. Overpass API Proxy for OSM streets/sidewalks (Multi-Mirror Failover & Cache)
  if (pathname.startsWith('/api/proxy/overpass')) {
    const query = parsedUrl.query.data;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing data query parameter' }));
    }

    if (overpassCache.has(query)) {
      console.log('⚡ Overpass: Sirviendo de la caché local');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(overpassCache.get(query));
    }

    const mirrors = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass.nchc.org.tw/api/interpreter'
    ];

    let mirrorIndex = 0;

    function tryNextMirror() {
      if (res.headersSent) return;

      if (mirrorIndex >= mirrors.length) {
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Todos los servidores Overpass han superado el tiempo de espera' }));
        }
        return;
      }

      const targetUrl = `${mirrors[mirrorIndex++]}?data=${encodeURIComponent(query)}`;
      const targetParsed = url.parse(targetUrl);

      const reqOptions = {
        hostname: targetParsed.hostname,
        port: 443,
        path: targetParsed.path,
        method: 'GET',
        headers: {
          'User-Agent': 'AlcorquesGijonDetector/1.0 (https://github.com/alcorques)',
          'Accept': 'application/json, text/plain, */*'
        }
      };

      let timer = null;

      const proxyReq = https.request(reqOptions, (proxyRes) => {
        if (timer) clearTimeout(timer);
        if (res.headersSent) return;

        if (proxyRes.statusCode !== 200) {
          console.warn(`Servidor Overpass [${targetParsed.hostname}] devolvió HTTP ${proxyRes.statusCode}`);
          return tryNextMirror();
        }

        let bodyChunks = [];
        proxyRes.on('data', (chunk) => {
          bodyChunks.push(chunk);
        });

        proxyRes.on('end', () => {
          const bodyBuffer = Buffer.concat(bodyChunks);
          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(bodyBuffer);
            // Guardar en caché si la respuesta es válida
            if (bodyBuffer.length > 50) {
              overpassCache.set(query, bodyBuffer);
            }
          }
        });
      });

      proxyReq.on('error', (err) => {
        if (timer) clearTimeout(timer);
        if (!res.headersSent) {
          console.warn(`Error en réplica Overpass [${targetParsed.hostname}]: ${err.message}`);
          tryNextMirror();
        }
      });

      timer = setTimeout(() => {
        proxyReq.destroy();
        if (!res.headersSent) tryNextMirror();
      }, 12000);

      proxyReq.end();
    }

    tryNextMirror();
    return;
  }

  // 3. Geocoding Proxy (Nominatim / IGN)
  if (pathname.startsWith('/api/proxy/geocode')) {
    const q = parsedUrl.query.q;
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Query q required' }));
    }
    const targetUrl = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=es&limit=5&q=${encodeURIComponent(q)}`;
    return proxyRequest(targetUrl, req, res);
  }

  // 4. Health Check
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', app: 'Alcorques PNOA Gijón Detector', version: '1.0.0' }));
  }

  // 5. Serve Static Files
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath).toLowerCase();

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 File Not Found');
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🌲 Detector de Alcorques Gijón (PNOA-IRC + OSM) `);
  console.log(`🚀 Servidor listo en: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
