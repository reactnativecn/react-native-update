#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { LOCAL_UPDATE_PORT } = require('../e2e/localUpdateConfig');

const artifactsRoot = path.resolve(__dirname, '../.e2e-artifacts');
const port = Number(process.env.E2E_ASSET_PORT || LOCAL_UPDATE_PORT);

const contentTypes = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ppk': 'application/octet-stream',
  '.patch': 'application/octet-stream',
  '.apk': 'application/vnd.android.package-archive',
};

function safeResolve(urlPath) {
  const pathname = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const target = path.resolve(artifactsRoot, `.${normalized}`);
  if (!target.startsWith(artifactsRoot)) {
    return null;
  }
  return target;
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  const filePath = safeResolve(req.url);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = contentTypes[ext] || 'application/octet-stream';
  const fileSize = fs.statSync(filePath).size;
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(fileSize),
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, '0.0.0.0', () => {
  // Keep this message for local debugging.
  console.log(`local artifacts server listening on ${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
