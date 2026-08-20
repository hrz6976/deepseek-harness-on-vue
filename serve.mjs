// Dev server: static files from dist/ + LLM proxy (browsers block direct
// third-party API calls via CORS; DeepSeek's API does not send CORS headers).
// Usage: node serve.mjs [port]   (default 7100)
// Proxy: /proxy/<path> -> ${LLM_PROXY_TARGET}/<path>
//
// Local pi credentials: if ~/.pi/agent/auth.json holds an api_key credential
// (PI_AUTH_PROVIDER to force one; otherwise deepseek, then opencode-go), the
// proxy injects it as the Bearer token whenever the browser sends none or the
// "pi-local" placeholder — so no key ever touches the page. The proxy target
// defaults to match the chosen credential:
//   deepseek    -> https://api.deepseek.com          (page Base URL "/proxy")
//   opencode-go -> https://opencode.ai/zen/go/v1     (page Base URL "/proxy" too)
// Explicit LLM_PROXY_TARGET always wins. A key typed into the page always wins.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = fileURLToPath(new URL('./dist/', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 7100);

const PI_TARGETS = { deepseek: 'https://api.deepseek.com', 'opencode-go': 'https://opencode.ai/zen/go/v1' };
async function loadPiCredential() {
  try {
    const auth = JSON.parse(await readFile(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8'));
    const order = process.env.PI_AUTH_PROVIDER ? [process.env.PI_AUTH_PROVIDER] : ['deepseek', 'opencode-go'];
    for (const provider of order) {
      const c = auth[provider];
      if (c?.type === 'api_key' && c.key) return { provider, key: c.key };
    }
  } catch {} // no pi install / unreadable — fine, proxy just passes auth through
  return null;
}
const piCred = await loadPiCredential();
const TARGET = (process.env.LLM_PROXY_TARGET || (piCred && PI_TARGETS[piCred.provider]) || 'https://api.deepseek.com').replace(/\/+$/, '');
if (piCred) console.log(`[auth] using local pi credential "${piCred.provider}" (~/.pi/agent/auth.json) for requests without their own key`);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/proxy/') || url.pathname === '/proxy') {
    // Forward LLM requests: method/headers/body pass through (host rewritten),
    // response gains CORS headers and streams back with backpressure.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    const upstream = TARGET + url.pathname.replace(/^\/proxy/, '');
    const headers = { ...req.headers, host: new URL(TARGET).host };
    delete headers['origin']; delete headers['referer'];
    const sent = headers['authorization'];
    if (piCred && (!sent || sent === 'Bearer pi-local')) headers['authorization'] = 'Bearer ' + piCred.key;
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const r = await fetch(upstream, { method: req.method, headers, body, duplex: 'half' });
      console.log(`[proxy] ${req.method} ${url.pathname} -> ${upstream} -> ${r.status}`);
      const h = { ...corsHeaders() };
      for (const [k, v] of r.headers) if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) h[k] = v;
      res.writeHead(r.status, h);
      if (r.body) {
        try {
          for await (const chunk of r.body) {
            if (res.destroyed) break; // client gone (stop button / tab closed) — stop writing
            if (!res.write(chunk)) await new Promise(ok => res.once('drain', ok)); // backpressure
          }
        } catch (e) { console.log('[proxy] stream interrupted (client left or upstream died): ' + e.message); }
      }
      if (!res.destroyed) res.end();
      return;
    } catch (e) {
      // if headers already went out, writeHead again would crash the process
      if (!res.headersSent) { res.writeHead(502, corsHeaders()); res.end('proxy error: ' + e.message); }
      else if (!res.destroyed) res.end();
      return;
    }
  }

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
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}  (proxy /proxy/* -> ${TARGET}/*)`));

// A dev server that dies silently makes browser-side SSE stop with no error —
// brutal to debug. Log and live.
process.on('uncaughtException', e => console.error('[server] uncaught:', e));
process.on('unhandledRejection', e => console.error('[server] unhandled:', e));

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
