"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "foundry.js");
// A PATH with no coding-agent binaries, so setup/doctor don't touch a real client config
// during the test (client detection just comes back empty).
const noClients = () => ({ ...process.env, PATH: "/nonexistent", FOUNDRY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "fh-ob-")) });
const proj = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdr-ob-"));

test("`foundry setup --yes` turns on governance + writes the config", () => {
  const dir = proj();
  const r = spawnSync(process.execPath, [BIN, "setup", "--yes"], { cwd: dir, encoding: "utf8", env: noClients() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Governing your agents/);
  assert.match(r.stdout, /Your agents are now governed/);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "foundry.json"), "utf8"));
  assert.equal(p.setup.governance, true);
  assert.equal(p.setup.receipts, true);
  assert.equal(p.setup.memory, true);
  assert.equal(p.setup.model_proxy, true);
  assert.ok(p.policies.approve.includes("*delete*"), "governance seeds a destructive-approval policy");
});

test("`foundry doctor --json` reports each check with an ok flag", () => {
  const dir = proj();
  const env = noClients();
  spawnSync(process.execPath, [BIN, "setup", "--yes"], { cwd: dir, env }); // set it up first
  const r = spawnSync(process.execPath, [BIN, "doctor", "--json"], { cwd: dir, encoding: "utf8", env });
  const checks = JSON.parse(r.stdout);
  const by = Object.fromEntries(checks.map((c) => [c.check, c]));
  assert.equal(by["Receipts"].ok, true, "ledger verifies");
  assert.equal(by["Policies"].ok, true, "policies present after setup");
  assert.equal(by["Memory"].ok, true);
  assert.ok("Cloud Sync" in by, "reports cloud sync state");
  // no coding agents on this PATH → they report as not-installed (a warning, not a hard fail)
  assert.ok(checks.some((c) => c.check === "Claude Code"));
});

test("`foundry doctor` exits 0 when nothing is broken", () => {
  const dir = proj();
  const env = noClients();
  spawnSync(process.execPath, [BIN, "setup", "--yes"], { cwd: dir, env });
  const r = spawnSync(process.execPath, [BIN, "doctor"], { cwd: dir, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /foundry doctor/);
  assert.match(r.stdout, /Receipts/);
  assert.match(r.stdout, /All good/);
});
