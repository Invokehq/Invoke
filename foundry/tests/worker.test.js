"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "foundry.js");
const env = () => ({ ...process.env, FOUNDRY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "fh-wk-")) });

// A project with a worker script that logs "<task>|<agent>" so we can detect double-work.
function boardWith(titles, script = 'echo "$FOUNDRY_TASK_TITLE|$FOUNDRY_AGENT" >> done.log\nexit 0\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-wk-"));
  const e = env();
  spawnSync(process.execPath, [BIN, "init", "fleet"], { cwd: dir, env: e });
  fs.writeFileSync(path.join(dir, "work.sh"), "#!/bin/sh\n" + script, { mode: 0o755 });
  for (const t of titles) spawnSync(process.execPath, [BIN, "task", "add", t, "--json"], { cwd: dir, env: e });
  return { dir, e };
}
const runWorker = (dir, e, agent, extra = []) =>
  new Promise((res) => {
    const p = spawn(process.execPath, [BIN, "worker", "--agent", agent, "--cmd", "./work.sh", "--once", ...extra], { cwd: dir, env: e });
    p.on("close", res);
  });

test("a worker drains the board with --once and marks everything done", async () => {
  const { dir, e } = boardWith(["one", "two", "three"]);
  await runWorker(dir, e, "solo");
  const tasks = JSON.parse(spawnSync(process.execPath, [BIN, "task", "ls", "--json"], { cwd: dir, env: e, encoding: "utf8" }).stdout).tasks;
  assert.equal(tasks.length, 3);
  assert.ok(tasks.every((t) => t.status === "done"), "every task completed");
  assert.equal(fs.readFileSync(path.join(dir, "done.log"), "utf8").trim().split("\n").length, 3);
});

test("two workers racing one board never do the same task twice", async () => {
  const { dir, e } = boardWith(["a", "b", "c", "d", "e", "f"]);
  await Promise.all([runWorker(dir, e, "w1"), runWorker(dir, e, "w2")]);
  const lines = fs.readFileSync(path.join(dir, "done.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 6, "each task ran exactly once");
  assert.equal(new Set(lines.map((l) => l.split("|")[0])).size, 6, "no task was handled twice");
  const byAgent = new Set(lines.map((l) => l.split("|")[1]));
  assert.ok(byAgent.size >= 1, "work was claimed by the racing workers");
});

test("a failing task is released back to the board, not marked done", async () => {
  const { dir, e } = boardWith(["will-fail"], 'echo "boom" >&2\nexit 1\n');
  await runWorker(dir, e, "w1");
  const tasks = JSON.parse(spawnSync(process.execPath, [BIN, "task", "ls", "--json"], { cwd: dir, env: e, encoding: "utf8" }).stdout).tasks;
  assert.equal(tasks[0].status, "open", "released so another worker can retry");
  assert.equal(tasks[0].claimed_by, null, "claim was handed back");
});

test("the worker respects a dependency DAG (won't start blocked work)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-wk-"));
  const e = env();
  spawnSync(process.execPath, [BIN, "init", "dag"], { cwd: dir, env: e });
  fs.writeFileSync(path.join(dir, "work.sh"), '#!/bin/sh\necho "$FOUNDRY_TASK_TITLE" >> order.log\nexit 0\n', { mode: 0o755 });
  const first = JSON.parse(spawnSync(process.execPath, [BIN, "task", "add", "first", "--json"], { cwd: dir, env: e, encoding: "utf8" }).stdout).task.id;
  spawnSync(process.execPath, [BIN, "task", "add", "second", "--needs", first, "--json"], { cwd: dir, env: e });
  await runWorker(dir, e, "w1");
  const order = fs.readFileSync(path.join(dir, "order.log"), "utf8").trim().split("\n");
  assert.deepEqual(order, ["first", "second"], "the dependency ran before its dependent");
});
