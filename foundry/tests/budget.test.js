"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Ledger } = require("../src/ledger");
const budget = require("../src/budget");

const BIN = path.join(__dirname, "..", "bin", "foundry.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdr-bud-"));
function ledgerWith(dir, effects) {
  const led = new Ledger(dir);
  for (const e of effects) led.commit({ agent: e.agent, tool: "m", params: { r: Math.random() }, result: {}, type: "model", cost_micros: e.cost });
  return led;
}

test("spend sums cost per agent and in total", () => {
  const led = ledgerWith(tmp(), [{ agent: "a", cost: 2000 }, { agent: "a", cost: 1000 }, { agent: "b", cost: 500 }]);
  const s = budget.spend(led);
  assert.equal(s.total, 3500);
  assert.equal(s.by.a, 3000);
  assert.equal(s.by.b, 500);
});

test("overCap: an agent's cap trips only that agent", () => {
  const led = ledgerWith(tmp(), [{ agent: "a", cost: 3000 }, { agent: "b", cost: 1000 }]); // a=$0.003, b=$0.001
  assert.equal(budget.overCap({}, led, "a"), null, "no caps → allowed");
  const caps = { agent_budgets: { a: 0.002 } };
  assert.equal(budget.overCap(caps, led, "a").scope, "agent a", "a is over its $0.002 cap");
  assert.equal(budget.overCap(caps, led, "b"), null, "b is untouched by a's cap");
});

test("overCap: the fleet cap trips everyone once total spend crosses it", () => {
  const led = ledgerWith(tmp(), [{ agent: "a", cost: 3000 }, { agent: "b", cost: 1000 }]); // total $0.004
  assert.equal(budget.overCap({ budget_usd: 0.003 }, led, "b").scope, "fleet");
  assert.equal(budget.overCap({ budget_usd: 0.01 }, led, "b"), null, "under the fleet cap → allowed");
});

test("the fleet cap is reported before an agent cap when both are blown", () => {
  const led = ledgerWith(tmp(), [{ agent: "a", cost: 5000 }]); // $0.005
  assert.equal(budget.overCap({ budget_usd: 0.004, agent_budgets: { a: 0.001 } }, led, "a").scope, "fleet");
});

test("CLI: `budget set` writes fleet + per-agent caps; `--json` reports spend vs caps", () => {
  const dir = tmp();
  const env = { ...process.env, FOUNDRY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "fh-bud-")) };
  const run = (a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf8", env });
  run(["init", "b"]);
  assert.match(run(["budget", "set", "analyst", "5"]).stdout, /analyst/);
  run(["budget", "set", "--fleet", "20"]);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "foundry.json"), "utf8"));
  assert.equal(p.budget_usd, 20);
  assert.equal(p.agent_budgets.analyst, 5);
  const j = JSON.parse(run(["budget", "--json"]).stdout);
  assert.equal(j.fleet.cap, 20);
  assert.equal(j.agents.analyst.cap, 5);
});
