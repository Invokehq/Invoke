"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runSetup, DESTRUCTIVE } = require("../src/setup");
const store = require("../src/store");

const BIN = path.join(__dirname, "..", "bin", "foundry.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-setup-"));
  const project = { name: "myapp", agent: {}, invoke: { workspace: null } };
  store.writeProject(dir, project);
  fs.mkdirSync(store.ledgerDir(dir), { recursive: true });
  return { dir, project };
}

test("runSetup provisions budget + a starter safety policy and persists them", () => {
  const { dir, project } = tmpProject();
  const out = runSetup(dir, project, { budget_usd: 12 });
  assert.equal(out.budget, 12);
  const saved = store.readProject(dir);
  assert.equal(saved.budget_usd, 12);
  for (const p of DESTRUCTIVE) assert.ok(saved.policies.approve.includes(p), `${p} gated`);
  // Returns the integration snippet + a Didit-style checklist the agent can relay.
  assert.match(out.text, /Governed workspace ready/);
  assert.match(out.text, /localhost:4000\/v1/);
  assert.match(out.snippet.py, /base_url/);
});

test("runSetup is idempotent — re-running doesn't duplicate policy patterns or lower an existing budget", () => {
  const { dir, project } = tmpProject();
  runSetup(dir, project, { budget_usd: 20 });
  const again = runSetup(store.findProject ? dir : dir, store.readProject(dir), {}); // no budget arg
  assert.equal(again.budget, 20, "kept the existing budget");
  const saved = store.readProject(dir);
  assert.equal(saved.policies.approve.length, DESTRUCTIVE.length, "no duplicate patterns");
});

test("`foundry serve` advertises the setup tool and initialize carries integration instructions", () => {
  const { dir } = tmpProject();
  const input = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  ].join("\n") + "\n";
  const r = spawnSync(process.execPath, [BIN, "serve"], { cwd: dir, input, encoding: "utf8", timeout: 8000 });
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const init = lines.find((m) => m.id === 1);
  const list = lines.find((m) => m.id === 2);
  assert.match(init.result.instructions, /integrate Invoke/i);
  assert.match(init.result.instructions, /call the `setup` tool/i);
  assert.ok(list.result.tools.some((t) => t.name === "setup"), "setup tool advertised");
});
