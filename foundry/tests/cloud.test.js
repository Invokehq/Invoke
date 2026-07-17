"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// Isolate global config so a real ~/.foundry/config.json can't leak a token into these tests.
process.env.FOUNDRY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fh-cloud-"));
const cloud = require("../src/cloud");

// A stand-in for the Invoke workspace API: records agent registrations + effects, and
// enforces the same idempotency the real backend does (409 on a repeated key).
function mockCloud() {
  const seen = { agents: [], effects: [], agentIds: new Set(), effectKeys: new Set() };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = body ? JSON.parse(body) : {};
      if (req.url.endsWith("/agents")) {
        if (seen.agentIds.has(j.id)) { res.writeHead(409); return res.end("{}"); }
        seen.agentIds.add(j.id); seen.agents.push(j);
        res.writeHead(201); return res.end('{"success":true}');
      }
      if (req.url.endsWith("/effects")) {
        const dup = seen.effectKeys.has(j.idempotency_key);
        seen.effects.push(j); seen.effectKeys.add(j.idempotency_key);
        res.writeHead(dup ? 409 : 200);
        return res.end(JSON.stringify({ decision: dup ? "duplicate_blocked" : "committed" }));
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return { server, seen };
}

test("cloudLink is null until the project is both logged in AND pushed", () => {
  delete process.env.INVOKE_API_KEY;
  assert.equal(cloud.cloudLink({ invoke: { workspace: "ws_1" } }), null, "no token → null");
  process.env.INVOKE_API_KEY = "ag_live_x";
  assert.equal(cloud.cloudLink({ invoke: {} }), null, "no workspace → null");
  const link = cloud.cloudLink({ invoke: { workspace: "ws_1", base: "http://x" } });
  assert.ok(link && link.wsId === "ws_1" && link.base === "http://x", "both present → link");
  delete process.env.INVOKE_API_KEY;
});

test("mirrorEffect registers the agent once and posts the effect in the cloud shape", async () => {
  const { server, seen } = mockCloud();
  await new Promise((r) => server.listen(0, r));
  const link = { base: "http://127.0.0.1:" + server.address().port, token: "ag_live_x", wsId: "ws_shape" };
  const eff = { status: "committed", agent_id: "planner", tool: "echo", params_hash: "abc123", cost_micros: 1200, effect_id: "eff_1", type: "tool", receipt: { number: "#deadbeef" } };

  const r = await cloud.mirrorEffect(link, eff);
  assert.equal(r.mirrored, true);
  assert.equal(seen.agents.length, 1);
  assert.equal(seen.agents[0].id, "planner");
  const e = seen.effects[0];
  assert.equal(e.agent_id, "planner");
  assert.equal(e.action_type, "echo");
  assert.equal(e.payload.params_hash, "abc123", "mirrors the hash, not raw params");
  assert.equal(e.cost_micros, 1200, "passes real cost through");
  assert.equal(e.idempotency_key, "eff_1", "local effect_id is the cloud idempotency key");

  // A second effect for the same agent must NOT re-register it (cached per process).
  await cloud.mirrorEffect(link, { ...eff, effect_id: "eff_2", tool: "time" });
  assert.equal(seen.agents.length, 1, "agent registered exactly once");
  assert.equal(seen.effects.length, 2);
  server.close();
});

test("mirrorEffect skips denied/blocked effects — they stay local, never leave the machine", async () => {
  const r = await cloud.mirrorEffect({ base: "http://127.0.0.1:1", token: "x", wsId: "w" }, { status: "denied", tool: "x" });
  assert.equal(r.skipped, true, "no network call for a non-committed effect");
});

test("mirrorAll backfills committed effects and is idempotent (re-run mirrors no dupes)", async () => {
  const { server, seen } = mockCloud();
  await new Promise((r) => server.listen(0, r));
  const link = { base: "http://127.0.0.1:" + server.address().port, token: "ag_live_x", wsId: "ws_backfill" };
  const effects = [
    { status: "committed", agent_id: "a", tool: "echo", params_hash: "h1", effect_id: "eff_a", cost_micros: 0 },
    { status: "committed", agent_id: "b", tool: "time", params_hash: "h2", effect_id: "eff_b", cost_micros: 0 },
    { status: "denied", agent_id: "a", tool: "rm", params_hash: "h3", effect_id: "eff_c" }, // skipped
  ];
  const first = await cloud.mirrorAll(link, effects);
  assert.equal(first.sent, 2, "2 committed mirrored, denied skipped");
  const committedKeys = seen.effects.filter((e) => e.idempotency_key).length;
  const second = await cloud.mirrorAll(link, effects); // re-push
  assert.equal(second.sent, 2, "re-push still reports mirrored (409 = already up there)");
  const uniqueKeys = new Set(seen.effects.map((e) => e.idempotency_key)).size;
  assert.equal(uniqueKeys, 2, "no duplicate effects created on re-push");
  assert.ok(committedKeys >= 2);
  server.close();
});
