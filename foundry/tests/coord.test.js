"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Coord } = require("../src/coord");
const { toolType } = require("../src/tools");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdr-coord-"));

test("atomic claim: one agent wins, a rival gets conflict, re-claim is idempotent", () => {
  const c = new Coord(tmp());
  const t = c.addTask({ title: "the one task" });
  const first = c.claim(t.id, "alice");
  assert.equal(first.claimed, true);
  const rival = c.claim(t.id, "bob");
  assert.equal(rival.claimed, false);
  assert.equal(rival.conflict, true);
  assert.equal(rival.owner, "alice", "the rival is told who owns it — not left to double-book");
  const again = c.claim(t.id, "alice");
  assert.equal(again.claimed, true);
  assert.equal(again.already_owner, true, "re-claiming your own task is idempotent");
});

test("DAG gate: a task can't be claimed until its dependency is done", () => {
  const c = new Coord(tmp());
  const research = c.addTask({ title: "research" });
  const write = c.addTask({ title: "write", depends_on: [research.id] });
  const blocked = c.claim(write.id, "writer");
  assert.equal(blocked.claimed, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.blockers[0].task_id, research.id);
  // finish the upstream task → the downstream one unblocks
  c.claim(research.id, "r"); c.complete(research.id, "r");
  const ok = c.claim(write.id, "writer");
  assert.equal(ok.claimed, true, "unblocked once the dependency is done");
});

test("dependencies are cycle-checked", () => {
  const c = new Coord(tmp());
  const a = c.addTask({ title: "a" });
  const b = c.addTask({ title: "b" });
  c.addDep(b.id, a.id);                    // b depends on a
  assert.throws(() => c.addDep(a.id, b.id), /cycle/, "a depends on b would close a cycle");
  assert.throws(() => c.addDep(a.id, a.id), /cycle/, "self-dependency is a cycle");
});

test("release is owner-only and reopens the task", () => {
  const c = new Coord(tmp());
  const t = c.addTask({ title: "t" });
  c.claim(t.id, "alice");
  assert.equal(c.release(t.id, "bob").released, false, "a non-owner can't release");
  const r = c.release(t.id, "alice");
  assert.equal(r.released, true);
  assert.equal(c.claim(t.id, "bob").claimed, true, "reopened → the next agent can claim");
});

test("dag() returns a topological order (dependencies before dependents)", () => {
  const c = new Coord(tmp());
  const a = c.addTask({ title: "a" });
  const b = c.addTask({ title: "b", depends_on: [a.id] });
  const cc = c.addTask({ title: "c", depends_on: [b.id] });
  const order = c.dag().order.map((t) => t.id);
  assert.ok(order.indexOf(a.id) < order.indexOf(b.id));
  assert.ok(order.indexOf(b.id) < order.indexOf(cc.id));
  assert.equal(c.dag().has_cycle, false);
});

test("handoff: accepting hands the task to the receiver", () => {
  const c = new Coord(tmp());
  const t = c.addTask({ title: "brief" });
  c.claim(t.id, "writer");
  const h = c.handoff({ from: "writer", to: "editor", task_id: t.id, context: "polish it" });
  assert.equal(c.inbox("editor", "pending").length, 1, "shows in the receiver's inbox");
  const res = c.resolveHandoff(h.id, true, "editor");
  assert.equal(res.handoff.status, "accepted");
  assert.equal(c.get(t.id).claimed_by, "editor", "accepting claims the task for the receiver");
  // a rejected handoff leaves the task untouched
  const t2 = c.addTask({ title: "other" }); c.claim(t2.id, "writer");
  const h2 = c.handoff({ from: "writer", to: "editor", task_id: t2.id });
  c.resolveHandoff(h2.id, false, "editor");
  assert.equal(c.get(t2.id).claimed_by, "writer", "reject leaves ownership with the sender");
});

test("coordination ops are their own Execution type", () => {
  assert.equal(toolType("task.claim"), "coord");
  assert.equal(toolType("task.add"), "coord");
  assert.equal(toolType("handoff.create"), "coord");
  assert.equal(toolType("memory.set"), "memory", "other namespaces unaffected");
});

// The real guarantee is concurrency: spawn N processes that all claim the SAME task at
// once and assert exactly one wins. This is what a single-threaded unit test can't prove.
test("atomic claim holds under a real multi-process race (exactly one winner)", () => {
  const dir = tmp();
  const c = new Coord(dir);
  const t = c.addTask({ title: "contended" });
  const racer = `const {Coord}=require(${JSON.stringify(path.join(__dirname, "..", "src", "coord"))});` +
    `const r=new Coord(${JSON.stringify(dir)}).claim(${JSON.stringify(t.id)},process.argv[1]);` +
    `process.stdout.write(JSON.stringify({claimed:r.claimed}));`;
  const wins = [];
  const procs = ["a", "b", "c", "d", "e", "f"].map((agent) =>
    spawnSync(process.execPath, ["-e", racer, agent], { encoding: "utf8" })
  );
  for (const p of procs) { try { if (JSON.parse(p.stdout).claimed) wins.push(1); } catch { /* ignore */ } }
  assert.equal(wins.length, 1, "exactly one process won the claim under contention");
  assert.equal(c.get(t.id).claimed_by != null, true, "the task ended up owned by someone");
});
