"use strict";
// The push → cloud → live-dashboard pipe.
//
// When a project is graduated to Invoke (`foundry push`), Foundry keeps executing
// locally (fast, governed, on-disk) AND mirrors each committed Execution to the durable
// cloud workspace ledger — so the Invoke dashboard shows the agents' work streaming in
// live. We mirror the *hash + metadata* (agent, action, cost, receipt), never the raw
// params: the local ledger holds the payload; the cloud gets a governed, receipted record.
//
// Best-effort by design: mirroring never throws and never blocks the agent. If the cloud
// is unreachable, local execution is unaffected and the effect still lives in the ledger.
const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");
const store = require("./store");

const DEFAULT_BASE = "https://api.invokehq.run";

// Is this project linked to a durable cloud workspace? Needs a login token + a pushed ws.
function cloudLink(project) {
  const cfg = store.readGlobalConfig();
  const token = cfg.invoke_token || process.env.INVOKE_API_KEY;
  const wsId = project && project.invoke && project.invoke.workspace;
  if (!token || !wsId) return null;
  const base = (project.invoke && project.invoke.base) || cfg.invoke_base || process.env.INVOKE_API_URL || DEFAULT_BASE;
  return { base, token, wsId };
}

function request(link, method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(link.base + path);
    const mod = u.protocol === "http:" ? http : https;
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { "X-API-Key": link.token, "user-agent": "foundry" };
    if (payload) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(payload); }
    // family:4 — some hosts advertise AAAA but have dead IPv6; force IPv4 to avoid timeouts.
    const req = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method, family: 4, timeout: 10000, headers },
      (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("cloud request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

// Agents must exist in the workspace before they can post effects. Idempotent: a repeat
// registration returns 409, which we treat as success. Cached per process so we register
// each agent at most once.
const _registered = new Set();
async function ensureAgent(link, agentId) {
  const cacheKey = link.wsId + "/" + agentId;
  if (_registered.has(cacheKey)) return true;
  try {
    const r = await request(link, "POST", `/v1/workspaces/${link.wsId}/agents`, { id: agentId, name: agentId });
    if (r.status === 201 || r.status === 409) { _registered.add(cacheKey); return true; }
    return false;
  } catch { return false; }
}

// Mirror one committed local effect to the cloud ledger. Best-effort: never throws.
// The local effect_id is the cloud idempotency key, so re-mirroring the same effect
// (e.g. a second `push`) reconciles to the existing cloud receipt instead of duplicating.
async function mirrorEffect(link, e) {
  if (!link || !e || e.status !== "committed") return { skipped: true };
  const agentId = e.agent_id || "builder";
  try {
    if (!(await ensureAgent(link, agentId))) return { error: "agent register failed" };
    const r = await request(link, "POST", `/v1/workspaces/${link.wsId}/effects`, {
      agent_id: agentId,
      action_type: e.tool,
      payload: { params_hash: e.params_hash },
      cost_micros: e.cost_micros || 0,
      idempotency_key: e.effect_id,
      intent: `foundry ${e.type || "tool"} ${e.receipt ? e.receipt.number : ""}`.trim(),
    });
    // 200 committed, 409 duplicate_blocked (already mirrored) — both mean "it's up there".
    return { status: r.status, mirrored: r.status === 200 || r.status === 409 };
  } catch (err) { return { error: String((err && err.message) || err) }; }
}

// Sync a shared fact to the cloud workspace memory. This is what makes the Context layer
// real across agents and machines: the cloud store is keyed the same way, so if a *remote*
// agent already put a different value under this key, the response comes back `conflict`
// with the previous value — the stale-context signal, from outside this machine.
async function mirrorMemory(link, m) {
  if (!link || !m || !m.content) return { skipped: true };
  const agentId = m.agent || "builder";
  try {
    if (!(await ensureAgent(link, agentId))) return { error: "agent register failed" };
    const r = await request(link, "POST", `/v1/workspaces/${link.wsId}/memory`, {
      content: m.content,
      key: m.key || undefined,
      creator_agent: agentId,
      tags: m.tags || undefined,
      ttl_seconds: m.ttl_seconds || undefined,
      confidence: m.confidence,
    });
    let json = null; try { json = JSON.parse(r.body); } catch { /* non-JSON */ }
    return {
      status: r.status,
      synced: r.status === 200 || r.status === 201,
      conflict: !!(json && json.conflict),
      previous: json && json.previous,
      memory: json && json.memory,
    };
  } catch (err) { return { error: String((err && err.message) || err) }; }
}

// Backfill: mirror every committed effect in the local ledger (used by `foundry push`).
async function mirrorAll(link, effects) {
  let sent = 0, failed = 0;
  for (const e of effects) {
    const r = await mirrorEffect(link, e);
    if (r.mirrored) sent++;
    else if (r.error) failed++;
  }
  return { sent, failed };
}

module.exports = { cloudLink, mirrorEffect, mirrorMemory, mirrorAll, ensureAgent, DEFAULT_BASE };
