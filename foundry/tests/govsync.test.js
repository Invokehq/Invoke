"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const cloud = require("../src/cloud");

// A stand-in workspace API that records what governance sync sends it, and enforces the
// same idempotency the real backend needs (delete by id, then re-create).
function mockWorkspace() {
  const state = { policies: [], budget: null, agentBudgets: {}, agents: new Set() };
  let seq = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = body ? JSON.parse(body) : {};
      const url = req.url;
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj || {})); };
      if (/\/agents$/.test(url) && req.method === "POST") { state.agents.add(j.id); return send(201, { agent: { id: j.id } }); }
      if (/\/agents\/[^/]+$/.test(url) && req.method === "PATCH") { state.agentBudgets[decodeURIComponent(url.split("/agents/")[1])] = j.budget_micros; return send(200, {}); }
      if (/\/policies$/.test(url) && req.method === "GET") return send(200, { policies: state.policies });
      if (/\/policies$/.test(url) && req.method === "POST") { const p = { id: "pol_" + ++seq, name: j.name, effect: j.effect, match: j.match, priority: j.priority }; state.policies.push(p); return send(201, { policy: p }); }
      if (/\/policies\/[^/]+$/.test(url) && req.method === "DELETE") { const id = url.split("/policies/")[1]; state.policies = state.policies.filter((p) => p.id !== id); return send(200, {}); }
      if (/\/budget$/.test(url) && req.method === "PUT") { state.budget = j.limit_micros; return send(200, {}); }
      send(404, { error: "no route" });
    });
  });
  return { server, state };
}
const link = (port) => ({ base: "http://127.0.0.1:" + port, token: "k", wsId: "ws_test" });

test("syncGovernance maps deny/approve/allow to cloud policies with the right effect + glob", async () => {
  const { server, state } = mockWorkspace();
  await new Promise((r) => server.listen(0, r));
  const out = await cloud.syncGovernance(link(server.address().port), {
    policies: { deny: ["*.delete", "*.wire_transfer"], approve: ["stripe.*"], allow: ["echo"] },
  });
  assert.equal(out.policies, 4);
  const byName = Object.fromEntries(state.policies.map((p) => [p.name, p]));
  assert.equal(byName["foundry:deny:*.delete"].effect, "deny");
  assert.deepEqual(byName["foundry:deny:*.delete"].match, { action_glob: "*.delete" });
  assert.equal(byName["foundry:approve:stripe.*"].effect, "require_approval");
  assert.equal(byName["foundry:allow:echo"].effect, "allow");
  // deny is checked before approve before allow (lower priority number decides first)
  assert.ok(byName["foundry:deny:*.delete"].priority < byName["foundry:approve:stripe.*"].priority);
  assert.ok(byName["foundry:approve:stripe.*"].priority < byName["foundry:allow:echo"].priority);
  server.close();
});

test("syncGovernance syncs the fleet budget and per-agent caps (as micros)", async () => {
  const { server, state } = mockWorkspace();
  await new Promise((r) => server.listen(0, r));
  const out = await cloud.syncGovernance(link(server.address().port), {
    budget_usd: 2, agent_budgets: { analyst: 0.5, writer: 1 },
  });
  assert.equal(out.budget, true);
  assert.equal(state.budget, 2_000_000, "$2 → 2,000,000 micros");
  assert.equal(out.agent_budgets, 2);
  assert.equal(state.agentBudgets.analyst, 500_000);
  assert.equal(state.agentBudgets.writer, 1_000_000);
  assert.ok(state.agents.has("analyst"), "the agent is registered before it can carry a cap");
  server.close();
});

test("re-sync replaces foundry-managed policies instead of duplicating them", async () => {
  const { server, state } = mockWorkspace();
  await new Promise((r) => server.listen(0, r));
  const L = link(server.address().port);
  await cloud.syncGovernance(L, { policies: { deny: ["*.delete"] } });
  // a hand-authored cloud policy that sync must NOT touch
  state.policies.push({ id: "pol_manual", name: "hand-written", effect: "deny", match: {} });
  await cloud.syncGovernance(L, { policies: { deny: ["*.delete", "*.drop"] } });
  const names = state.policies.map((p) => p.name).sort();
  assert.deepEqual(names, ["foundry:deny:*.delete", "foundry:deny:*.drop", "hand-written"]);
  assert.equal(state.policies.filter((p) => p.name === "foundry:deny:*.delete").length, 1, "no duplicate");
  server.close();
});

test("nothing configured → no policies, no budget calls, no errors", async () => {
  const { server, state } = mockWorkspace();
  await new Promise((r) => server.listen(0, r));
  const out = await cloud.syncGovernance(link(server.address().port), {});
  assert.equal(out.policies, 0);
  assert.equal(out.budget, false);
  assert.equal(out.agent_budgets, 0);
  assert.equal(out.errors.length, 0);
  assert.equal(state.budget, null);
  server.close();
});
