// Minimal E2E smoke test for bridge.js multi-provider routing.
//
// Usage:
//   node test.e2e.js              -> offline: verify config loads and resolveModel routes every model correctly
//   node test.e2e.js --live       -> online: also spin up bridge and hit each model via /v1/chat/completions or /v1/messages
//
// Requires a working bridge.config.json at ./bridge.config.json.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const LIVE = process.argv.includes("--live");
const CONFIG_PATH = path.resolve("./bridge.config.json");
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const flag = ok ? "PASS" : "FAIL";
  const line = `[${flag}] ${name}${detail ? " — " + detail : ""}`;
  (ok ? console.log : console.error)(line);
}

// ---------- offline sanity ----------
const VALID_APIS = ["responses", "chat", "messages"];
function normalizeApi(api, provider) {
  if (Array.isArray(api)) return api;
  if (api) return [api];
  if (provider?.api) return Array.isArray(provider.api) ? provider.api : [provider.api];
  return ["chat"];
}
function apiValid(api) { return normalizeApi(api).every(a => VALID_APIS.includes(a)); }

const offlineModels = Object.entries(cfg.models);
for (const [name, m] of offlineModels) {
  const prov = cfg.providers[m.provider];
  const effectiveApi = normalizeApi(m.api, prov);
  record(`config: ${name}`, Boolean(prov) && apiValid(effectiveApi),
    prov ? `provider=${m.provider} api=${JSON.stringify(effectiveApi)}` : `provider '${m.provider}' missing`);
}
for (const rule of cfg.fallback || []) {
  const prov = cfg.providers[rule.provider];
  let reOk = true;
  try { new RegExp(rule.match); } catch { reOk = false; }
  const effectiveApi = normalizeApi(rule.api, prov);
  record(`fallback: ${rule.match}`, Boolean(prov) && reOk && apiValid(effectiveApi),
    prov ? `provider=${rule.provider} api=${JSON.stringify(effectiveApi)}` : `provider missing`);
}

const fallbackProbes = [
  { in: "anthropic/claude-3.5-haiku",   expectProvider: "openrouter",  expectApi: "messages", live: true },
  { in: "deepseek-reasoner",            expectProvider: "opencode-go", expectApi: "chat",     live: true },
  { in: "kimi-k2.6",                    expectProvider: "opencode-go", expectApi: "chat",     live: false }
];
for (const p of fallbackProbes) {
  const hit = (cfg.fallback || []).find(r => new RegExp(r.match).test(p.in));
  const hitProv = hit ? cfg.providers[hit.provider] : null;
  const hitApis = hit ? normalizeApi(hit.api, hitProv) : [];
  const ok = hit && hit.provider === p.expectProvider && hitApis.includes(p.expectApi);
  record(`fallback probe: ${p.in}`, Boolean(ok),
    hit ? `-> ${hit.provider}/${JSON.stringify(hitApis)}` : "no rule matched");
}

if (!LIVE) {
  const failed = results.filter(r => !r.ok).length;
  console.log(`\noffline: ${results.length - failed}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
}

// ---------- live probe ----------
const PORT = Number(process.env.PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn("node", ["bridge.js", "--no-traj"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", d => process.stderr.write(`[bridge] ${d}`));
child.stderr.on("data", d => process.stderr.write(`[bridge] ${d}`));

async function waitReady(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/v1/models`);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("bridge did not become ready");
}

async function probeChatCompletions(model) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "Reply with exactly: pong" }]
    })
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, detail: `HTTP ${r.status} ${text.slice(0, 160)}` };
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, detail: "non-json body" }; }
  const content = j?.choices?.[0]?.message?.content
    ?? (Array.isArray(j?.output) ? j.output.map(o => o?.content?.[0]?.text || "").join("") : "");
  return { ok: Boolean(content), detail: content ? `got "${String(content).slice(0, 40)}"` : "empty content" };
}

async function probeMessages(model) {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "Reply with exactly: pong" }]
    })
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, detail: `HTTP ${r.status} ${text.slice(0, 160)}` };
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, detail: "non-json body" }; }
  const content = Array.isArray(j?.content) ? j.content.map(c => c?.text || "").join("") : "";
  return { ok: Boolean(content), detail: content ? `got "${String(content).slice(0, 40)}"` : "empty content" };
}

try {
  await waitReady();

  for (const [name, m] of offlineModels) {
    const prov = cfg.providers[m.provider];
    const apis = normalizeApi(m.api, prov);
    // Test chat endpoint if supported, then messages if supported (both for dual-api models)
    if (apis.includes("chat") || apis.includes("responses")) {
      const res = await probeChatCompletions(name);
      record(`live chat: ${name}`, res.ok, res.detail);
    }
    if (apis.includes("messages")) {
      const res = await probeMessages(name);
      record(`live msgs: ${name}`, res.ok, res.detail);
    }
  }

  for (const p of fallbackProbes) {
    if (!p.live) continue;
    const endpoint = p.expectApi === "messages" ? "messages" : "chat";
    const res = endpoint === "messages" ? await probeMessages(p.in) : await probeChatCompletions(p.in);
    record(`live fallback ${endpoint}: ${p.in}`, res.ok, res.detail);
  }
} finally {
  child.kill("SIGTERM");
}

const failed = results.filter(r => !r.ok).length;
console.log(`\ntotal: ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
