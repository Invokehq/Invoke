"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { aggregateTools } = require("../src/serve");
const { Ledger } = require("../src/ledger");

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
