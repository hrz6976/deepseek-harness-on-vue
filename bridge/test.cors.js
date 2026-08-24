import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const REQUESTED_HEADERS = "authorization,content-type,x-stainless-os,x-stainless-runtime";
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://localhost:5173",
  "http://app.localhost:4567",
  "http://127.0.0.1:4000",
  "http://127.42.0.7:65535",
  "http://[::1]:8080"
];
const BLOCKED_ORIGINS = [
  "https://example.com",
  "http://127.example.com:4000",
  "http://192.168.1.10:4000"
];

const upstream = createServer((_req, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"ok"}}]}',
    "",
    "data: [DONE]",
    ""
  ].join("\n"));
});
await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
const upstreamAddress = upstream.address();
assert(upstreamAddress && typeof upstreamAddress === "object");

const tempDir = await mkdtemp(join(tmpdir(), "bridge-cors-"));
const configPath = join(tempDir, "bridge.config.json");
await writeFile(configPath, JSON.stringify({
  providers: {
    local: {
      base_url: `http://127.0.0.1:${upstreamAddress.port}`,
      auth: "bearer",
      api_key: "test-only",
      api: ["chat"]
    }
  },
  models: {
    "cors-stream-test": { provider: "local", api: "chat" }
  },
  fallback: []
}));

const child = spawn("node", ["bridge.js", "--no-traj", "--config", configPath], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", chunk => { output += chunk; });
child.stderr.on("data", chunk => { output += chunk; });

async function waitReady(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Bridge exited early:\n${output}`);
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Bridge did not become ready:\n${output}`);
}

try {
  await waitReady();
  for (const origin of ALLOWED_ORIGINS) {
    const response = await preflight(origin);
    assert.equal(response.status, 204, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-allow-headers"), REQUESTED_HEADERS);
  }

  for (const origin of BLOCKED_ORIGINS) {
    const response = await preflight(origin);
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }

  const streamResponse = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:4000",
      authorization: "Bearer pi-local",
      "content-type": "application/json",
      "x-stainless-os": "MacOS"
    },
    body: JSON.stringify({
      model: "cors-stream-test",
      stream: true,
      messages: [{ role: "user", content: "test" }]
    })
  });
  assert.equal(streamResponse.status, 200);
  assert.equal(
    streamResponse.headers.get("access-control-allow-origin"),
    "http://127.0.0.1:4000"
  );
  assert.match(await streamResponse.text(), /data: \[DONE\]/);

  console.log("[PASS] CORS allows pi-ai headers from any loopback development origin");
  console.log("[PASS] CORS headers survive a real streaming chat response");
  console.log("[PASS] CORS rejects non-loopback origins unless explicitly configured");
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => upstream.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}

function preflight(origin) {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": REQUESTED_HEADERS
    }
  });
}
