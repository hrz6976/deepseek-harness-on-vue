// PoC 开发服务器：静态文件 + LLM 代理（解决浏览器直连第三方 API 的 CORS 限制）
// 用法：node serve.mjs [port]   （默认 7100）
// 代理规则：/proxy/<path> → ${LLM_PROXY_TARGET}/<path>（默认 https://opencode.ai/zen/go）
// 例：页面配 baseURL = /proxy/v1 时，/proxy/v1/chat/completions → https://opencode.ai/zen/go/v1/chat/completions
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 7100);
const TARGET = (process.env.LLM_PROXY_TARGET || 'https://opencode.ai/zen/go').replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/proxy/')) {
    // 转发 LLM 请求：方法/头/体原样透传（host 头重写），响应补 CORS 头
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    const upstream = TARGET + '/' + url.pathname.slice(7);
    const headers = { ...req.headers, host: new URL(TARGET).host };
    delete headers['origin']; delete headers['referer'];
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const r = await fetch(upstream, { method: req.method, headers, body, duplex: 'half' });
      console.log(`[proxy] ${req.method} ${url.pathname} → ${upstream} → ${r.status}`);
      const h = { ...corsHeaders() };
      for (const [k, v] of r.headers) if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) h[k] = v;
      res.writeHead(r.status, h);
      if (r.body) {
        try {
          for await (const chunk of r.body) {
            if (res.destroyed) break; // 客户端已断开（用户点停止 / 关标签），别再写
            if (!res.write(chunk)) await new Promise(ok => res.once('drain', ok)); // 背压
          }
        } catch (e) { console.log('[proxy] 流中断（客户端断开或上游异常）：' + e.message); }
      }
      if (!res.destroyed) res.end();
      return;
    } catch (e) {
      // headers 已发出就只能静默收尾——再 writeHead 会 ERR_HTTP_HEADERS_SENT 把进程搞挂
      if (!res.headersSent) { res.writeHead(502, corsHeaders()); res.end('proxy error: ' + e.message); }
      else if (!res.destroyed) res.end();
      return;
    }
  }

  // 静态文件
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p || p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}  (proxy /proxy/* → ${TARGET}/*)`));

// PoC 开发服务器宁可 log 也不能静默挂掉（挂了会让浏览器端 SSE 无声断流，极难排查）
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
