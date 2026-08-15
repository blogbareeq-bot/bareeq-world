import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const SITE_ROOT = path.resolve(ROOT, '.voice-lab', 'site');
const HOST = '127.0.0.1';
const PORT = Number(process.env.BAREEQ_VOICE_LAB_PORT || '4174');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

try { await access(path.join(SITE_ROOT, 'index.html')); }
catch { throw new Error('Voice Lab site is missing. Run npm run voice:lab:build first.'); }

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(SITE_ROOT, relative);
  if (target !== SITE_ROOT && !target.startsWith(`${SITE_ROOT}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) { response.writeHead(404).end('Not found'); return; }
  const extension = path.extname(target).toLowerCase();
  response.setHeader('Content-Type', mime[extension] || 'application/octet-stream');
  const range = extension === '.mp3' ? request.headers.range?.match(/^bytes=(\d*)-(\d*)$/) : null;
  if (extension === '.mp3') response.setHeader('Accept-Ranges', 'bytes');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= info.size) {
      response.setHeader('Content-Range', `bytes */${info.size}`);
      response.writeHead(416).end();
      return;
    }
    response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    response.setHeader('Content-Length', end - start + 1);
    response.writeHead(206);
    if (request.method === 'HEAD') response.end();
    else createReadStream(target, { start, end }).pipe(response);
    return;
  }
  response.setHeader('Content-Length', info.size);
  response.writeHead(200);
  if (request.method === 'HEAD') response.end();
  else createReadStream(target).pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`Bareeq Voice Lab: http://${HOST}:${PORT}/`);
  console.log('Only .voice-lab/site is served; answer-key.json remains outside the web root.');
});
