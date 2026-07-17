"use strict";
// Real semantic memory needs real learned embeddings — there is no honest zero-dependency
// shortcut (a substring/n-gram trick is lexical, not semantic). So Foundry embeds through
// an OpenAI-compatible `/v1/embeddings` endpoint you already have: OpenAI, or a LOCAL model
// via Ollama / LM Studio (free, private, no key). Each embedding is a governed, costed call.
//
// When no provider is configured, memory falls back to lexical search and SAYS so — it
// never silently pretends a keyword match is semantic.
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

// $ per 1M tokens → micro-dollars per token. Unknown models get a small non-zero default
// so embedding spend still shows up in the ledger.
const PRICING = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-ada-002": 0.10,
};
const DEFAULT_PRICE = 0.02;

// Resolve the embeddings provider from project config (committable) + env (holds the key).
// Returns null when nothing is configured → caller falls back to lexical.
function provider(project) {
  const cfg = (project && project.embeddings) || {};
  let url = cfg.url || process.env.FOUNDRY_EMBED_URL || null;
  let model = cfg.model || process.env.FOUNDRY_EMBED_MODEL || null;
  const key = process.env.FOUNDRY_EMBED_KEY || process.env.OPENAI_API_KEY || null;
  // Convenience: a bare OPENAI_API_KEY is enough — default to OpenAI's small embedder.
  if (!url && key) { url = "https://api.openai.com/v1/embeddings"; model = model || "text-embedding-3-small"; }
  if (!url || !model) return null;
  return { url, model, key };
}

function post(urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      {
        hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search, method: "POST", family: 4, timeout: 30000,
        headers: Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr) }, headers),
      },
      (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("embeddings request timed out")));
    req.write(bodyStr);
    req.end();
  });
}

function costMicros(model, tokens) {
  const per = PRICING[model] != null ? PRICING[model] : DEFAULT_PRICE;
  return Math.max(0, Math.round((tokens || 0) * per));
}

// Embed one or more strings. OpenAI-compatible request/response, so it works unchanged
// against OpenAI and local servers (Ollama's /v1/embeddings, LM Studio, together.ai, …).
async function embed(prov, inputs) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const headers = {};
  if (prov.key) headers["authorization"] = `Bearer ${prov.key}`;
  const res = await post(prov.url, headers, JSON.stringify({ model: prov.model, input: list }));
  if (res.status === 401 || res.status === 403) { const e = new Error(`embeddings provider rejected the key (${res.status}). Set FOUNDRY_EMBED_KEY / OPENAI_API_KEY.`); e.code = "EAUTH"; throw e; }
  if (res.status >= 400) throw new Error(`embeddings provider error ${res.status}: ${res.body.slice(0, 160)}`);
  let json; try { json = JSON.parse(res.body); } catch { throw new Error("embeddings provider returned non-JSON"); }
  const data = json.data || [];
  if (!data.length || !Array.isArray(data[0].embedding)) throw new Error("embeddings provider returned no vectors");
  const tokens = (json.usage && (json.usage.total_tokens || json.usage.prompt_tokens)) || Math.ceil(list.join(" ").length / 4);
  return { vectors: data.sort((a, b) => (a.index || 0) - (b.index || 0)).map((d) => d.embedding), model: json.model || prov.model, tokens, cost_micros: costMicros(prov.model, tokens) };
}

// Cosine similarity of two equal-length vectors (−1…1). Different dims → 0 (incomparable).
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { provider, embed, cosine, costMicros, PRICING };
