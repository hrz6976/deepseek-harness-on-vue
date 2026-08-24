// Standalone production server: static files from dist/standalone only.
// Usage: node serve.mjs [port]   (default 4000)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./dist/standalone/', import.meta.url));
const portArg = process.argv.slice(2).find(arg => /^\d+$/.test(arg));
const PORT = Number(portArg || process.env.PORT || 4000);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // static files
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p || p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found (did you run: npm run build?)'); }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));

// A dev server that dies silently makes browser-side SSE stop with no error —
// brutal to debug. Log and live.
process.on('uncaughtException', e => console.error('[server] uncaught:', e));
process.on('unhandledRejection', e => console.error('[server] unhandled:', e));
