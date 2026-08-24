import dotenv from "dotenv";
import Fastify from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Agent, setGlobalDispatcher } from "undici";

dotenv.config();

setGlobalDispatcher(new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { timeout: 120_000 },
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 120_000
}));

const VERBOSITY = process.argv.filter(arg => /^-v+$/.test(arg)).reduce((max, arg) => Math.max(max, arg.length - 1), 0);
const LOG_LEVEL = VERBOSITY >= 2 ? "debug" : VERBOSITY >= 1 ? "info" : "warn";

function argValue(name, fallback) {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const TIMEOUT_MS = Number(argValue("--timeout", process.env.BRIDGE_TIMEOUT || "120")) * 1000;

const TRAJ_DISABLED = process.argv.includes("--no-traj");
const TRAJ_DIR = (() => {
  if (TRAJ_DISABLED) return null;
  return argValue("--traj-dir", process.env.BRIDGE_TRAJ_DIR || "") || null;
})();
const TRAJ_DIR_ABS = TRAJ_DIR ? path.resolve(TRAJ_DIR) : null;

const logStream = {
  write(chunk) {
    try {
      const obj = JSON.parse(chunk);
      const lvl = ({ 10: "TRAC", 20: "DBEG", 30: "INFO", 40: "WARN", 50: "ERRO", 60: "FATL" })[obj.level] || "???";
      // Skip Fastify's built-in request/response logs
      if (obj.req || obj.res) return;
      const msg = obj.msg || "";
      const extras = [];
      for (const [k, v] of Object.entries(obj)) {
        if (["level", "time", "pid", "hostname", "msg", "req", "res", "responseTime", "reqId"].includes(k)) continue;
        if (v !== undefined && v !== null) {
          extras.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
        }
      }
      const extraStr = extras.length ? " " + extras.join(" ") : "";
      process.stdout.write(`[${lvl}] ${msg}${extraStr}\n`);
    } catch {
      process.stdout.write(String(chunk));
    }
  }
};

const app = Fastify({
  logger: { level: LOG_LEVEL, stream: logStream },
  disableRequestLogging: true,
  bodyLimit: 20 * 1024 * 1024
});

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const CORS_ORIGINS = new Set(
  String(process.env.BRIDGE_CORS_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean)
);
const MODELHUB_BASE =
  process.env.MODELHUB_BASE || "https://aidp.bytedance.net/api/modelhub/online";
const MODELHUB_AK = process.env.MODELHUB_AK;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

const BRIDGE_CONFIG_PATH = (() => {
  const cli = argValue("--config", process.env.BRIDGE_CONFIG);
  return cli || path.resolve(process.cwd(), "bridge.config.json");
})();

/** Recursively replace $VAR / ${VAR} references in string values with process.env */
function resolveEnvVars(obj) {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, plain) => {
      const name = braced || plain;
      const val = process.env[name];
      if (val === undefined) console.warn(`[WARN] env var ${name} is not set`);
      return val || "";
    });
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) obj[k] = resolveEnvVars(obj[k]);
    return obj;
  }
  return obj;
}

function loadBridgeConfig() {
  let raw;
  try {
    raw = fs.readFileSync(BRIDGE_CONFIG_PATH, "utf8");
  } catch {
    console.warn(`[bridge] bridge.config.json not found at ${BRIDGE_CONFIG_PATH}, falling back to env-only MODELHUB mode`);
    if (!MODELHUB_AK) throw new Error("Missing bridge.config.json and MODELHUB_AK");
    return {
      providers: {
        default: {
          base_url: MODELHUB_BASE,
          auth: "query_ak",
          api_key: MODELHUB_AK,
          session_header: "extra"
        }
      },
      models: {},
      fallback: [{ match: ".*", provider: "default", api: "responses" }]
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid bridge.config.json: ${e.message}`);
  }
  parsed.providers = parsed.providers || {};
  parsed.models = parsed.models || {};
  parsed.fallback = parsed.fallback || [];
  resolveEnvVars(parsed);
  return parsed;
}

const CFG = loadBridgeConfig();

function isAllowedBrowserOrigin(origin) {
  if (CORS_ORIGINS.has(origin)) return true;

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    const isIpv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(hostname)
      && hostname.split(".").every(part => Number(part) <= 255);
    return hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "[::1]"
      || hostname === "::1"
      || isIpv4Loopback;
  } catch {
    return false;
  }
}

function setCorsHeader(reply, name, value) {
  reply.header(name, value);
  // Streaming routes write and flush reply.raw directly, bypassing Fastify's
  // normal reply serialization. Mirror CORS headers to the raw response so
  // both buffered and SSE responses carry the same policy.
  reply.raw.setHeader(name, value);
}

app.addHook("onRequest", (req, reply, done) => {
  const origin = req.headers.origin;
  if (!origin) return done();

  if (!isAllowedBrowserOrigin(origin)) {
    if (req.method === "OPTIONS") {
      reply.code(403).send({ error: { type: "cors_error", message: `Origin ${origin} is not allowed` } });
      return;
    }
    return done();
  }

  setCorsHeader(reply, "access-control-allow-origin", origin);
  setCorsHeader(reply, "vary", "Origin");
  setCorsHeader(reply, "access-control-allow-methods", "GET, POST, OPTIONS");
  const requestedHeaders = req.headers["access-control-request-headers"];
  setCorsHeader(
    reply,
    "access-control-allow-headers",
    requestedHeaders || "authorization, content-type, x-api-key, anthropic-version, x-goog-api-key"
  );
  setCorsHeader(reply, "access-control-max-age", "86400");

  if (req.method === "OPTIONS") {
    reply.code(204).send();
    return;
  }
  done();
});

const memoryStore = new Map();

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { app.log.warn({ err: e, dir }, "mkdir failed"); }
}

if (TRAJ_DIR_ABS) {
  ensureDirSync(TRAJ_DIR_ABS);
}

function responsePath(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(TRAJ_DIR_ABS, `${safe}.json`);
}

const store = {
  get(id) {
    if (TRAJ_DISABLED) return undefined;
    if (memoryStore.has(id)) return memoryStore.get(id);
    if (!TRAJ_DIR_ABS) return undefined;
    try {
      const raw = fs.readFileSync(responsePath(id), "utf8");
      const entry = JSON.parse(raw);
      memoryStore.set(id, entry);
      return entry;
    } catch {
      return undefined;
    }
  },
  has(id) {
    if (TRAJ_DISABLED) return false;
    if (memoryStore.has(id)) return true;
    if (!TRAJ_DIR_ABS) return false;
    try {
      fs.accessSync(responsePath(id), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  set(id, entry) {
    if (TRAJ_DISABLED) return;
    memoryStore.set(id, entry);
    if (TRAJ_DIR_ABS) {
      const file = responsePath(id);
      try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entry));
        fs.renameSync(tmp, file);
      } catch (e) {
        app.log.warn({ err: e, id }, "failed to persist response entry");
      }
    }
  }
};

function trajShortId(sessionId, conversationKey) {
  const src = String(sessionId || conversationKey || "unknown");
  return src.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "unknown0";
}

function trajFilePath(sessionId, conversationKey, ext) {
  return path.join(TRAJ_DIR_ABS, `sid_${trajShortId(sessionId, conversationKey)}${ext}`);
}

function appendJsonl(filePath, obj) {
  if (!TRAJ_DIR_ABS) return;
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
  } catch (e) {
    app.log.warn({ err: e, filePath }, "trajectory append failed");
  }
}

function normalizeErrorCompact(error) {
  if (error == null) return undefined;
  if (typeof error === "string") return { message: error };
  const base = error.error || error;
  const out = {
    type: base?.type,
    code: base?.code,
    message: base?.message || error?.message
  };
  Object.keys(out).forEach(k => out[k] == null && delete out[k]);
  return Object.keys(out).length ? out : { message: String(error) };
}

function buildTrajRow({
  endpoint,
  conversationKey,
  sessionId,
  clientRequest,
  upstreamRequest,
  upstreamResponse,
  clientResponse,
  status,
  model,
  usage,
  durationMs,
  error
}) {
  const row = {
    ts: new Date().toISOString(),
    endpoint,
    session_id: sessionId,
    conversation_key: conversationKey,
    status: status ?? 200,
    model,
    duration_ms: durationMs,
    usage,
    client_request: clientRequest,
    upstream_request: upstreamRequest,
    upstream_response: upstreamResponse,
    client_response: clientResponse,
    error: normalizeErrorCompact(error)
  };
  Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);
  if (!row.error) delete row.error;
  return row;
}

// Trim multi-turn history arrays (messages/contents) to keep only the last
// element. Each turn's request resends the entire prior transcript, so the
// earlier elements are redundant across rows. Returns a shallow-cloned body
// (or the original value if nothing to trim).
function trimHistoryForTraj(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const clone = { ...body };
  let trimmed = false;
  // OpenAI chat-style
  if (Array.isArray(clone.messages) && clone.messages.length > 1) {
    const n = clone.messages.length;
    clone.messages = [clone.messages[n - 1]];
    clone._truncated_messages_count = n - 1;
    trimmed = true;
  }
  // Gemini-style
  if (Array.isArray(clone.contents) && clone.contents.length > 1) {
    const n = clone.contents.length;
    clone.contents = [clone.contents[n - 1]];
    clone._truncated_contents_count = n - 1;
    trimmed = true;
  }
  // Anthropic /v1/messages uses `messages` too (handled above).
  // Responses API `input` array
  if (Array.isArray(clone.input) && clone.input.length > 1) {
    const n = clone.input.length;
    clone.input = [clone.input[n - 1]];
    clone._truncated_input_count = n - 1;
    trimmed = true;
  }
  return trimmed ? clone : body;
}

function buildTrimmedTrajRow(args) {
  const trimmed = {
    ...args,
    clientRequest: trimHistoryForTraj(args.clientRequest),
    upstreamRequest: trimHistoryForTraj(args.upstreamRequest)
  };
  return buildTrajRow(trimmed);
}

function logTrajectory(args) {
  if (!TRAJ_DIR_ABS) return;
  appendJsonl(
    trajFilePath(args.sessionId, args.conversationKey, ".traj.jsonl"),
    buildTrimmedTrajRow(args)
  );
}

function logTrajectoryError(args) {
  if (!TRAJ_DIR_ABS) return;
  appendJsonl(
    trajFilePath(args.sessionId, args.conversationKey, ".err.jsonl"),
    buildTrimmedTrajRow(args)
  );
}

const conversationSessions = new Map();

const now = () => Math.floor(Date.now() / 1000);
const rid = p => `${p}_${crypto.randomUUID().replace(/-/g, "")}`;

// ── Per-request one-line log ──
function clientIp(req) {
  const raw = req.ip || req.raw?.socket?.remoteAddress || "?";
  return raw.replace(/^::ffff:/, "");
}

function formatUsage(u) {
  if (!u) return "";
  const i = u.input_tokens ?? u.prompt_tokens ?? 0;
  const o = u.output_tokens ?? u.completion_tokens ?? 0;
  const c = u.cache_read_input_tokens
    ?? u.input_tokens_details?.cached_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? 0;
  const r = u.reasoning_tokens
    ?? u.output_tokens_details?.reasoning_tokens
    ?? u.completion_tokens_details?.reasoning_tokens
    ?? 0;
  let s = `in=${i} out=${o}`;
  if (r) s += ` reason=${r}`;
  if (c) s += ` cached=${c}`;
  return s;
}

// Extract the last `"usage": { ... }` object from an SSE tail string, with
// proper brace-balance scanning (handles nested objects like
// completion_tokens_details / prompt_tokens_details).
function extractUsageFromSseTail(tail) {
  if (!tail || typeof tail !== "string") return undefined;
  const key = "\"usage\"";
  let lastStart = -1;
  let searchFrom = 0;
  // find last occurrence of "usage"
  while (true) {
    const idx = tail.indexOf(key, searchFrom);
    if (idx === -1) break;
    lastStart = idx;
    searchFrom = idx + key.length;
  }
  if (lastStart === -1) return undefined;
  // skip past `"usage"` + optional spaces + `:`
  let i = lastStart + key.length;
  while (i < tail.length && (tail[i] === " " || tail[i] === "\t")) i++;
  if (tail[i] !== ":") return undefined;
  i++;
  while (i < tail.length && (tail[i] === " " || tail[i] === "\t")) i++;
  if (tail[i] === "n") {
    // "usage": null
    return undefined;
  }
  if (tail[i] !== "{") return undefined;
  // brace scan, aware of strings
  let depth = 0;
  let inStr = false;
  let esc = false;
  const start = i;
  for (; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonStr = tail.slice(start, i + 1);
        try { return JSON.parse(jsonStr); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

// Best-effort extraction of a "thinking level" descriptor from any of the
// supported request body shapes (OpenAI Chat / Anthropic / Responses / Gemini).
// Returns a short string like "low", "high", "budget=4096", "effort=medium",
// or null when the request did not specify one.
function extractThinkingLevel(body) {
  if (!body || typeof body !== "object") return null;

  // OpenAI Chat extension: { thinking: { thinking_level, budget_tokens, ... } }
  const t = body.thinking;
  if (t && typeof t === "object") {
    if (typeof t.thinking_level === "string" && t.thinking_level) return t.thinking_level;
    if (typeof t.level === "string" && t.level) return t.level;
    if (typeof t.effort === "string" && t.effort) return `effort=${t.effort}`;
    if (typeof t.type === "string" && t.type === "enabled" && typeof t.budget_tokens === "number") {
      return `budget=${t.budget_tokens}`;
    }
    if (typeof t.budget_tokens === "number") return `budget=${t.budget_tokens}`;
    if (t.type) return String(t.type);
  }

  // OpenAI Responses: { reasoning: { effort } }
  const r = body.reasoning;
  if (r && typeof r === "object") {
    if (typeof r.effort === "string" && r.effort) return `effort=${r.effort}`;
    if (typeof r.level === "string" && r.level) return r.level;
  }

  // Gemini: { generationConfig: { thinkingConfig: { thinkingBudget, includeThoughts } } }
  const gc = body.generationConfig || body.generation_config;
  const tc = gc && (gc.thinkingConfig || gc.thinking_config);
  if (tc && typeof tc === "object") {
    const budget = tc.thinkingBudget ?? tc.thinking_budget;
    if (typeof budget === "number") return `budget=${budget}`;
    if (tc.includeThoughts === true || tc.include_thoughts === true) return "true";
  }

  return null;
}

function requestLog(tag, { model, ip, status, t0, usage, error, sessionId, thinkingLevel }) {
  const time = ((Date.now() - t0) / 1000).toFixed(1);
  const u = formatUsage(usage);
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const sid = sessionId ? sessionId.slice(0, 8) : "-";
  const think = thinkingLevel ? ` think=${thinkingLevel}` : "";
  const base = `${ts} [${tag}] model=${model || "?"} sid=${sid} ip=${ip || "?"} status=${status} time=${time}s${think}`;
  if (error) {
    const msg = typeof error === "string" ? error : error?.message || error?.error?.message || JSON.stringify(error);
    process.stderr.write(`${base} error=${msg}\n`);
  } else {
    process.stdout.write(`${base} ${u}\n`);
  }
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive"
};

function resolveModel(clientModel) {
  if (!clientModel || typeof clientModel !== "string") {
    const err = new Error("model is required");
    err.statusCode = 400;
    throw err;
  }

  const direct = CFG.models[clientModel];
  if (direct) {
    const provider = CFG.providers[direct.provider];
    if (!provider) {
      const err = new Error(`provider_not_found: ${direct.provider}`);
      err.statusCode = 500;
      throw err;
    }
    const api = Array.isArray(direct.api) ? direct.api : direct.api ? [direct.api] : provider.api || ["chat"];
    return {
      providerId: direct.provider,
      provider,
      api,
      params: direct.params || {},
      upstreamName: clientModel
    };
  }

  for (const rule of CFG.fallback || []) {
    let re;
    try {
      re = new RegExp(rule.match);
    } catch {
      continue;
    }
    if (re.test(clientModel)) {
      const provider = CFG.providers[rule.provider];
      if (!provider) {
        const err = new Error(`provider_not_found: ${rule.provider}`);
        err.statusCode = 500;
        throw err;
      }
      const api = Array.isArray(rule.api) ? rule.api : rule.api ? [rule.api] : provider.api || ["chat"];
      return {
        providerId: rule.provider,
        provider,
        api,
        params: rule.params || {},
        upstreamName: clientModel
      };
    }
  }

  const err = new Error(`model_not_configured: ${clientModel}`);
  err.statusCode = 400;
  if (CFG.providers.default) {
    const provider = CFG.providers.default;
    const api = provider.api || ["responses"];
    return {
      providerId: "default",
      provider,
      api: Array.isArray(api) ? api : [api],
      params: {},
      upstreamName: clientModel
    };
  }
  throw err;
}

function handleResolveError(err, reply) {
  const status = err?.statusCode || 500;
  reply.code(status);
  return {
    error: {
      type: status === 400 ? "invalid_request_error" : "internal_error",
      message: err?.message || "resolve model failed"
    }
  };
}

function hasBearerAuth(headers = {}) {
  const auth = headers.authorization;
  return typeof auth === "string" && /^Bearer\s+.+/i.test(auth);
}

function hasAnthropicApiKey(headers = {}) {
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function getBearerToken(headers = {}) {
  const auth = headers.authorization;
  const match = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
  return match?.[1]?.trim() || null;
}

function getAnthropicApiKey(headers = {}) {
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey.trim() : null;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function verifyClientAuth(req, reply, done) {
  if (!BRIDGE_API_KEY) return done();

  const bearerToken = getBearerToken(req.headers);
  const anthropicApiKey = getAnthropicApiKey(req.headers);
  // Gemini CLI passes the key via `x-goog-api-key` header or `?key=` query string
  const googKey = typeof req.headers["x-goog-api-key"] === "string" ? req.headers["x-goog-api-key"].trim() : null;
  const queryKey = typeof req.query?.key === "string" ? req.query.key.trim() : null;
  if (
    safeEqual(bearerToken, BRIDGE_API_KEY) ||
    safeEqual(anthropicApiKey, BRIDGE_API_KEY) ||
    safeEqual(googKey, BRIDGE_API_KEY) ||
    safeEqual(queryKey, BRIDGE_API_KEY)
  ) {
    return done();
  }

  reply.code(401).send({
    error: {
      message: "Invalid API key",
      type: "authentication_error"
    }
  });
}

function buildOpenAIModelsResponse() {
  return {
    object: "list",
    data: [
      {
        id: "gpt-5.4",
        object: "model",
        created: now(),
        owned_by: "openai",
        provider: "openai"
      },
      {
        id: "gpt-5.3-codex",
        object: "model",
        created: now(),
        owned_by: "openai",
        provider: "openai"
      },
      {
        id: "gpt-5.2",
        object: "model",
        created: now(),
        owned_by: "openai",
        provider: "openai"
      }
    ]
  };
}

function buildAnthropicModelsResponse() {
  return {
    data: [
      {
        type: "model",
        id: "claude-opus-4-6",
        display_name: "Claude Opus 4.6",
        created_at: "2026-02-04T00:00:00Z",
        max_input_tokens: 1000000,
        max_tokens: 128000,
        capabilities: {
          batch: { supported: true },
          citations: { supported: true },
          code_execution: { supported: true },
          context_management: {
            supported: true,
            clear_tool_uses_20250919: { supported: true },
            clear_thinking_20251015: { supported: true },
            compact_20260112: { supported: true }
          },
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: true }
          },
          image_input: { supported: true },
          pdf_input: { supported: true },
          structured_outputs: { supported: true },
          thinking: {
            supported: true,
            types: {
              enabled: { supported: true },
              adaptive: { supported: true }
            }
          }
        }
      },
      {
        type: "model",
        id: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6",
        created_at: "2026-02-17T00:00:00Z",
        max_input_tokens: 1000000,
        max_tokens: 128000,
        capabilities: {
          batch: { supported: true },
          citations: { supported: true },
          code_execution: { supported: true },
          context_management: {
            supported: true,
            clear_tool_uses_20250919: { supported: true },
            clear_thinking_20251015: { supported: true },
            compact_20260112: { supported: true }
          },
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: true }
          },
          image_input: { supported: true },
          pdf_input: { supported: true },
          structured_outputs: { supported: true },
          thinking: {
            supported: true,
            types: {
              enabled: { supported: true },
              adaptive: { supported: true }
            }
          }
        }
      }
    ],
    has_more: false,
    first_id: "claude-opus-4-6",
    last_id: "claude-sonnet-4-6"
  };
}

function deepClone(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

function asArray(x) {
  return Array.isArray(x) ? x : x == null ? [] : [x];
}

function normalizePart(part, role = "user") {
  if (!part) return part;
  if (part.type === "input_text") return part;
  if (part.type === "text") {
    return role === "assistant"
      ? { type: "output_text", text: part.text ?? "", annotations: [], logprobs: [] }
      : { type: "input_text", text: part.text ?? "" };
  }
  if (part.type === "output_text") {
    return role === "assistant"
      ? { type: "output_text", text: part.text ?? "", annotations: part.annotations || [], logprobs: part.logprobs || [] }
      : { type: "input_text", text: part.text ?? "" };
  }
  if (part.type === "refusal") {
    return role === "assistant"
      ? { type: "refusal", refusal: part.refusal ?? part.text ?? "" }
      : { type: "input_text", text: part.refusal ?? part.text ?? "" };
  }
  if (part.type === "input_image") return part;
  if (part.type === "image") {
    const source = part.source || {};
    if (source.type === "base64" && source.media_type && source.data) {
      return {
        type: "input_image",
        image_url: `data:${source.media_type};base64,${source.data}`
      };
    }
    return {
      type: "input_image",
      image_url: source.url || part.url
    };
  }
  if (part.type === "image_url") {
    return {
      type: "input_image",
      image_url: typeof part.image_url === "string" ? part.image_url : part.image_url?.url
    };
  }
  if (part.type === "input_file") return part;
  if (part.type === "tool_result") {
    return {
      type: "function_call_output",
      call_id: part.tool_use_id,
      output: typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? {})
    };
  }
  if (part.type === "tool_use") {
    return {
      type: "input_text",
      text: JSON.stringify({ tool_use_id: part.id, name: part.name, input: part.input ?? {} })
    };
  }
  return {
    type: "input_text",
    text: typeof part === "string" ? part : JSON.stringify(part)
  };
}

function normalizeMessage(msg) {
  if (typeof msg === "string") {
    return { role: "user", content: [{ type: "input_text", text: msg }] };
  }

  if (msg?.type === "function_call_output") {
    return {
      type: "function_call_output",
      call_id: msg.call_id,
      output: typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output ?? {})
    };
  }

  if (msg?.role) {
    return { role: msg.role, content: asArray(msg.content).map(part => normalizePart(part, msg.role)) };
  }

  if (msg?.type === "message" && msg.role) {
    return { role: msg.role, content: asArray(msg.content).map(part => normalizePart(part, msg.role)) };
  }

  return msg;
}

function flattenInput(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return asArray(input).map(normalizeMessage);
}

function extractAssistantHistoryItems(upstream) {
  const items = [];
  for (const item of asArray(upstream?.output)) {
    if (item.type === "message") {
      items.push({
        role: "assistant",
        content: asArray(item.content).map(c => {
          if (c.type === "output_text") {
            return {
              type: "output_text",
              text: c.text ?? "",
              annotations: c.annotations || [],
              logprobs: c.logprobs || []
            };
          }
          return c;
        })
      });
      continue;
    }
    if (item.type === "function_call") {
      items.push({
        type: "function_call",
        id: item.id,
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments || "{}",
        status: item.status || "completed"
      });
    }
  }
  return items;
}

function extractSystemMessage(system) {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return asArray(system)
    .map(part => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeToolResultContent(content) {
  if (typeof content === "string") return content;

  const parts = asArray(content);
  if (!parts.length) return "";

  const textOnly = parts.every(part => typeof part === "string" || part?.type === "text");
  if (textOnly) {
    return parts
      .map(part => typeof part === "string" ? part : part.text ?? "")
      .join("\n");
  }

  return JSON.stringify(content ?? {});
}

function shouldSkipAnthropicHistoryPart(part, role) {
  if (!part || typeof part !== "object" || role !== "assistant") return false;
  return part.type === "thinking" || part.type === "redacted_thinking";
}

function normalizeAnthropicToolUse(part) {
  if (part?.type !== "tool_use") return null;
  return {
    type: "function_call",
    call_id: part.id || rid("call"),
    name: part.name,
    arguments: JSON.stringify(part.input ?? {}),
    status: "completed"
  };
}

function normalizeAnthropicToolResult(part) {
  if (part?.type !== "tool_result") return null;

  const output = normalizeToolResultContent(part.content);
  if (!part.is_error) {
    return {
      type: "function_call_output",
      call_id: part.tool_use_id,
      output
    };
  }

  return {
    type: "function_call_output",
    call_id: part.tool_use_id,
    output: JSON.stringify({
      is_error: true,
      content: output
    })
  };
}

function anthropicMessagesToInput(body) {
  const input = [];
  const system = extractSystemMessage(body.system);
  if (system) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: system }]
    });
  }

  for (const message of asArray(body.messages)) {
    const parts = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : asArray(message.content);

    let content = [];
    const flushContent = () => {
      if (!content.length) return;
      input.push({ role: message.role, content });
      content = [];
    };

    for (const part of parts) {
      if (shouldSkipAnthropicHistoryPart(part, message.role)) continue;

      const toolUse = message.role === "assistant" ? normalizeAnthropicToolUse(part) : null;
      if (toolUse) {
        flushContent();
        input.push(toolUse);
        continue;
      }

      const toolResult = message.role === "user" ? normalizeAnthropicToolResult(part) : null;
      if (toolResult) {
        flushContent();
        input.push(toolResult);
        continue;
      }

      content.push(normalizePart(part, message.role));
    }

    flushContent();
  }

  return input;
}

function anthropicToolsToOpenAITools(tools) {
  return asArray(tools).map(tool => normalizeFunctionTool({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema
  }));
}

function mapAnthropicToolChoice(toolChoice, translatedTools) {
  if (!translatedTools.length || !toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice.type === "auto") return "auto";
  if (toolChoice === "any" || toolChoice.type === "any") return "required";
  if (toolChoice === "none" || toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return simplifyToolChoice({ type: "function", name: toolChoice.name }, translatedTools);
  }
  return "auto";
}

function mapAnthropicThinking(thinking) {
  if (!thinking || thinking.type === "disabled") return undefined;

  let effort = "medium";
  if (thinking.effort) effort = thinking.effort;
  else if (thinking.budget_tokens != null) effort = thinking.budget_tokens >= 8000 ? "high" : thinking.budget_tokens >= 2048 ? "medium" : "low";

  return { effort };
}

function parseJsonObject(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function summarizeReasoning(item) {
  return asArray(item.summary)
    .map(part => part?.text || part?.summary || "")
    .filter(Boolean)
    .join("\n");
}

function mapStopReasonFromOutput(output) {
  return output.some(item => item.type === "function_call") ? "tool_use" : "end_turn";
}

function makeAnthropicUsage(upstream) {
  const usage = upstream.usage || {};
  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0
  };
}

function makeAnthropicMessage(body, upstream) {
  const responseId = upstream.id || rid("msg");
  const output = convertOutput(upstream);
  const content = [];

  for (const item of output) {
    if (item.type === "reasoning") {
      const thinking = summarizeReasoning(item);
      if (thinking) {
        content.push({
          type: "thinking",
          thinking,
          signature: item.id || rid("sig")
        });
      }
      continue;
    }

    if (item.type === "message") {
      for (const part of asArray(item.content)) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text ?? "" });
      }
      continue;
    }

    if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: parseJsonObject(item.arguments || "{}", { raw: item.arguments || "{}" })
      });
    }
  }

  return {
    id: responseId,
    type: "message",
    role: "assistant",
    model: body.model || upstream.model,
    content,
    stop_reason: mapStopReasonFromOutput(output),
    stop_sequence: null,
    usage: makeAnthropicUsage(upstream)
  };
}

function makeCapabilityTool(name, description, parameters) {
  return {
    type: "function",
    name,
    description,
    parameters
  };
}

function stripFields(obj, keys) {
  if (Array.isArray(obj)) return obj.map(o => stripFields(o, keys));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (keys.includes(k)) continue;
      out[k] = stripFields(v, keys);
    }
    return out;
  }
  return obj;
}

function derefSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const defs = schema.$defs || schema.definitions || {};
  if (Object.keys(defs).length === 0) return schema;

  function expand(obj, seen = new Set()) {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(item => expand(item, seen));
    if (obj.$ref && typeof obj.$ref === "string") {
      const match = obj.$ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
      if (match) {
        const name = match[2];
        if (seen.has(name)) return { type: "object" };
        if (defs[name]) {
          seen.add(name);
          const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "$ref"));
          const result = expand({ ...defs[name], ...rest }, new Set(seen));
          seen.delete(name);
          return result;
        }
      }
    }
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "$defs" || key === "definitions") continue;
      result[key] = expand(value, seen);
    }
    return result;
  }

  return expand(schema);
}

function cleanToolParameters(params) {
  if (!params) return { type: "object", properties: {}, additionalProperties: false };
  return stripFields(derefSchema(params), ["$schema", "ref"]);
}

function isStandardFunctionTool(tool) {
  return tool?.type === "function" && typeof tool?.name === "string" && tool?.parameters && !tool?.tools;
}

function normalizeFunctionTool(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: cleanToolParameters(tool.parameters)
  };
}

function simplifyToolChoice(toolChoice, translatedTools) {
  if (!translatedTools?.length) return undefined;
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "required") return "required";

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const translated = translatedTools.find(t => t.name === toolChoice.name);
    return translated ? { type: "function", name: translated.name } : "auto";
  }

  return "auto";
}

function translateTools(tools) {
  const translated = [];
  const categories = new Set();

  function visit(tool) {
    if (!tool || typeof tool !== "object") return;

    if (isStandardFunctionTool(tool)) {
      translated.push(normalizeFunctionTool(tool));
      return;
    }

    if (Array.isArray(tool.tools)) {
      for (const nested of tool.tools) visit(nested);
    }

    if (tool.type === "mcp" || tool.type === "remote_mcp") {
      categories.add("workspace");
      return;
    }

    if (tool.type === "web_search" || tool.type === "web_search_preview") {
      categories.add("web");
      return;
    }

    if (tool.type === "code_interpreter") {
      categories.add("code");
      return;
    }

    if (tool.type === "computer_use") {
      categories.add("computer");
      return;
    }

    if (tool.type === "image_generation") {
      categories.add("image");
      return;
    }

    if (tool.type || tool.name) {
      translated.push(normalizeFunctionTool({
        type: "function",
        name: tool.name || tool.type,
        description: tool.description || `Forwarded ${tool.type || "tool"}`,
        parameters: tool.parameters || {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }));
      return;
    }

    categories.add("workspace");
  }

  for (const tool of asArray(tools)) visit(tool);

  if (categories.has("workspace")) {
    translated.push(makeCapabilityTool(
      "workspace_action",
      "Perform workspace, file, shell, or MCP-backed actions in the local environment.",
      {
        type: "object",
        properties: {
          intent: { type: "string", description: "What action should be taken in the workspace." },
          target: { type: "string", description: "Optional file, directory, command, or resource target." },
          arguments: { type: "object", description: "Optional structured arguments for the action." }
        },
        required: ["intent"],
        additionalProperties: false
      }
    ));
  }

  if (categories.has("web")) {
    translated.push(makeCapabilityTool(
      "web_lookup",
      "Search or fetch information from the web.",
      {
        type: "object",
        properties: {
          query: { type: "string" },
          url: { type: "string" }
        },
        additionalProperties: false
      }
    ));
  }

  if (categories.has("code")) {
    translated.push(makeCapabilityTool(
      "code_execution",
      "Run code or perform computation in an execution environment.",
      {
        type: "object",
        properties: {
          task: { type: "string" },
          language: { type: "string" },
          input: { type: "string" }
        },
        required: ["task"],
        additionalProperties: false
      }
    ));
  }

  if (categories.has("computer")) {
    translated.push(makeCapabilityTool(
      "computer_action",
      "Interact with a computer UI or application environment.",
      {
        type: "object",
        properties: {
          action: { type: "string" },
          target: { type: "string" }
        },
        required: ["action"],
        additionalProperties: false
      }
    ));
  }

  if (categories.has("image")) {
    translated.push(makeCapabilityTool(
      "image_action",
      "Generate or transform an image asset.",
      {
        type: "object",
        properties: {
          prompt: { type: "string" },
          operation: { type: "string" }
        },
        additionalProperties: false
      }
    ));
  }

  return translated;
}

function mergeHistory(previousResponseId, input) {
  const incoming = flattenInput(input);
  if (!previousResponseId) return incoming;
  const prev = store.get(previousResponseId);
  if (!prev) return incoming;
  return [...deepClone(prev.history), ...incoming];
}

function extractOutputText(upstream) {
  const texts = [];
  for (const item of asArray(upstream.output)) {
    if (item.type !== "message") continue;
    for (const c of asArray(item.content)) {
      if (c.type === "output_text" && c.text) texts.push(c.text);
    }
  }
  return texts.join("\n");
}

function convertOutput(upstream) {
  const output = [];
  for (const item of asArray(upstream.output)) {
    if (item.type === "reasoning") {
      output.push({
        id: item.id || rid("rs"),
        type: "reasoning",
        summary: item.summary || []
      });
      continue;
    }

    if (item.type === "function_call") {
      output.push({
        type: "function_call",
        id: item.id || rid("fc"),
        call_id: item.call_id || rid("call"),
        name: item.name,
        arguments: item.arguments || "{}",
        status: item.status || "completed"
      });
      continue;
    }

    if (item.type === "message") {
      output.push({
        id: item.id || rid("msg"),
        type: "message",
        role: item.role || "assistant",
        status: item.status || "completed",
        phase: item.phase,
        content: asArray(item.content).map(c => {
          if (c.type === "output_text") {
            return {
              type: "output_text",
              text: c.text ?? "",
              annotations: c.annotations || [],
              logprobs: c.logprobs || []
            };
          }
          return c;
        })
      });
      continue;
    }
  }
  return output;
}

function makeOpenAIResponse(reqBody, upstream) {
  const response = deepClone(upstream ?? {});

  response.id ??= rid("resp");
  response.object ??= "response";
  response.created_at ??= now();
  response.model ??= reqBody.model;
  response.instructions ??= reqBody.instructions ?? null;
  response.max_output_tokens ??= reqBody.max_output_tokens ?? null;
  response.parallel_tool_calls ??= true;
  response.previous_response_id ??= reqBody.previous_response_id ?? null;
  response.reasoning ??= { effort: "none" };
  response.store ??= true;
  response.temperature ??= reqBody.temperature ?? 1;
  response.text ??= { format: { type: "text" }, verbosity: "medium" };
  response.tool_choice ??= reqBody.tool_choice ?? "auto";
  response.tools ??= translateTools(reqBody.tools);
  response.top_p ??= reqBody.top_p ?? 1;
  response.truncation ??= "disabled";
  response.usage ??= null;
  response.metadata ??= reqBody.metadata ?? {};
  response.user ??= reqBody.user ?? null;

  if (response.output_text == null) {
    response.output_text = extractOutputText(response);
  }

  return response;
}

function getConversationKey(previousResponseId, input) {
  if (previousResponseId && store.has(previousResponseId)) {
    return store.get(previousResponseId).conversationKey;
  }
  return buildConversationKey("responses", input);
}

function hashFirstUserMessage(messages) {
  const arr = asArray(messages);
  const first = arr.find(m => m?.role === "user") || arr[0];
  if (!first) return null;
  if (typeof first === "string") {
    return crypto.createHash("sha256").update(`user:${first}`).digest("hex");
  }
  const content = typeof first.content === "string"
    ? first.content
    : JSON.stringify(first.content ?? []);
  return crypto.createHash("sha256").update(`${first.role || "user"}:${content}`).digest("hex");
}

function buildConversationKey(prefix, messages) {
  const hash = hashFirstUserMessage(messages);
  return `${prefix}:${hash || crypto.randomUUID()}`;
}

function openAIChatMessagesToInput(messages) {
  const input = [];
  for (const msg of asArray(messages)) {
    if (!msg) continue;

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "")
      });
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      if (msg.content) {
        input.push({
          role: "assistant",
          content: typeof msg.content === "string"
            ? [{ type: "output_text", text: msg.content, annotations: [], logprobs: [] }]
            : asArray(msg.content).map(part => normalizePart(part, "assistant"))
        });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments || "{}",
          status: "completed"
        });
      }
      continue;
    }

    input.push({
      role: msg.role,
      content: typeof msg.content === "string"
        ? [{ type: "input_text", text: msg.content }]
        : asArray(msg.content).map(part => normalizePart(part, msg.role))
    });
  }
  return input;
}

function chatCompletionChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: now(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

function getSessionIdForConversation(conversationKey) {
  if (!conversationSessions.has(conversationKey)) {
    conversationSessions.set(conversationKey, crypto.randomUUID());
  }
  return conversationSessions.get(conversationKey);
}

function saveResponse(id, history, upstream, openaiResp, conversationKey) {
  const baseHistory = Array.isArray(history) ? history : flattenInput(history);
  const assistantItems = extractAssistantHistoryItems(upstream);
  store.set(id, {
    history: deepClone([...baseHistory, ...assistantItems]),
    upstream: deepClone(upstream),
    response: deepClone(openaiResp),
    conversationKey,
    createdAt: Date.now()
  });
}

function upstreamUrl(target, apiOverride) {
  const api = apiOverride || target.api[0];
  const useMessagesBase = api === "messages" && target.provider.messages_base_url;
  const base = String(useMessagesBase ? target.provider.messages_base_url : target.provider.base_url || "").replace(/\/+$/, "");
  const chatPath = target.provider.chat_path || "chat/completions";
  const messagesPath = target.provider.messages_path || "messages";
  const responsesPath = target.provider.responses_path || "responses";
  const pathSeg = api === "messages" ? messagesPath
             : api === "chat"     ? chatPath
             :                       responsesPath;
  if (target.provider.auth === "query_ak") {
    return `${base}/${pathSeg}?ak=${encodeURIComponent(target.provider.api_key || "")}`;
  }
  return `${base}/${pathSeg}`;
}

function upstreamHeaders(target, sessionId, apiOverride) {
  const h = { "content-type": "application/json" };
  if (target.provider.auth === "bearer" && target.provider.api_key) {
    h.authorization = `Bearer ${target.provider.api_key}`;
    if (apiOverride === "messages" || target.api[0] === "messages") {
      h["x-api-key"] = target.provider.api_key;
    }
  }
  if (target.provider.session_header === "extra" && sessionId) {
    h["X-TT-LOGID"] = crypto.randomUUID();
    h.extra = JSON.stringify({ session_id: sessionId });
  }
  return h;
}

function mergeParams(upstreamBody, params) {
  if (!params) return upstreamBody;
  for (const [k, v] of Object.entries(params)) {
    if (upstreamBody[k] == null) upstreamBody[k] = v;
  }
  return upstreamBody;
}

function extractSessionId(body, headers) {
  if (body && typeof body.session_id === "string" && body.session_id) return body.session_id;
  if (body?.metadata && typeof body.metadata.session_id === "string" && body.metadata.session_id) {
    return body.metadata.session_id;
  }
  if (body?.extra) {
    const extraObj = typeof body.extra === "string" ? parseJsonObject(body.extra, null) : body.extra;
    if (extraObj && typeof extraObj.session_id === "string" && extraObj.session_id) {
      return extraObj.session_id;
    }
  }
  const hdr = headers?.["x-session-id"];
  if (typeof hdr === "string" && hdr) return hdr;
  return null;
}

/** Sanitize metadata.user_id so it matches upstream pattern ^[a-zA-Z0-9_-]+$ */
function sanitizeMetadataForUpstream(body) {
  if (!body?.metadata || typeof body.metadata !== "object") return;
  if (typeof body.metadata.user_id === "string" && !/^[a-zA-Z0-9_-]*$/.test(body.metadata.user_id)) {
    body.metadata.user_id = crypto.createHash("sha256").update(body.metadata.user_id).digest("hex").slice(0, 32);
  }
}

async function forwardCompact(req, reply, compactPath) {
  const t0 = Date.now();
  const ip = clientIp(req);
  const incoming = req.body || {};
  const body = { ...incoming };
  const tl = extractThinkingLevel(body);

  let sessionId = extractSessionId(body, req.headers);
  if (!sessionId) {
    const conversationKey = getConversationKey(body.previous_response_id, body.input);
    sessionId = getSessionIdForConversation(conversationKey);
  }

  delete body.session_id;
  delete body.extra;
  if (body.metadata && typeof body.metadata === "object") {
    const md = { ...body.metadata };
    delete md.session_id;
    if (Object.keys(md).length === 0) delete body.metadata;
    else body.metadata = md;
  }

  let target;
  try {
    target = resolveModel(body.model);
  } catch (err) {
    requestLog("CPCT", { model: body.model, ip, status: err?.statusCode || 500, t0, error: err?.message, sessionId, thinkingLevel: tl });
    return handleResolveError(err, reply);
  }

  if (!target.api.includes("responses")) {
    requestLog("CPCT", { model: body.model, providerId: target.providerId, ip, status: 501, t0, error: "api=responses not supported", sessionId, thinkingLevel: tl });
    reply.code(501);
    return { error: { type: "not_implemented", message: "compact requires a provider with api=responses" } };
  }

  body.model = target.upstreamName;
  body.max_output_tokens = body.max_output_tokens ?? body.max_tokens;
  delete body.max_tokens;
  mergeParams(body, target.params);

  const base = String(target.provider.base_url || "").replace(/\/+$/, "");
  const url = target.provider.auth === "query_ak"
    ? `${base}/${compactPath}?ak=${encodeURIComponent(target.provider.api_key || "")}`
    : `${base}/${compactPath}`;
  app.log.debug({ url, upstreamBody: body, sessionId }, "forwarding compact to upstream");

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders(target, sessionId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const message = err?.name === "TimeoutError" ? `upstream request timed out after ${TIMEOUT_MS / 1000}s` : (err?.message || "upstream fetch failed");
    requestLog("CPCT", { model: body.model, providerId: target.providerId, ip, status: 502, t0, error: message, sessionId, thinkingLevel: tl });
    reply.code(502);
    return { error: { type: "upstream_error", message } };
  }

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  requestLog("CPCT", { model: body.model, providerId: target.providerId, ip, status: resp.status, t0, usage: json?.usage, error: resp.ok ? undefined : json, sessionId, thinkingLevel: tl });
  reply.code(resp.status);
  return json;
}

async function callUpstream(body, sessionId, target) {
  app.log.debug({ upstreamBody: body, providerId: target.providerId, api: target.api }, "forwarding request to upstream");

  let resp;
  try {
    resp = await fetch(upstreamUrl(target), {
      method: "POST",
      headers: upstreamHeaders(target, sessionId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const message = err?.name === "TimeoutError" ? `upstream request timed out after ${TIMEOUT_MS / 1000}s` : (err?.message || "upstream fetch failed");
    app.log.error({ err }, "upstream fetch failed");
    return {
      status: 502,
      ok: false,
      json: { error: { type: "upstream_error", message } },
      text: message
    };
  }

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  app.log.debug({ upstreamStatus: resp.status, upstreamResponse: json }, "upstream response");
  return { status: resp.status, ok: resp.ok, json, text };
}

async function streamUpstream(body, sessionId, onEvent, target) {
  app.log.debug({ upstreamBody: body, sessionId, providerId: target.providerId, api: target.api }, "streaming request to upstream");
  const startedAt = Date.now();

  let resp;
  try {
    resp = await fetch(upstreamUrl(target), {
      method: "POST",
      headers: upstreamHeaders(target, sessionId),
      body: JSON.stringify({ ...body, stream: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const message = err?.name === "TimeoutError" ? `upstream request timed out after ${TIMEOUT_MS / 1000}s` : (err?.message || "upstream fetch failed");
    app.log.error({ err }, "upstream stream fetch failed");
    return {
      resp: { ok: false, status: 502 },
      errorText: message,
      errorJson: { error: { type: "upstream_error", message } }
    };
  }

  if (!resp.ok || !resp.body) {
    const text = await resp.text();
    return { resp, errorText: text, errorJson: parseJsonObject(text, null) };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  const eventCounts = {};
  let totalBytes = 0;
  let firstByteAt = 0;

  function flushBlocks(blocks) {
    for (const block of blocks) {
      const dataLines = block
        .split("\n")
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart());
      if (!dataLines.length) continue;
      const data = dataLines.join("\n");
      if (data === "[DONE]") {
        eventCounts["[DONE]"] = (eventCounts["[DONE]"] || 0) + 1;
        onEvent({ done: true, raw: block });
        continue;
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        const t = payload?.type || "(no-type)";
        eventCounts[t] = (eventCounts[t] || 0) + 1;
        onEvent({ payload, raw: block });
      } catch {
        eventCounts["(parse-error)"] = (eventCounts["(parse-error)"] || 0) + 1;
        onEvent({ rawData: data, raw: block });
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstByteAt && value?.length) firstByteAt = Date.now();
      if (value?.length) totalBytes += value.length;
      sseBuffer += decoder.decode(value, { stream: true });
      const blocks = sseBuffer.split("\n\n");
      sseBuffer = blocks.pop() || "";
      flushBlocks(blocks);
    }

    sseBuffer += decoder.decode();
    flushBlocks(sseBuffer.split("\n\n").filter(Boolean));
  } catch (err) {
    const message = err?.message || "upstream stream read failed";
    app.log.error({ err, eventCounts, totalBytes }, "upstream stream read failed");
    return {
      resp: { ok: false, status: 502 },
      errorText: message,
      errorJson: { error: { type: "upstream_error", message } }
    };
  }

  app.log.debug({
    upstreamStatus: resp.status,
    eventCounts,
    totalBytes,
    firstByteMs: firstByteAt ? firstByteAt - startedAt : null,
    durationMs: Date.now() - startedAt
  }, "upstream stream finished");

  return { resp };
}

async function passthroughNonStream(body, sessionId, target, reply, apiOverride, opts = {}) {
  const { endpoint = null, conversationKey = null, request = null } = opts;
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(upstreamUrl(target, apiOverride), {
      method: "POST",
      headers: upstreamHeaders(target, sessionId, apiOverride),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const message = err?.name === "TimeoutError" ? `upstream request timed out after ${TIMEOUT_MS / 1000}s` : (err?.message || "upstream fetch failed");
    app.log.error({ err }, "upstream passthrough fetch failed");
    if (endpoint && conversationKey) {
      logTrajectoryError({
        endpoint,
        conversationKey,
        sessionId,
        clientRequest: request ?? body,
        upstreamRequest: body,
        upstreamResponse: { error: { type: "upstream_error", message } },
        clientResponse: { error: { type: "upstream_error", message } },
        status: 502,
        model: body?.model,
        durationMs: Date.now() - t0,
        error: { error: { type: "upstream_error", message } }
      });
    }
    reply.code(502);
    reply.send({ ok: false, status: 502, text: message, json: { error: { type: "upstream_error", message } } });
    return { reply, status: 502, error: message };
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const usage = parsed?.usage;
  if (endpoint && conversationKey) {
    const common = {
      endpoint,
      conversationKey,
      sessionId,
      clientRequest: request ?? body,
      upstreamRequest: body,
      upstreamResponse: parsed ?? text,
      clientResponse: parsed ?? text,
      status: resp.status,
      model: body?.model,
      usage,
      durationMs: Date.now() - t0
    };
    if (resp.ok) logTrajectory(common);
    else logTrajectoryError({ ...common, error: parsed ?? text });
  }
  const ct = resp.headers.get("content-type") || "application/json";
  reply.code(resp.status);
  reply.header("content-type", ct);
  reply.send(text);
  return { reply, status: resp.status, usage };
}

async function proxyStreamPassthrough(body, sessionId, target, reply, apiOverride, opts = {}) {
  const { endpoint = null, conversationKey = null, request = null } = opts;
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(upstreamUrl(target, apiOverride), {
      method: "POST",
      headers: upstreamHeaders(target, sessionId, apiOverride),
      body: JSON.stringify({ ...body, stream: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const message = err?.name === "TimeoutError" ? `upstream request timed out after ${TIMEOUT_MS / 1000}s` : (err?.message || "upstream fetch failed");
    app.log.error({ err }, "upstream stream passthrough fetch failed");
    if (endpoint && conversationKey) {
      logTrajectoryError({
        endpoint: `${endpoint}:stream`,
        conversationKey,
        sessionId,
        clientRequest: request ?? body,
        upstreamRequest: { ...body, stream: true },
        upstreamResponse: { error: { type: "upstream_error", message } },
        clientResponse: { error: { type: "upstream_error", message } },
        status: 502,
        model: body?.model,
        durationMs: Date.now() - t0,
        error: { error: { type: "upstream_error", message } }
      });
    }
    reply.code(502);
    reply.send({ error: { type: "upstream_error", message } });
    return { reply, status: 502, error: message };
  }

  if (!resp.ok || !resp.body) {
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (endpoint && conversationKey) {
      const common = {
        endpoint: `${endpoint}:stream`,
        conversationKey,
        sessionId,
        clientRequest: request ?? body,
        upstreamRequest: { ...body, stream: true },
        upstreamResponse: parsed ?? text,
        clientResponse: parsed ?? text,
        status: resp.status,
        model: body?.model,
        durationMs: Date.now() - t0
      };
      if (resp.ok) logTrajectory(common);
      else logTrajectoryError({ ...common, error: parsed ?? text });
    }
    const ct = resp.headers.get("content-type") || "application/json";
    reply.code(resp.status);
    reply.header("content-type", ct);
    reply.send(text);
    let usage;
    usage = parsed?.usage;
    return { reply, status: resp.status, usage, error: resp.ok ? undefined : text };
  }

  setSseHeaders(reply);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let rawChunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.length) {
        const chunk = decoder.decode(value, { stream: true });
        reply.raw.write(Buffer.from(value));
        rawChunks.push(chunk);
        tail = (tail + chunk).slice(-8192);
      }
    }
  } catch (err) {
    app.log.error({ err }, "upstream stream passthrough read failed");
  }
  // extract usage from the tail of SSE stream (supports nested objects)
  const usage = extractUsageFromSseTail(tail);
  if (endpoint && conversationKey) {
    const rawSse = rawChunks.join("");
    logTrajectory({
      endpoint: `${endpoint}:stream`,
      conversationKey,
      sessionId,
      clientRequest: request ?? body,
      upstreamRequest: { ...body, stream: true },
      upstreamResponse: { kind: "sse", raw: rawSse },
      clientResponse: { kind: "sse_passthrough", raw: rawSse },
      status: resp.status,
      model: body?.model,
      usage,
      durationMs: Date.now() - t0
    });
  }
  reply.raw.end();
  return { reply, status: resp.status, usage };
}

function makeStreamErrorPayload(status, errorText, errorJson) {
  const message = errorJson?.error?.message || errorJson?.message || errorText || `Upstream error ${status}`;
  return {
    type: "error",
    error: {
      type: errorJson?.error?.type || errorJson?.type || "api_error",
      message
    }
  };
}

async function proxyModelHubStream(body, reply, sessionId, conversationKey, originalRequest, target) {
  setSseHeaders(reply);
  const t0 = Date.now();

  let fullText = "";
  let completedResponse = null;
  let latestResponse = null;
  let sawOutputItem = false;
  let upstreamFailure = null;
  let rawChunks = [];

  const { resp, errorText, errorJson } = await streamUpstream(body, sessionId, ({ payload, done, raw }) => {
    if (payload?.response) latestResponse = payload.response;
    if (payload?.type === "response.output_item.added") sawOutputItem = true;
    if (payload?.type === "response.output_text.delta") fullText += payload.delta || "";
    if (payload?.type === "response.completed") completedResponse = payload.response || null;
    if (payload?.type === "error" || payload?.type === "response.failed") {
      upstreamFailure = payload;
      app.log.warn({ upstreamFailure: payload }, "upstream stream returned failure event");
    }

    if (done) return;

    if (typeof raw === "string") rawChunks.push(raw);
    reply.raw.write(`${raw}\n\n`);
  }, target);

  if (!resp.ok) {
    logTrajectoryError({
      endpoint: "/v1/responses:stream",
      conversationKey,
      sessionId,
      clientRequest: originalRequest ?? body,
      upstreamRequest: body,
      upstreamResponse: errorJson ?? errorText,
      clientResponse: errorJson ?? errorText,
      status: resp.status,
      model: body?.model,
      durationMs: Date.now() - t0,
      error: errorJson ?? errorText
    });
    sse(reply, "error", makeStreamErrorPayload(resp.status, errorText, errorJson));
    reply.raw.end();
    return { reply, status: resp.status, error: errorJson ?? errorText };
  }

  if (!completedResponse && upstreamFailure) {
    const errMsg =
      upstreamFailure?.error?.message ||
      upstreamFailure?.response?.error?.message ||
      upstreamFailure?.message ||
      "upstream returned response.failed";
    const errType =
      upstreamFailure?.error?.type ||
      upstreamFailure?.response?.error?.type ||
      "upstream_error";
    logTrajectoryError({
      endpoint: "/v1/responses:stream",
      conversationKey,
      sessionId,
      clientRequest: originalRequest ?? body,
      upstreamRequest: body,
      upstreamResponse: { kind: "sse", raw: rawChunks.join("\n"), failure: upstreamFailure },
      clientResponse: upstreamFailure,
      status: resp.status,
      model: body?.model,
      durationMs: Date.now() - t0,
      error: upstreamFailure
    });
    sse(reply, "error", { type: "error", error: { type: errType, message: errMsg } });
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return { reply, status: resp.status, error: upstreamFailure };
  }

  if (!completedResponse) {
    const output = latestResponse?.output || (!sawOutputItem && fullText ? [{
      id: rid("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: fullText, annotations: [], logprobs: [] }]
    }] : []);

    completedResponse = makeOpenAIResponse(body, {
      ...latestResponse,
      id: latestResponse?.id || rid("resp"),
      object: "response",
      created_at: latestResponse?.created_at || now(),
      status: "completed",
      model: latestResponse?.model || body.model,
      output,
      output_text: latestResponse?.output_text ?? fullText
    });

    sse(reply, "response.completed", {
      type: "response.completed",
      response: completedResponse
    });
  }

  if (completedResponse?.id) {
    const openaiResp = makeOpenAIResponse(body, completedResponse);
    if (fullText && !openaiResp.output_text) openaiResp.output_text = fullText;
    saveResponse(openaiResp.id, body.input, completedResponse, openaiResp, conversationKey);
    logTrajectory({
      endpoint: "/v1/responses:stream",
      conversationKey,
      sessionId,
      clientRequest: originalRequest ?? body,
      upstreamRequest: body,
      upstreamResponse: { kind: "sse", raw: rawChunks.join("\n"), completed: completedResponse },
      clientResponse: openaiResp,
      status: 200,
      model: body?.model,
      usage: completedResponse?.usage,
      durationMs: Date.now() - t0
    });
  }

  app.log.debug({
    completedId: completedResponse?.id,
    completedStatus: completedResponse?.status,
    outputItems: completedResponse?.output?.length || 0,
    outputTypes: (completedResponse?.output || []).map(o => o?.type),
    finishReason: completedResponse?.output?.[0]?.content?.[0]?.finish_reason,
    fullTextLen: fullText.length,
    fullTextHead: fullText.slice(0, 200),
    sawOutputItem,
    usage: completedResponse?.usage
  }, "stream response summary");

  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
  return { reply, status: 200, usage: completedResponse?.usage };
}

function setSseHeaders(reply) {
  for (const [name, value] of Object.entries(SSE_HEADERS)) {
    reply.raw.setHeader(name, value);
  }
  if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();
}

function sse(reply, event, data) {
  if (event) reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function chunkText(text) {
  const normalized = String(text || "").replace(/  \n/g, "\n");
  const parts = normalized.split(/(\n+)/);
  const chunks = [];
  let buffer = "";

  for (const part of parts) {
    if (!part) continue;
    if ((buffer + part).length > 300 && buffer) {
      chunks.push(buffer);
      buffer = part;
      continue;
    }
    buffer += part;
  }

  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [""];
}



// ── Gemini v1beta <-> OpenAI chat completions converters ──
// Reference: new-api/service/convert.go (GeminiToOpenAIRequest, ResponseOpenAI2Gemini, StreamResponseOpenAI2Gemini)

function geminiRoleToOpenAI(role) {
  switch (role) {
    case "user": return "user";
    case "model": return "assistant";
    case "function": return "tool";
    case "system": return "system";
    default: return "user";
  }
}

function extractTextFromGeminiParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map(p => p?.text || "").filter(Boolean).join("\n");
}

// Convert Gemini v1beta request body to OpenAI chat/completions request body
function geminiRequestToOpenAIChat(geminiReq, modelName) {
  const messages = [];

  // system instructions
  const sysInstr = geminiReq.systemInstruction || geminiReq.system_instruction;
  if (sysInstr) {
    const sysText = extractTextFromGeminiParts(sysInstr.parts);
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  // track tool_call ids for pairing function responses
  // key mappings:
  //   pendingByName: name -> array of pending callIds (FIFO) from most recent assistant turn
  //   pendingByGeminiId: fc.id (from upstream Gemini) -> our callId
  //   pendingAll: ordered list of callIds awaiting responses (FIFO)
  let toolCallCounter = 0;
  const pendingByName = new Map();
  const pendingByGeminiId = new Map();
  const pendingAll = [];

  function takePendingId(name, geminiId) {
    // 1) exact match by upstream Gemini functionCall.id
    if (geminiId && pendingByGeminiId.has(geminiId)) {
      const id = pendingByGeminiId.get(geminiId);
      pendingByGeminiId.delete(geminiId);
      const arr = pendingByName.get(name);
      if (arr) {
        const idx = arr.indexOf(id);
        if (idx >= 0) arr.splice(idx, 1);
      }
      const allIdx = pendingAll.indexOf(id);
      if (allIdx >= 0) pendingAll.splice(allIdx, 1);
      return id;
    }
    // 2) match by function name (FIFO)
    if (name && pendingByName.has(name)) {
      const arr = pendingByName.get(name);
      if (arr && arr.length) {
        const id = arr.shift();
        const allIdx = pendingAll.indexOf(id);
        if (allIdx >= 0) pendingAll.splice(allIdx, 1);
        return id;
      }
    }
    // 3) fallback: take oldest pending call
    if (pendingAll.length) {
      const id = pendingAll.shift();
      for (const [, arr] of pendingByName) {
        const idx = arr.indexOf(id);
        if (idx >= 0) { arr.splice(idx, 1); break; }
      }
      return id;
    }
    return null;
  }

  function flushPendingAsStubs(targetMessages) {
    // If there are still-open tool_calls with no responses before a non-tool
    // message, insert stub tool messages to keep the sequence valid upstream.
    if (!pendingAll.length) return;
    for (const callId of pendingAll) {
      targetMessages.push({
        role: "tool",
        tool_call_id: callId,
        content: JSON.stringify({ note: "no response provided" })
      });
    }
    pendingAll.length = 0;
    pendingByName.clear();
    pendingByGeminiId.clear();
  }

  for (const content of asArray(geminiReq.contents)) {
    const role = geminiRoleToOpenAI(content?.role || "user");
    const mediaContents = [];
    const toolCalls = [];
    const functionResponses = [];

    // Track per-turn thought_signature carriers from incoming Gemini parts:
    //   - thinking part (`thought: true`) => assistant message.signature + reasoning_content
    //   - functionCall part => tool_calls[*].signature
    let assistantSignature = null;
    let assistantReasoning = "";

    for (const part of asArray(content?.parts)) {
      if (part == null) continue;
      // Gemini "thinking" part: { thought: true, text?, thoughtSignature? }
      if (part.thought === true || part.thoughtSignature || part.thought_signature) {
        const sig = part.thoughtSignature || part.thought_signature;
        if (sig) assistantSignature = sig;
        if (typeof part.text === "string" && part.text) {
          assistantReasoning += (assistantReasoning ? "\n" : "") + part.text;
        }
        // do not also push as plain text below
        if (part.thought === true) continue;
      }
      if (typeof part.text === "string" && part.text !== "") {
        mediaContents.push({ type: "text", text: part.text });
      } else if (part.inlineData || part.inline_data) {
        const inl = part.inlineData || part.inline_data;
        mediaContents.push({
          type: "image_url",
          image_url: {
            url: `data:${inl.mimeType || inl.mime_type || "application/octet-stream"};base64,${inl.data || ""}`,
            detail: "auto"
          }
        });
      } else if (part.fileData || part.file_data) {
        const fd = part.fileData || part.file_data;
        mediaContents.push({
          type: "image_url",
          image_url: { url: fd.fileUri || fd.file_uri || "", detail: "auto" }
        });
      } else if (part.functionCall || part.function_call) {
        const fc = part.functionCall || part.function_call;
        toolCallCounter += 1;
        const callId = `call_${toolCallCounter}`;
        if (fc.name) {
          if (!pendingByName.has(fc.name)) pendingByName.set(fc.name, []);
          pendingByName.get(fc.name).push(callId);
        }
        if (fc.id) pendingByGeminiId.set(fc.id, callId);
        pendingAll.push(callId);
        const tcEntry = {
          id: callId,
          type: "function",
          function: {
            name: fc.name,
            arguments: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args ?? {})
          }
        };
        // Gemini thought_signature on a functionCall part => OpenAI tool_calls[*].signature
        const fcSig = fc.thoughtSignature || fc.thought_signature || part.thoughtSignature || part.thought_signature;
        if (fcSig) tcEntry.signature = fcSig;
        toolCalls.push(tcEntry);
      } else if (part.functionResponse || part.function_response) {
        const fr = part.functionResponse || part.function_response;
        functionResponses.push({
          name: fr.name,
          geminiId: fr.id,
          content: typeof fr.response === "string" ? fr.response : JSON.stringify(fr.response ?? {})
        });
      }
    }

    if (toolCalls.length) {
      const assistantMsg = { role: "assistant", content: null, tool_calls: toolCalls };
      if (assistantSignature) assistantMsg.signature = assistantSignature;
      if (assistantReasoning) assistantMsg.reasoning_content = assistantReasoning;
      messages.push(assistantMsg);
    }

    // Emit tool-role messages for each function response; pair via takePendingId
    for (const fr of functionResponses) {
      const pairedId = takePendingId(fr.name, fr.geminiId) || `call_${toolCallCounter || 1}`;
      messages.push({
        role: "tool",
        tool_call_id: pairedId,
        name: fr.name,
        content: fr.content
      });
    }

    if (toolCalls.length) continue;

    // Before emitting any non-tool message, ensure we don't leave dangling tool_calls
    if (mediaContents.length > 0) {
      flushPendingAsStubs(messages);
    }

    if (mediaContents.length === 0) continue;
    if (mediaContents.length === 1 && mediaContents[0].type === "text") {
      const m = { role, content: mediaContents[0].text };
      if (role === "assistant" && assistantSignature) m.signature = assistantSignature;
      if (role === "assistant" && assistantReasoning) m.reasoning_content = assistantReasoning;
      messages.push(m);
    } else {
      const m = { role, content: mediaContents };
      if (role === "assistant" && assistantSignature) m.signature = assistantSignature;
      if (role === "assistant" && assistantReasoning) m.reasoning_content = assistantReasoning;
      messages.push(m);
    }
  }

  const gc = geminiReq.generationConfig || geminiReq.generation_config || {};
  const openaiReq = {
    model: modelName,
    messages
  };

  if (typeof gc.temperature === "number") openaiReq.temperature = gc.temperature;
  if (typeof gc.topP === "number") openaiReq.top_p = gc.topP;
  else if (typeof gc.top_p === "number") openaiReq.top_p = gc.top_p;
  const maxTokens = gc.maxOutputTokens ?? gc.max_output_tokens;
  if (typeof maxTokens === "number" && maxTokens > 0) openaiReq.max_tokens = maxTokens;
  const stopSeq = gc.stopSequences ?? gc.stop_sequences;
  if (Array.isArray(stopSeq) && stopSeq.length) openaiReq.stop = stopSeq.slice(0, 4);
  const n = gc.candidateCount ?? gc.candidate_count;
  if (typeof n === "number" && n > 0) openaiReq.n = n;
  if (typeof gc.seed === "number") openaiReq.seed = gc.seed;
  if (typeof gc.presencePenalty === "number") openaiReq.presence_penalty = gc.presencePenalty;
  if (typeof gc.frequencyPenalty === "number") openaiReq.frequency_penalty = gc.frequencyPenalty;
  if (typeof gc.responseMimeType === "string" && gc.responseMimeType.includes("json")) {
    openaiReq.response_format = { type: "json_object" };
  }

  // thinkingConfig (Gemini) -> thinking (ModelHub Chat extension)
  const thinkingCfg = gc.thinkingConfig || gc.thinking_config;
  if (thinkingCfg && typeof thinkingCfg === "object") {
    const thinking = {};
    const budget = thinkingCfg.thinkingBudget ?? thinkingCfg.thinking_budget;
    if (typeof budget === "number") thinking.budget_tokens = budget;
    if (thinkingCfg.includeThoughts === true || thinkingCfg.include_thoughts === true) {
      thinking.include_thoughts = true;
    }
    if (Object.keys(thinking).length) openaiReq.thinking = thinking;
  }

  // Tools: flatten functionDeclarations
  const tools = [];
  const rawTools = geminiReq.tools;
  const toolsArr = Array.isArray(rawTools) ? rawTools : rawTools ? [rawTools] : [];
  for (const t of toolsArr) {
    if (!t || typeof t !== "object") continue;
    const fds = t.functionDeclarations || t.function_declarations;
    if (Array.isArray(fds)) {
      for (const fn of fds) {
        if (!fn || !fn.name) continue;
        tools.push({
          type: "function",
          function: {
            name: fn.name,
            description: fn.description || "",
            parameters: cleanToolParameters(
              fn.parameters ||
              fn.parametersJsonSchema ||
              fn.parameters_json_schema ||
              { type: "object", properties: {} }
            )
          }
        });
      }
    }
  }
  if (tools.length) openaiReq.tools = tools;

  // tool_choice mapping from toolConfig.functionCallingConfig
  const tc = geminiReq.toolConfig || geminiReq.tool_config;
  if (tc && tc.functionCallingConfig) {
    const fcc = tc.functionCallingConfig;
    const mode = (fcc.mode || "").toUpperCase();
    const allowed = Array.isArray(fcc.allowedFunctionNames || fcc.allowed_function_names)
      ? (fcc.allowedFunctionNames || fcc.allowed_function_names)
      : [];
    if (mode === "AUTO") openaiReq.tool_choice = "auto";
    else if (mode === "NONE") openaiReq.tool_choice = "none";
    else if (mode === "ANY") {
      if (allowed.length === 1) {
        openaiReq.tool_choice = { type: "function", function: { name: allowed[0] } };
      } else {
        openaiReq.tool_choice = "required";
      }
    }
  }

  return openaiReq;
}

function openAIFinishReasonToGemini(reason) {
  switch (reason) {
    case "stop":
    case "tool_calls":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return reason ? "STOP" : null;
  }
}

function openaiUsageToGeminiUsage(usage) {
  if (!usage) return { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? (prompt + completion);
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: completion,
    totalTokenCount: total
  };
}

// Convert OpenAI chat/completions non-stream response to Gemini v1beta response
function openAIChatResponseToGemini(openaiResp) {
  const candidates = [];
  for (const choice of asArray(openaiResp?.choices)) {
    const parts = [];
    const msg = choice?.message || {};
    // Surface reasoning_content as a Gemini "thought" part. The thought_signature
    // (if upstream returned one at the message level) is attached to it so that
    // a downstream Gemini CLI re-sends it next turn.
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
    const msgSig = msg.signature || msg.thought_signature || msg.thoughtSignature || null;
    if (reasoning || msgSig) {
      const thoughtPart = { thought: true };
      if (reasoning) thoughtPart.text = reasoning;
      if (msgSig) thoughtPart.thoughtSignature = msgSig;
      parts.push(thoughtPart);
    }
    const toolCalls = asArray(msg.tool_calls);
    if (toolCalls.length) {
      for (const tc of toolCalls) {
        const fn = tc?.function || {};
        let args = {};
        if (typeof fn.arguments === "string" && fn.arguments) {
          try { args = JSON.parse(fn.arguments); } catch { args = { arguments: fn.arguments }; }
        } else if (fn.arguments && typeof fn.arguments === "object") {
          args = fn.arguments;
        }
        const fcPart = { functionCall: { name: fn.name, args } };
        const tcSig = tc?.signature || tc?.thought_signature || tc?.thoughtSignature;
        if (tcSig) fcPart.functionCall.thoughtSignature = tcSig;
        parts.push(fcPart);
      }
    } else if (typeof msg.content === "string" && msg.content) {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p?.type === "text" && p.text) parts.push({ text: p.text });
      }
    }

    candidates.push({
      content: { role: "model", parts },
      finishReason: openAIFinishReasonToGemini(choice?.finish_reason) || "STOP",
      index: choice?.index ?? 0,
      safetyRatings: []
    });
  }

  return {
    candidates,
    usageMetadata: openaiUsageToGeminiUsage(openaiResp?.usage),
    modelVersion: openaiResp?.model
  };
}

// Convert a single OpenAI chat.completion.chunk delta to a Gemini stream chunk (or null to skip).
// NOTE: tool_calls deltas are handled separately at the caller because arguments are streamed
// as incremental JSON fragments that must be accumulated across chunks before parsing.
function openAIStreamChunkToGemini(chunk) {
  if (!chunk || !Array.isArray(chunk.choices)) return null;

  const candidates = [];
  let hasContent = false;
  let hasFinish = false;

  for (const choice of chunk.choices) {
    const delta = choice?.delta || {};
    const parts = [];

    if (typeof delta.content === "string" && delta.content !== "") {
      parts.push({ text: delta.content });
      hasContent = true;
    }

    const candidate = {
      content: { role: "model", parts },
      index: choice?.index ?? 0,
      safetyRatings: []
    };
    if (choice?.finish_reason) {
      // For tool_calls finish, emit candidate without finishReason here; caller will emit
      // the final functionCall chunk with its own finishReason=STOP.
      if (choice.finish_reason !== "tool_calls") {
        candidate.finishReason = openAIFinishReasonToGemini(choice.finish_reason) || "STOP";
        hasFinish = true;
      }
    }
    candidates.push(candidate);
  }

  if (!hasContent && !hasFinish && !chunk.usage) return null;

  const out = { candidates };
  if (chunk.usage) out.usageMetadata = openaiUsageToGeminiUsage(chunk.usage);
  if (chunk.model) out.modelVersion = chunk.model;
  return out;
}

// Extract { model, action } from "/v1beta/models/{model}:{action}" style path
function parseGeminiPath(rawPath) {
  // strip leading slash
  const p = String(rawPath || "").replace(/^\/+/, "");
  const colonIdx = p.lastIndexOf(":");
  if (colonIdx === -1) return { model: p, action: null };
  return {
    model: p.slice(0, colonIdx),
    action: p.slice(colonIdx + 1)
  };
}

app.addHook("preHandler", verifyClientAuth);

app.get("/health", async () => ({ ok: true }));

app.get("/v1/models", async req => {
  if (hasAnthropicApiKey(req.headers)) return buildAnthropicModelsResponse();
  if (hasBearerAuth(req.headers)) return buildOpenAIModelsResponse();
  return buildOpenAIModelsResponse();
});

app.post("/v1/responses/compact", (req, reply) => forwardCompact(req, reply, "responses/compact"));
app.post("/v1/compact", (req, reply) => forwardCompact(req, reply, "compact"));

app.get("/v1/responses/:id", async (req, reply) => {
  const entry = store.get(req.params.id);
  if (!entry) {
    reply.code(404);
    return { error: { message: "response not found", type: "invalid_request_error" } };
  }
  return entry.response;
});

app.post("/v1/responses", async (req, reply) => {
  const body = req.body || {};
  const t0 = Date.now();
  const ip = clientIp(req);
  const tl = extractThinkingLevel(body);

  let target;
  try {
    target = resolveModel(body.model);
  } catch (err) {
    requestLog("RESP", { model: body.model, ip, status: err?.statusCode || 500, t0, error: err?.message, thinkingLevel: tl });
    return handleResolveError(err, reply);
  }

  if (!target.api.includes("responses")) {
    requestLog("RESP", { model: body.model, providerId: target.providerId, ip, status: 501, t0, error: "api=responses not supported", thinkingLevel: tl });
    reply.code(501);
    return { error: { type: "not_implemented", message: "/v1/responses requires a provider with api=responses" } };
  }

  const conversationKey = getConversationKey(body.previous_response_id, body.input);
  const sessionId = extractSessionId(body, req.headers) || getSessionIdForConversation(conversationKey);
  const history = mergeHistory(body.previous_response_id, body.input);

  // Only flatten/clean tools for Gemini models; DeepSeek expects nested format
  const isGemini = /gemini/i.test(target.upstreamName);
  const respTools = isGemini ? translateTools(body.tools) : body.tools;

  const upstreamBody = {
    model: target.upstreamName,
    input: history,
    stream: false,
    reasoning: body.reasoning,
    temperature: body.temperature,
    top_p: body.top_p,
    max_output_tokens: body.max_output_tokens,
    tool_choice: simplifyToolChoice(body.tool_choice, respTools),
    tools: respTools
  };

  Object.keys(upstreamBody).forEach(k => upstreamBody[k] === undefined && delete upstreamBody[k]);
  mergeParams(upstreamBody, target.params);

  if (body.stream) {
    const result = await proxyModelHubStream({ ...upstreamBody, input: history }, reply, sessionId, conversationKey, body, target);
    requestLog("RESP", { model: body.model, providerId: target.providerId, ip, status: result.status ?? 200, t0, usage: result.usage, error: result.error, sessionId, thinkingLevel: tl });
    return result.reply;
  }

  const upstream = await callUpstream(upstreamBody, sessionId, target);
  if (!upstream.ok) {
    logTrajectoryError({
      endpoint: "/v1/responses",
      conversationKey,
      sessionId,
      clientRequest: body,
      upstreamRequest: upstreamBody,
      upstreamResponse: upstream.json ?? upstream.text,
      clientResponse: upstream.json ?? upstream.text,
      status: upstream.status,
      model: body?.model,
      durationMs: Date.now() - t0,
      error: upstream.json
    });
    requestLog("RESP", { model: body.model, providerId: target.providerId, ip, status: upstream.status, t0, error: upstream.json, sessionId, thinkingLevel: tl });
    reply.code(upstream.status);
    return upstream.json;
  }

  const openaiResp = makeOpenAIResponse(body, upstream.json);
  saveResponse(openaiResp.id, history, upstream.json, openaiResp, conversationKey);
  logTrajectory({
    endpoint: "/v1/responses",
    conversationKey,
    sessionId,
    clientRequest: body,
    upstreamRequest: upstreamBody,
    upstreamResponse: upstream.json,
    clientResponse: openaiResp,
    status: 200,
    model: body?.model,
    usage: upstream.json?.usage,
    durationMs: Date.now() - t0
  });
  requestLog("RESP", { model: body.model, providerId: target.providerId, ip, status: 200, t0, usage: upstream.json?.usage, sessionId, thinkingLevel: tl });
  return openaiResp;
});

app.post("/v1/chat/completions", async (req, reply) => {
  const body = req.body || {};
  const t0 = Date.now();
  const ip = clientIp(req);
  const tl = extractThinkingLevel(body);

  let target;
  try {
    target = resolveModel(body.model);
  } catch (err) {
    requestLog("CHAT", { model: body.model, ip, status: err?.statusCode || 500, t0, error: err?.message, thinkingLevel: tl });
    return handleResolveError(err, reply);
  }

  if (!target.api.includes("chat") && !target.api.includes("responses")) {
    requestLog("CHAT", { model: body.model, providerId: target.providerId, ip, status: 501, t0, error: "api=chat not supported", thinkingLevel: tl });
    reply.code(501);
    return { error: { type: "not_implemented", message: "/v1/chat/completions cannot route to provider with api=messages only" } };
  }

  const conversationKey = buildConversationKey("openai", body.messages);
  const sessionId = extractSessionId(body, req.headers) || getSessionIdForConversation(conversationKey);

  // Only clean tools (strip $schema, inline $ref) for Gemini models
  const isGemini = /gemini/i.test(target.upstreamName);
  const chatTools = isGemini ? translateTools(body.tools) : body.tools;

  if (target.api.includes("chat")) {
    const passBody = { ...body, model: target.upstreamName, tools: chatTools };
    mergeParams(passBody, target.params);
    if (body.stream) {
      const result = await proxyStreamPassthrough(passBody, sessionId, target, reply, "chat", {
        endpoint: "/v1/chat/completions",
        conversationKey,
        request: body
      });
      requestLog("CHAT", { model: body.model, providerId: target.providerId, ip, status: result.status ?? 200, t0, usage: result.usage, error: result.error, sessionId, thinkingLevel: tl });
      return result.reply;
    }
    const result = await passthroughNonStream(passBody, sessionId, target, reply, "chat", {
      endpoint: "/v1/chat/completions",
      conversationKey,
      request: body
    });
    requestLog("CHAT", { model: body.model, providerId: target.providerId, ip, status: result.status ?? 200, t0, usage: result.usage, error: result.error, sessionId, thinkingLevel: tl });
    return result.reply;
  }

  // target.api === "responses" -> translate
  const translatedTools = translateTools(body.tools);
  const upstreamBody = {
    model: target.upstreamName,
    input: openAIChatMessagesToInput(body.messages),
    stream: false,
    reasoning: body.reasoning,
    temperature: body.temperature,
    top_p: body.top_p,
    max_output_tokens: body.max_tokens,
    tools: translatedTools,
    tool_choice: simplifyToolChoice(body.tool_choice, translatedTools)
  };

  Object.keys(upstreamBody).forEach(k => upstreamBody[k] === undefined && delete upstreamBody[k]);
  mergeParams(upstreamBody, target.params);

  const upstream = await callUpstream(upstreamBody, sessionId, target);
  if (!upstream.ok) {
    logTrajectoryError({
      endpoint: "/v1/chat/completions",
      conversationKey,
      sessionId,
      clientRequest: body,
      upstreamRequest: upstreamBody,
      upstreamResponse: upstream.json ?? upstream.text,
      clientResponse: upstream.json ?? upstream.text,
      status: upstream.status,
      model: body?.model,
      durationMs: Date.now() - t0,
      error: upstream.json
    });
    requestLog("CHAT", { model: body.model, providerId: target.providerId, ip, status: upstream.status, t0, error: upstream.json, sessionId, thinkingLevel: tl });
    reply.code(upstream.status);
    return upstream.json;
  }

  const responseText = extractOutputText(upstream.json);
  const toolCalls = convertOutput(upstream.json)
    .filter(x => x.type === "function_call")
    .map(fc => ({
      id: fc.call_id || fc.id,
      type: "function",
      function: { name: fc.name, arguments: fc.arguments }
    }));

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const finishReason = toolCalls.length ? "tool_calls" : "stop";

  const chatResp = {
    id,
    object: "chat.completion",
    created: now(),
    model: body.model,
    choices: [{
      index: 0,
      message: toolCalls.length
        ? { role: "assistant", content: null, tool_calls: toolCalls }
        : { role: "assistant", content: responseText },
      finish_reason: finishReason
    }],
    usage: upstream.json.usage || null
  };

  logTrajectory({
    endpoint: "/v1/chat/completions",
    conversationKey,
    sessionId,
    clientRequest: body,
    upstreamRequest: upstreamBody,
    upstreamResponse: upstream.json,
    clientResponse: chatResp,
    status: 200,
    model: body?.model,
    usage: upstream.json?.usage,
    durationMs: Date.now() - t0
  });

  if (body.stream) {
    setSseHeaders(reply);

    sse(reply, null, chatCompletionChunk(id, body.model, { role: "assistant" }));

    if (toolCalls.length) {
      toolCalls.forEach((tc, index) => {
        sse(reply, null, chatCompletionChunk(id, body.model, {
          tool_calls: [{ index, id: tc.id, type: "function", function: tc.function }]
        }));
      });
    } else {
      for (const chunk of chunkText(responseText)) {
        sse(reply, null, chatCompletionChunk(id, body.model, { content: chunk }));
      }
    }

    sse(reply, null, chatCompletionChunk(id, body.model, {}, finishReason));
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    requestLog("CHAT", { model: body.model, providerId: target.providerId, ip, status: 200, t0, usage: upstream.json?.usage, sessionId, thinkingLevel: tl });
    return reply;
  }

  requestLog("CHAT", { model: body.model, providerId: target.providerId, ip, status: 200, t0, usage: upstream.json?.usage, sessionId, thinkingLevel: tl });
  return chatResp;
});

app.post("/v1/messages", async (req, reply) => {
  const body = req.body || {};
  const t0 = Date.now();
  const ip = clientIp(req);
  const tl = extractThinkingLevel(body);

  let target;
  try {
    target = resolveModel(body.model);
  } catch (err) {
    requestLog("MSGS", { model: body.model, ip, status: err?.statusCode || 500, t0, error: err?.message, thinkingLevel: tl });
    return handleResolveError(err, reply);
  }

  if (!target.api.includes("messages") && !target.api.includes("responses")) {
    requestLog("MSGS", { model: body.model, providerId: target.providerId, ip, status: 501, t0, error: "/v1/messages cannot route to provider with api=chat only", thinkingLevel: tl });
    reply.code(501);
    return { error: { type: "not_implemented", message: "/v1/messages cannot route to provider with api=chat only" } };
  }

  const conversationKey = buildConversationKey("anthropic", body.messages);
  const sessionId = extractSessionId(body, req.headers) || getSessionIdForConversation(conversationKey);

  if (target.api.includes("messages")) {
    const passBody = { ...body, model: target.upstreamName };
    sanitizeMetadataForUpstream(passBody);
    mergeParams(passBody, target.params);
    if (body.stream) {
      const result = await proxyStreamPassthrough(passBody, sessionId, target, reply, "messages", {
        endpoint: "/v1/messages",
        conversationKey,
        request: body
      });
      requestLog("MSGS", { model: body.model, providerId: target.providerId, ip, status: result.status ?? 200, t0, usage: result.usage, error: result.error, sessionId, thinkingLevel: tl });
      return result.reply;
    }
    const result = await passthroughNonStream(passBody, sessionId, target, reply, "messages", {
      endpoint: "/v1/messages",
      conversationKey,
      request: body
    });
    requestLog("MSGS", { model: body.model, providerId: target.providerId, ip, status: result.status ?? 200, t0, usage: result.usage, error: result.error, sessionId, thinkingLevel: tl });
    return result.reply;
  }

  // target.api === "responses" -> translate Anthropic to Responses
  const input = anthropicMessagesToInput(body);
  const translatedTools = anthropicToolsToOpenAITools(body.tools);
  const upstreamBody = {
    model: target.upstreamName,
    input,
    stream: false,
    reasoning: mapAnthropicThinking(body.thinking),
    temperature: body.temperature,
    top_p: body.top_p,
    max_output_tokens: body.max_tokens,
    tools: translatedTools,
    tool_choice: mapAnthropicToolChoice(body.tool_choice, translatedTools)
  };

  Object.keys(upstreamBody).forEach(k => upstreamBody[k] === undefined && delete upstreamBody[k]);
  mergeParams(upstreamBody, target.params);

  if (body.stream) {
    setSseHeaders(reply);

    let startedBlocks = new Set();
    let outputIndexToContentIndex = new Map();
    let nextContentIndex = 0;
    let completedResponse = null;

    let messageStarted = false;

    const { resp, errorText } = await streamUpstream(upstreamBody, sessionId, ({ payload }) => {
      if (!payload) return;

      if (payload.type === "response.created") {
        messageStarted = true;
        sse(reply, "message_start", {
          type: "message_start",
          message: {
            id: payload.response?.id || rid("msg"),
            type: "message",
            role: "assistant",
            model: body.model || payload.response?.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
        return;
      }

      if (payload.type === "response.output_item.added") {
        const item = payload.item || {};
        const contentIndex = nextContentIndex++;
        outputIndexToContentIndex.set(payload.output_index, contentIndex);

        if (item.type === "reasoning") {
          startedBlocks.add(contentIndex);
          sse(reply, "content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "thinking", thinking: "", signature: item.id || rid("sig") }
          });
          return;
        }

        if (item.type === "message") {
          startedBlocks.add(contentIndex);
          sse(reply, "content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" }
          });
          return;
        }

        if (item.type === "function_call") {
          startedBlocks.add(contentIndex);
          sse(reply, "content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "tool_use", id: item.call_id || item.id, name: item.name, input: {} }
          });
        }
        return;
      }

      if (payload.type === "response.reasoning.delta") {
        const contentIndex = outputIndexToContentIndex.get(payload.output_index);
        if (contentIndex != null) {
          sse(reply, "content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "thinking_delta", thinking: payload.delta || "" }
          });
        }
        return;
      }

      if (payload.type === "response.output_text.delta") {
        const contentIndex = outputIndexToContentIndex.get(payload.output_index);
        if (contentIndex != null) {
          sse(reply, "content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: payload.delta || "" }
          });
        }
        return;
      }

      if (payload.type === "response.function_call_arguments.delta") {
        const contentIndex = outputIndexToContentIndex.get(payload.output_index);
        if (contentIndex != null) {
          sse(reply, "content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "input_json_delta", partial_json: payload.delta || "" }
          });
        }
        return;
      }

      if (payload.type === "response.output_item.done") {
        const contentIndex = outputIndexToContentIndex.get(payload.output_index);
        if (contentIndex != null && startedBlocks.has(contentIndex)) {
          sse(reply, "content_block_stop", { type: "content_block_stop", index: contentIndex });
          startedBlocks.delete(contentIndex);
        }
        return;
      }

      if (payload.type === "response.completed") {
        completedResponse = payload.response || null;
        const finalMessage = makeAnthropicMessage(body, completedResponse || {});

        sse(reply, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: finalMessage.stop_reason, stop_sequence: null },
          usage: finalMessage.usage
        });
        sse(reply, "message_stop", { type: "message_stop" });
      }
    }, target);

    if (!resp.ok) {
      logTrajectoryError({
        endpoint: "/v1/messages:stream",
        conversationKey,
        sessionId,
        clientRequest: body,
        upstreamRequest: upstreamBody,
        upstreamResponse: errorText,
        clientResponse: errorText,
        status: resp.status,
        model: body?.model,
        durationMs: Date.now() - t0,
        error: errorText
      });
      if (!messageStarted) {
        sse(reply, "error", makeStreamErrorPayload(resp.status, errorText, null));
      } else {
        sse(reply, "error", makeStreamErrorPayload(resp.status, errorText, null));
        sse(reply, "message_stop", { type: "message_stop" });
      }
      reply.raw.end();
      requestLog("MSGS", { model: body.model, providerId: target.providerId, ip, status: resp.status, t0, error: errorText, sessionId, thinkingLevel: tl });
      return reply;
    }

    if (completedResponse) {
      logTrajectory({
        endpoint: "/v1/messages:stream",
        conversationKey,
        sessionId,
        clientRequest: body,
        upstreamRequest: upstreamBody,
        upstreamResponse: completedResponse,
        clientResponse: makeAnthropicMessage(body, completedResponse),
        status: 200,
        model: body?.model,
        usage: completedResponse?.usage,
        durationMs: Date.now() - t0
      });
    }

    reply.raw.end();
    requestLog("MSGS", { model: body.model, providerId: target.providerId, ip, status: 200, t0, usage: completedResponse?.usage, sessionId, thinkingLevel: tl });
    return reply;
  }

  const upstream = await callUpstream(upstreamBody, sessionId, target);
  if (!upstream.ok) {
    logTrajectoryError({
      endpoint: "/v1/messages",
      conversationKey,
      sessionId,
      clientRequest: body,
      upstreamRequest: upstreamBody,
      upstreamResponse: upstream.json ?? upstream.text,
      clientResponse: upstream.json ?? upstream.text,
      status: upstream.status,
      model: body?.model,
      durationMs: Date.now() - t0,
      error: upstream.json
    });
    requestLog("MSGS", { model: body.model, providerId: target.providerId, ip, status: upstream.status, t0, error: upstream.json, sessionId, thinkingLevel: tl });
    reply.code(upstream.status);
    return upstream.json;
  }

  const anthropicResp = makeAnthropicMessage(body, upstream.json);
  logTrajectory({
    endpoint: "/v1/messages",
    conversationKey,
    sessionId,
    clientRequest: body,
    upstreamRequest: upstreamBody,
    upstreamResponse: upstream.json,
    clientResponse: anthropicResp,
    status: 200,
    model: body?.model,
    usage: upstream.json?.usage,
    durationMs: Date.now() - t0
  });
  requestLog("MSGS", { model: body.model, providerId: target.providerId, ip, status: 200, t0, usage: upstream.json?.usage, sessionId, thinkingLevel: tl });
  return anthropicResp;
});

// ── Gemini v1beta native endpoint (accepts Gemini CLI format, routes to OpenAI chat upstream) ──
// Supports: /v1beta/models/{model}:generateContent, :streamGenerateContent, :countTokens
app.post("/v1beta/models/*", async (req, reply) => {
  const t0 = Date.now();
  const ip = clientIp(req);

  // Fastify stores wildcard match in req.params["*"]
  const rawPath = req.params?.["*"] || "";
  const { model: requestedModel, action } = parseGeminiPath(rawPath);

  if (!requestedModel) {
    reply.code(400);
    return { error: { code: 400, message: "model is required in URL", status: "INVALID_ARGUMENT" } };
  }

  const body = req.body || {};
  const isStream = action === "streamGenerateContent" || req.query?.alt === "sse";
  const tl = extractThinkingLevel(body);

  // countTokens: best-effort simple estimate based on chars
  if (action === "countTokens") {
    let totalText = "";
    for (const c of asArray(body.contents)) {
      for (const p of asArray(c?.parts)) {
        if (typeof p?.text === "string") totalText += p.text;
      }
    }
    if (body.systemInstruction) {
      totalText += extractTextFromGeminiParts(body.systemInstruction.parts);
    }
    const approx = Math.ceil(totalText.length / 4);
    requestLog("GEMN", { model: requestedModel, ip, status: 200, t0, thinkingLevel: tl });
    return { totalTokens: approx };
  }

  if (action !== "generateContent" && action !== "streamGenerateContent") {
    reply.code(400);
    return {
      error: {
        code: 400,
        message: `unsupported gemini action: ${action || "(none)"}`,
        status: "INVALID_ARGUMENT"
      }
    };
  }

  let target;
  try {
    target = resolveModel(requestedModel);
  } catch (err) {
    requestLog("GEMN", { model: requestedModel, ip, status: err?.statusCode || 500, t0, error: err?.message, thinkingLevel: tl });
    const status = err?.statusCode || 500;
    reply.code(status);
    return { error: { code: status, message: err?.message || "resolve model failed", status: "INVALID_ARGUMENT" } };
  }

  if (!target.api.includes("chat") && !target.api.includes("responses")) {
    requestLog("GEMN", { model: requestedModel, providerId: target.providerId, ip, status: 501, t0, error: "no chat/responses api", thinkingLevel: tl });
    reply.code(501);
    return {
      error: {
        code: 501,
        message: "/v1beta/models requires provider with api=chat (or responses)",
        status: "UNIMPLEMENTED"
      }
    };
  }

  // Convert Gemini request -> OpenAI chat/completions request
  const openaiBody = geminiRequestToOpenAIChat(body, target.upstreamName);
  if (!openaiBody.messages || openaiBody.messages.length === 0) {
    reply.code(400);
    return { error: { code: 400, message: "contents is required", status: "INVALID_ARGUMENT" } };
  }

  // Note: translateTools is for OpenAI Responses-format tools (flat name);
  // Gemini conversion already produces chat-format tools ({type:"function", function:{...}}),
  // which is what modelhub /v1/chat/completions expects. Do not re-translate.

  mergeParams(openaiBody, target.params);

  const conversationKey = buildConversationKey("gemini", openaiBody.messages);
  const sessionId = extractSessionId(body, req.headers) || getSessionIdForConversation(conversationKey);

  // Only chat api path is supported for Gemini conversion (modelhub completions)
  const apiOverride = target.api.includes("chat") ? "chat" : null;
  if (!apiOverride) {
    reply.code(501);
    return { error: { code: 501, message: "gemini conversion requires api=chat", status: "UNIMPLEMENTED" } };
  }

  if (!isStream) {
    let resp;
    try {
      resp = await fetch(upstreamUrl(target, apiOverride), {
        method: "POST",
        headers: upstreamHeaders(target, sessionId, apiOverride),
        body: JSON.stringify(openaiBody),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      const message = err?.name === "TimeoutError" ? `upstream request timed out after ${TIMEOUT_MS / 1000}s` : (err?.message || "upstream fetch failed");
      requestLog("GEMN", { model: requestedModel, providerId: target.providerId, ip, status: 502, t0, error: message, sessionId, thinkingLevel: tl });
      reply.code(502);
      return { error: { code: 502, message, status: "UNAVAILABLE" } };
    }

    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    if (!resp.ok) {
      logTrajectoryError({
        endpoint: "/v1beta/models:generateContent",
        conversationKey,
        sessionId,
        clientRequest: body,
        upstreamRequest: openaiBody,
        upstreamResponse: parsed ?? text,
        clientResponse: parsed ?? text,
        status: resp.status,
        model: requestedModel,
        durationMs: Date.now() - t0,
        error: parsed ?? text
      });
      requestLog("GEMN", { model: requestedModel, providerId: target.providerId, ip, status: resp.status, t0, error: parsed ?? text, sessionId, thinkingLevel: tl });
      reply.code(resp.status);
      return {
        error: {
          code: resp.status,
          message: parsed?.error?.message || text || "upstream error",
          status: "UNKNOWN"
        }
      };
    }

    const geminiResp = openAIChatResponseToGemini(parsed || {});
    logTrajectory({
      endpoint: "/v1beta/models:generateContent",
      conversationKey,
      sessionId,
      clientRequest: body,
      upstreamRequest: openaiBody,
      upstreamResponse: parsed ?? text,
      clientResponse: geminiResp,
      status: 200,
      model: requestedModel,
      usage: parsed?.usage,
      durationMs: Date.now() - t0
    });
    requestLog("GEMN", { model: requestedModel, providerId: target.providerId, ip, status: 200, t0, usage: parsed?.usage, sessionId, thinkingLevel: tl });
    return geminiResp;
  }

  // Streaming: upstream OpenAI SSE -> Gemini v1beta SSE (data: <json>\n\n)
  let resp;
  try {
    resp = await fetch(upstreamUrl(target, apiOverride), {
      method: "POST",
      headers: upstreamHeaders(target, sessionId, apiOverride),
      body: JSON.stringify({ ...openaiBody, stream: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const message = err?.name === "TimeoutError" ? `upstream request timed out after ${TIMEOUT_MS / 1000}s` : (err?.message || "upstream fetch failed");
    requestLog("GEMN", { model: requestedModel, providerId: target.providerId, ip, status: 502, t0, error: message, sessionId, thinkingLevel: tl });
    reply.code(502);
    return { error: { code: 502, message, status: "UNAVAILABLE" } };
  }

  if (!resp.ok || !resp.body) {
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    logTrajectoryError({
      endpoint: "/v1beta/models:streamGenerateContent",
      conversationKey,
      sessionId,
      clientRequest: body,
      upstreamRequest: { ...openaiBody, stream: true },
      upstreamResponse: parsed ?? text,
      clientResponse: parsed ?? text,
      status: resp.status,
      model: requestedModel,
      durationMs: Date.now() - t0,
      error: parsed ?? text
    });
    requestLog("GEMN", { model: requestedModel, providerId: target.providerId, ip, status: resp.status, t0, error: parsed ?? text, sessionId, thinkingLevel: tl });
    reply.code(resp.status);
    return {
      error: {
        code: resp.status,
        message: parsed?.error?.message || text || "upstream error",
        status: "UNKNOWN"
      }
    };
  }

  setSseHeaders(reply);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let lastUsage = null;
  let lastModel = null;
  let completedCandidates = null;
  let upstreamRawSse = "";
  let clientRawSse = "";

  // Tool-call accumulator: choiceIdx -> toolIdx -> { id, name, argsBuf }
  const toolCallsByChoice = new Map();

  function emitGeminiChunk(obj) {
    const out = `data: ${JSON.stringify(obj)}\n\n`;
    reply.raw.write(out);
    clientRawSse += out;
    if (obj.candidates) completedCandidates = obj.candidates;
  }

  function flushToolCalls(choiceIdx, finishReason) {
    const tcMap = toolCallsByChoice.get(choiceIdx);
    if (!tcMap || tcMap.size === 0) return;
    const parts = [];
    for (const tc of tcMap.values()) {
      let args = {};
      if (tc.argsBuf) {
        try { args = JSON.parse(tc.argsBuf); }
        catch { args = { arguments: tc.argsBuf }; }
      }
      const fc = { name: tc.name || "", args };
      if (tc.signature) fc.thoughtSignature = tc.signature;
      parts.push({ functionCall: fc });
    }
    toolCallsByChoice.delete(choiceIdx);
    const chunk = {
      candidates: [{
        content: { role: "model", parts },
        index: choiceIdx,
        safetyRatings: [],
        finishReason: finishReason || "STOP"
      }]
    };
    if (lastModel) chunk.modelVersion = lastModel;
    emitGeminiChunk(chunk);
  }

  function processBlock(block) {
    if (block) upstreamRawSse += block + "\n\n";
    const dataLines = block
      .split("\n")
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart());
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    if (data === "[DONE]") return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (payload?.usage) lastUsage = payload.usage;
    if (payload?.model) lastModel = payload.model;

    // Accumulate tool_calls deltas (stateful across chunks)
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        const idx = choice?.index ?? 0;
        const delta = choice?.delta || {};
        // reasoning_content delta -> emit a Gemini "thought" part chunk inline
        const reasoningDelta = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
        if (reasoningDelta) {
          const thoughtChunk = {
            candidates: [{
              content: { role: "model", parts: [{ thought: true, text: reasoningDelta }] },
              index: idx,
              safetyRatings: []
            }]
          };
          if (lastModel) thoughtChunk.modelVersion = lastModel;
          emitGeminiChunk(thoughtChunk);
        }
        // message-level signature (thought_signature for the assistant turn)
        const msgSig = delta.signature || delta.thought_signature || delta.thoughtSignature;
        if (msgSig) {
          // Stash on the first tool-call entry if any (it's tied to the same turn);
          // otherwise emit a standalone thought part with the signature so Gemini CLI
          // can preserve it in the next request.
          let attached = false;
          const byTool = toolCallsByChoice.get(idx);
          if (byTool && byTool.size) {
            const first = byTool.values().next().value;
            if (first && !first.signature) { first.signature = msgSig; attached = true; }
          }
          if (!attached) {
            const sigChunk = {
              candidates: [{
                content: { role: "model", parts: [{ thought: true, thoughtSignature: msgSig }] },
                index: idx,
                safetyRatings: []
              }]
            };
            if (lastModel) sigChunk.modelVersion = lastModel;
            emitGeminiChunk(sigChunk);
          }
        }
        const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const tc of tcs) {
          const tIdx = tc?.index ?? 0;
          let byTool = toolCallsByChoice.get(idx);
          if (!byTool) { byTool = new Map(); toolCallsByChoice.set(idx, byTool); }
          let entry = byTool.get(tIdx);
          if (!entry) { entry = { id: null, name: "", argsBuf: "", signature: null }; byTool.set(tIdx, entry); }
          if (tc.id) entry.id = tc.id;
          const fn = tc?.function || {};
          if (fn.name) entry.name = fn.name;
          if (typeof fn.arguments === "string") entry.argsBuf += fn.arguments;
          // tool_call-level signature (Gemini thought_signature attached to functionCall)
          const tcSig = tc?.signature || tc?.thought_signature || tc?.thoughtSignature;
          if (tcSig) entry.signature = tcSig;
        }
        // When finish_reason arrives for tool_calls, flush accumulated call(s)
        if (choice?.finish_reason === "tool_calls") {
          flushToolCalls(idx, "STOP");
        }
      }
    }

    // Pass through text / non-tool finish reasons
    const geminiChunk = openAIStreamChunkToGemini(payload);
    if (geminiChunk) emitGeminiChunk(geminiChunk);
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.length) sseBuffer += decoder.decode(value, { stream: true });
      const blocks = sseBuffer.split("\n\n");
      sseBuffer = blocks.pop() || "";
      for (const b of blocks) processBlock(b);
    }
    sseBuffer += decoder.decode();
    for (const b of sseBuffer.split("\n\n").filter(Boolean)) processBlock(b);
    // Flush any remaining accumulated tool calls whose finish_reason never arrived
    for (const idx of Array.from(toolCallsByChoice.keys())) {
      flushToolCalls(idx, "STOP");
    }
  } catch (err) {
    const message = err?.message || "upstream stream read failed";
    app.log.error({ err }, "gemini stream read failed");
    reply.raw.write(`data: ${JSON.stringify({ error: { code: 500, message, status: "UNKNOWN" } })}\n\n`);
    reply.raw.end();
    requestLog("GEMN", { model: requestedModel, providerId: target.providerId, ip, status: 500, t0, error: message, sessionId, thinkingLevel: tl });
    return reply;
  }

  reply.raw.end();

  logTrajectory({
    endpoint: "/v1beta/models:streamGenerateContent",
    conversationKey,
    sessionId,
    clientRequest: body,
    upstreamRequest: { ...openaiBody, stream: true },
    upstreamResponse: { kind: "sse", raw: upstreamRawSse },
    clientResponse: {
      kind: "sse",
      raw: clientRawSse,
      final: {
        candidates: completedCandidates || [],
        usageMetadata: openaiUsageToGeminiUsage(lastUsage),
        modelVersion: lastModel
      }
    },
    status: 200,
    model: requestedModel,
    usage: lastUsage,
    durationMs: Date.now() - t0
  });
  requestLog("GEMN", { model: requestedModel, providerId: target.providerId, ip, status: 200, t0, usage: lastUsage, sessionId, thinkingLevel: tl });
  return reply;
});

// Gemini models list
app.get("/v1beta/models", async () => {
  const openai = buildOpenAIModelsResponse();
  const models = (openai.data || []).map(m => ({
    name: `models/${m.id}`,
    baseModelId: m.id,
    version: "v1beta",
    displayName: m.id,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"]
  }));
  return { models };
});

app.listen({ port: PORT, host: HOST })
  .then(() => console.log(
    `[INFO] listening on http://${HOST}:${PORT} (log=${LOG_LEVEL} store=${TRAJ_DISABLED ? "off" : TRAJ_DIR_ABS ? TRAJ_DIR_ABS : "memory"} timeout=${TIMEOUT_MS / 1000}s)`
  ));
