"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { aggregateTools } = require("../src/serve");
const { Ledger } = require("../src/ledger");

const BIN = path.join(__dirname, "..", "bin", "foundry.js");

test("`foundry mcp` prints an MCP config that launches `foundry serve`", () => {
  const r = spawnSync(process.execPath, [BIN, "mcp"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mcpServers/);
  assert.match(r.stdout, /"foundry"/);
  assert.match(r.stdout, /"serve"/);
  assert.match(r.stdout, /claude mcp add foundry/);
});

test("aggregateTools namespaces connector tools and includes built-ins", () => {
  const names = aggregateTools({
    deepwiki: { url: "x", tools: [{ name: "read_wiki_structure" }, { name: "ask_question" }] },
  }).map((t) => t.name);
  assert.ok(names.includes("echo") && names.includes("http.get"), "built-ins present");
  assert.ok(names.includes("deepwiki.read_wiki_structure"), "connector tool namespaced");
  assert.ok(names.includes("deepwiki.ask_question"));
});

test("ledger records the Execution type + duration/cost annotations and still verifies", () => {
  const l = new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), "fdr-")));
  const e = l.commit({ agent: "planner", tool: "gpt-5", params: { p: 1 }, result: { ok: 1 }, type: "model", duration_ms: 1200, cost_micros: 40000 });
  assert.equal(e.type, "model");
  assert.equal(e.duration_ms, 1200);
  assert.equal(e.cost_micros, 40000);
  // duration/cost are annotations, NOT in the receipt hash — the ledger still verifies.
  assert.equal(l.verify().ok, true);
});
