"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Approvals } = require("../src/approvals");

const BIN = path.join(__dirname, "..", "bin", "foundry.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdr-apr-"));

test("Approvals.request is idempotent on the effect key; resolve flips status once", () => {
  const a = new Approvals(tmp());
  const r1 = a.request({ agent: "x", tool: "file.write", params: { p: 1 }, effect_key: "ek1", rule: "*.write" });
  const r2 = a.request({ agent: "x", tool: "file.write", params: { p: 1 }, effect_key: "ek1", rule: "*.write" });
  assert.equal(r1.existing, false);
  assert.equal(r2.existing, true, "same effect_key while pending → same request, no pile-up");
  assert.equal(a.list("pending").length, 1);
  const res = a.resolve(r1.approval.id, "approve", "human");
  assert.equal(res.approval.status, "approved");
  assert.equal(a.resolve(r1.approval.id, "approve", "human").already, true, "resolving again is a no-op");
  assert.equal(a.list("pending").length, 0);
});

// The full loop through the CLI: gate a tool, an agent hits it via `serve` (queued, not run),
// a human approves (it runs once + is receipted), the agent re-calls (exactly-once).
test("human-in-the-loop: approve-gated tool queues, approves, executes once", () => {
  const dir = tmp();
  const env = { ...process.env, FOUNDRY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "fh-apr-")) };
  const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env, ...opts });

  run(["init", "hitl"]);
  run(["policy", "approve", "file.write"]);

  const call = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"file.write","arguments":{"path":"r.txt","content":"hi","_agent_id":"analyst"}}}',
  ].join("\n") + "\n";

  // 1. agent call → queued, file NOT written
  const first = run(["serve"], { input: call, timeout: 8000 });
  const firstResp = first.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2);
  assert.match(firstResp.result.content[0].text, /queued .* for human approval/);
  assert.ok(!fs.existsSync(path.join(dir, "r.txt")), "side effect is held, not executed");

  // 2. it's in the queue
  const pending = JSON.parse(run(["approvals", "list", "--json"]).stdout).pending;
  assert.equal(pending.length, 1);
  const id = pending[0].id;

  // 3. human approves → runs + receipts, file appears
  const appr = run(["approvals", "approve", id]);
  assert.equal(appr.status, 0, appr.stderr);
  assert.match(appr.stdout, /approved & executed/);
  assert.equal(fs.readFileSync(path.join(dir, "r.txt"), "utf8"), "hi", "effect executed on approval");

  // 4. agent re-calls → gets the result, exactly ONE committed file.write
  const second = run(["serve"], { input: call, timeout: 8000 });
  const secondResp = second.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.id === 2);
  assert.ok(!secondResp.result.isError, "re-call succeeds");
  const receipts = JSON.parse(run(["receipts", "--json"]).stdout || "[]");
  const list = Array.isArray(receipts) ? receipts : (receipts.receipts || receipts.effects || []);
  const writes = list.filter((e) => e.tool === "file.write" && e.status === "committed");
  assert.equal(writes.length, 1, "executed exactly once across the whole cycle");
});

test("deny records a signed refusal and never executes the tool", () => {
  const dir = tmp();
  const env = { ...process.env, FOUNDRY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "fh-apr2-")) };
  const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env, ...opts });
  run(["init", "hitl2"]);
  run(["policy", "approve", "file.write"]);
  const call = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"file.write","arguments":{"path":"x.txt","content":"nope","_agent_id":"a"}}}',
  ].join("\n") + "\n";
  run(["serve"], { input: call, timeout: 8000 });
  const id = JSON.parse(run(["approvals", "list", "--json"]).stdout).pending[0].id;
  const deny = run(["approvals", "deny", id]);
  assert.match(deny.stdout, /denied/);
  assert.ok(!fs.existsSync(path.join(dir, "x.txt")), "denied tool never ran");
  assert.equal(run(["approvals", "list", "--json"]) && JSON.parse(run(["approvals", "list", "--json"]).stdout).pending.length, 0);
});
