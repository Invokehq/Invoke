"use strict";
// The Model adapter — a governed, OpenAI-compatible LLM proxy. Point your agent's SDK at
// http://localhost:PORT/v1 and every model call becomes an Execution (type: "model"):
// cost + tokens + latency, budget enforcement, and caching (identical request = cache hit,
// $0 — exactly-once applied to model calls). Same ledger, receipts, and trace as tools.
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const store = require("./store");
const { Ledger } = require("./ledger");
const policy = require("./policy");
const cloud = require("./cloud");

// Rough list price, USD per 1M tokens: [input, output]. Matched by substring; default is a
// conservative fallback so unknown models still get costed (never silently $0).
const PRICING = {
  "gpt-4o-mini": [0.15, 0.6], "gpt-4o": [2.5, 10], "gpt-4.1-mini": [0.4, 1.6], "gpt-4.1": [2, 8],
  "gpt-5-mini": [0.25, 2], "gpt-5": [1.25, 10], "o3-mini": [1.1, 4.4], "o3": [2, 8],
  "claude-3-5-haiku": [0.8, 4], "claude-3-5-sonnet": [3, 15], "claude-sonnet-4": [3, 15], "claude-opus-4": [15, 75],
  "gemini-1.5-flash": [0.075, 0.3], "gemini-2.0-flash": [0.1, 0.4], "gemini-1.5-pro": [1.25, 5],
  "llama": [0, 0], "qwen": [0, 0], // local models are free
};
function priceFor(model) {
  const k = Object.keys(PRICING).find((k) => model && model.includes(k));
  return PRICING[k] || [1, 3];
}
// micros = usd*1e6; usd = tokens*price_per_1M/1e6; so micros = tokens*price_per_1M.
function costMicros(model, usage) {
  const [pin, pout] = priceFor(model);
  const pt = (usage && usage.prompt_tokens) || 0;
  const ct = (usage && usage.completion_tokens) || 0;
  return Math.round(pt * pin + ct * pout);
}

function forward(upstream, key, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(upstream.replace(/\/+$/, "") + "/chat/completions");
    const mod = u.protocol === "http:" ? http : https;
    const data = JSON.stringify(body);
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(data) };
    if (key) headers.authorization = "Bearer " + key;
    const req = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname, method: "POST", family: 4, timeout: 120000, headers },
      (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("upstream model timed out")));
    req.write(data); req.end();
  });
}

async function governed(project, led, upstream, key, body, dir, hdrAgent) {
  // Attribute the call to an agent: body.metadata.agent, or an x-foundry-agent header
  // (headers survive SDKs that drop unknown body fields, e.g. LangChain's metadata).
  const agent = (body && body.metadata && body.metadata.agent) || hdrAgent || "model";
  const model = (body && body.model) || "unknown";

  // Policy gate — a model can be denied or gated (e.g. deny "gpt-5" in prod).
  const decision = policy.evaluate(policy.loadPolicies(project), model);
  if (decision.effect !== "allow") {
    const status = decision.effect === "deny" ? "denied" : "blocked";
    led.commit({ agent, tool: model, params: body, type: "model", status, result: { [status]: true, rule: decision.rule }, duration_ms: 0 });
    const err = new Error(`model '${model}' ${status} by policy rule '${decision.rule}'`);
    err.status = 403; throw err;
  }

  // Cache first: an identical request reconciles to the prior receipt — cache hit, $0.
  // A free replay is always allowed, even when the budget is spent (it costs nothing).
  const dup = led.committed(led.effectKey(agent, model, body, null));
  if (dup) {
    return { status: 200, json: dup.result, headers: { "x-foundry-cache": "hit", "x-foundry-cost-usd": "0.000000", "x-foundry-receipt": dup.receipt.number } };
  }

  // Budget: reject a NEW (would-spend) call once the model budget is exhausted.
  if (project.budget_usd) {
    const spent = led.list().filter((e) => e.type === "model").reduce((s, e) => s + (e.cost_micros || 0), 0);
    if (spent / 1e6 >= project.budget_usd) {
      const err = new Error(`model budget exceeded: $${(spent / 1e6).toFixed(4)} / $${Number(project.budget_usd).toFixed(2)}`);
      err.status = 429; throw err;
    }
  }

  const t0 = Date.now();
  const up = await forward(upstream, key, body);
  const dur = Date.now() - t0;
  let resp; try { resp = JSON.parse(up.body); } catch { resp = { raw: up.body.slice(0, 500) }; }
  if (up.status >= 400) {
    const err = new Error((resp.error && resp.error.message) || `upstream ${up.status}`);
    err.status = up.status; throw err;
  }
  const cm = costMicros(model, resp.usage);
  const eff = led.commit({ agent, tool: model, params: body, result: resp, type: "model", duration_ms: dur, cost_micros: cm });
  // Mirror to the cloud ledger so the model call shows up on the dashboard once graduated.
  // Re-read the project each call so a `foundry push` takes effect without a proxy restart.
  const link = cloud.cloudLink(store.readProject(dir));
  if (link) await cloud.mirrorEffect(link, eff).catch(() => {});
  return { status: 200, json: resp, headers: { "x-foundry-cache": "miss", "x-foundry-cost-usd": (cm / 1e6).toFixed(6), "x-foundry-receipt": eff.receipt.number } };
}

function sendJson(res, status, obj, headers) {
  res.writeHead(status, Object.assign({ "content-type": "application/json" }, headers || {}));
  res.end(JSON.stringify(obj));
}

async function serveModel(dir, opts = {}) {
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const port = Number(opts.port) || 4000;
  const upstream = opts.upstream || process.env.FOUNDRY_MODEL_UPSTREAM || "https://api.openai.com/v1";
  const key = process.env[opts.keyEnv || "OPENAI_API_KEY"] || process.env.OPENAI_API_KEY || null;

  const server = http.createServer((req, res) => {
    const path = (req.url || "").replace(/\/+$/, "");
    if (req.method === "POST" && path.endsWith("/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        let body; try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: { message: "invalid JSON body" } }); }
        try { const out = await governed(project, led, upstream, key, body, dir, req.headers["x-foundry-agent"]); sendJson(res, out.status, out.json, out.headers); }
        catch (e) { sendJson(res, e.status || 500, { error: { message: String((e && e.message) || e) } }); }
      });
    } else {
      sendJson(res, 404, { error: { message: "foundry model proxy — POST /v1/chat/completions" } });
    }
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      process.stderr.write(`[foundry model] governed proxy: http://localhost:${port}/v1  ->  ${upstream}\n`);
      process.stderr.write(`  budget: ${project.budget_usd ? "$" + Number(project.budget_usd).toFixed(2) : "none"}   ·   point your agent:  OPENAI_BASE_URL=http://localhost:${port}/v1\n`);
      process.stderr.write(`  every call is an Execution — foundry trace / foundry receipts\n`);
      resolve();
    });
  });
  await new Promise(() => {}); // run until killed
}

module.exports = { serveModel, costMicros, priceFor, governed };
