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

// ── Coordination: when graduated, task/handoff ops route to the cloud workspace, which is
// the authoritative, race-safe substrate across machines. A local board can't arbitrate a
// claim between agents on two different laptops — the shared workspace can.
async function _coord(link, method, path, body) {
  if (!(await ensureAgent(link, (body && body.agent_id) || (body && body.assigned_agent) || "builder"))) { /* best-effort */ }
  const r = await request(link, method, `/v1/workspaces/${link.wsId}${path}`, body);
  let json = null; try { json = JSON.parse(r.body); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

const cloudCoord = {
  async addTask(link, { title, required_capability, depends_on, agent }) {
    await ensureAgent(link, agent || "builder");
    const r = await _coord(link, "POST", "/tasks", { title, required_capability: required_capability || undefined, depends_on: depends_on || undefined, assigned_agent: agent || undefined });
    return r.json && r.json.task;
  },
  async list(link) { const r = await _coord(link, "GET", "/tasks"); return (r.json && r.json.tasks) || []; },
  // Returns {claimed} | {conflict, owner} | {blocked, blockers}, normalized to match the local board.
  async claim(link, taskId, agent) {
    await ensureAgent(link, agent);
    const r = await _coord(link, "POST", `/tasks/${taskId}/claim`, { agent_id: agent });
    if (r.status === 200 && r.json) return { claimed: !!r.json.claimed, already_owner: !!r.json.already_owner, task: r.json.task };
    if (r.status === 409 && r.json && r.json.decision === "denied_blocked") return { claimed: false, blocked: true, blockers: r.json.blockers };
    if (r.status === 409) { const m = /Already claimed by (.+)$/.exec((r.json && r.json.detail) || ""); return { claimed: false, conflict: true, owner: m ? m[1] : "another agent", capability: /lacks required capability/.test((r.json && r.json.detail) || "") }; }
    return { claimed: false, error: (r.json && r.json.detail) || `cloud ${r.status}` };
  },
  async release(link, taskId, agent) { const r = await _coord(link, "POST", `/tasks/${taskId}/release`, { agent_id: agent }); return { released: !!(r.json && r.json.released), task: r.json && r.json.task, owner: r.json && r.json.detail }; },
  async complete(link, taskId, agent, output) { const r = await _coord(link, "PATCH", `/tasks/${taskId}`, { status: "done", output }); return { completed: r.status === 200, task: r.json && r.json.task }; },
  async addDep(link, taskId, depId) { const r = await _coord(link, "POST", `/tasks/${taskId}/dependencies`, { depends_on: depId }); return { status: r.status, json: r.json }; },
  async handoff(link, { from, to, task_id, context }) { const r = await _coord(link, "POST", "/handoffs", { from_agent: from, to_agent: to, task_id, context }); return r.json && (r.json.handoff || r.json); },
  async inbox(link, agent, status) { const r = await _coord(link, "GET", `/handoffs?to_agent=${encodeURIComponent(agent)}${status ? "&status=" + status : ""}`); return (r.json && r.json.handoffs) || []; },
  async resolveHandoff(link, id, accept, by) { const r = await _coord(link, "POST", `/handoffs/${id}/${accept ? "accept" : "reject"}`, { by }); return r.json; },
};

// ── Shared knowledge across workspaces. Memory is stored per workspace in the cloud, so
// "org knowledge" is the union of shared-tagged facts across the org's workspaces. Writes
// reuse mirrorMemory (this project's workspace); reads fan out across the org, which is
// what lets a fact learned in one repo surface in another.
async function orgMemory(link, limit = 200) {
  const out = [];
  try {
    const wsRes = await request(link, "GET", "/v1/workspaces", null);
    const list = (JSON.parse(wsRes.body || "{}").workspaces || []).map((w) => w.id).filter(Boolean).slice(0, 12);
    for (const id of list) {
      try {
        const r = await request(link, "GET", `/v1/workspaces/${encodeURIComponent(id)}/memory?limit=${limit}`, null);
        for (const m of JSON.parse(r.body || "{}").memory || []) out.push(m);
      } catch { /* skip a workspace we can't read */ }
    }
  } catch { /* offline — caller reports 0 pulled */ }
  return out;
}

// ── Governance sync. Foundry enforces policies + budgets locally; graduating a workspace
// must not drop them. On push we translate the local config into the cloud's admission
// engine, so a `deny`/`approve` policy or a spend cap you set on your laptop is enforced
// identically once agents run in the cloud. Foundry-managed policies are named `foundry:…`
// so a re-sync replaces exactly them and leaves any hand-authored cloud policies alone.
async function _req(link, method, path, body) {
  try { const r = await request(link, method, `/v1/workspaces/${link.wsId}${path}`, body); return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

async function syncGovernance(link, project) {
  const out = { policies: 0, budget: false, agent_budgets: 0, cleared: 0, errors: [] };

  // Policies: clear the ones we manage, then re-create from local config. deny/approve/allow
  // map to the cloud's deny/require_approval/allow, with priorities that preserve Foundry's
  // precedence (deny > approve > allow — lower number decides first).
  const listed = await _req(link, "GET", "/policies");
  if (listed.ok) {
    let existing = [];
    try { existing = JSON.parse(listed.body).policies || []; } catch { /* none */ }
    for (const p of existing.filter((x) => (x.name || "").startsWith("foundry:"))) {
      const d = await _req(link, "DELETE", `/policies/${p.id}`);
      if (d.ok) out.cleared++;
    }
  }
  const pol = project.policies || {};
  for (const [key, effect, priority] of [["deny", "deny", 10], ["approve", "require_approval", 20], ["allow", "allow", 30]]) {
    for (const glob of pol[key] || []) {
      const r = await _req(link, "POST", "/policies", { name: `foundry:${key}:${glob}`, effect, mode: "enforce", match: { action_glob: glob }, priority });
      r.ok ? out.policies++ : out.errors.push(`policy ${glob}: ${r.status || r.error}`);
    }
  }

  // Fleet budget.
  if (project.budget_usd != null) {
    const r = await _req(link, "PUT", "/budget", { limit_micros: Math.round(Number(project.budget_usd) * 1e6) });
    out.budget = r.ok;
    if (!r.ok) out.errors.push(`budget: ${r.status || r.error}`);
  }

  // Per-agent caps (the agent must exist in the workspace to carry a budget).
  for (const [agent, usd] of Object.entries(project.agent_budgets || {})) {
    await ensureAgent(link, agent);
    const r = await _req(link, "PATCH", `/agents/${encodeURIComponent(agent)}`, { budget_micros: Math.round(Number(usd) * 1e6) });
    r.ok ? out.agent_budgets++ : out.errors.push(`agent ${agent}: ${r.status || r.error}`);
  }
  return out;
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

module.exports = { cloudLink, syncGovernance, orgMemory, mirrorEffect, mirrorMemory, mirrorAll, ensureAgent, cloudCoord, DEFAULT_BASE };
