"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { aggregateTools } = require("../src/serve");
const { Ledger } = require("../src/ledger");
const store = require("../src/store");

const BIN = path.join(__dirname, "..", "bin", "foundry.js");

test("`foundry mcp` lists the major clients + a generic config that launches `foundry serve`", () => {
  const r = spawnSync(process.execPath, [BIN, "mcp"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mcpServers/);
  assert.match(r.stdout, /"foundry"/);
  assert.match(r.stdout, /"serve"/);
  assert.match(r.stdout, /Cursor/);
  assert.match(r.stdout, /Claude Code/);
});

test("`foundry connect cursor --no-follow` wires the client + prints staged setup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-con-"));
  // pre-seed a project + connector so connect skips the network auto-connect
  fs.writeFileSync(path.join(dir, "foundry.json"), JSON.stringify({ name: "t", agent: {} }));
  fs.mkdirSync(path.join(dir, ".foundry"));
  fs.writeFileSync(path.join(dir, ".foundry", "connectors.json"), JSON.stringify({ demo: { url: "x", tools: [] } }));
  const r = spawnSync(process.execPath, [BIN, "connect", "cursor", "--no-follow"], {
    cwd: dir, encoding: "utf8", env: Object.assign({}, process.env, { FOUNDRY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "fh-")) }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Connecting Foundry to Cursor/);
  assert.match(r.stdout, /wired into Cursor/);
  assert.ok(fs.existsSync(path.join(dir, ".cursor", "mcp.json")), ".cursor/mcp.json written");
});

test("`foundry mcp add --client cursor` writes .cursor/mcp.json and merges, preserving others", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-cur-"));
  fs.mkdirSync(path.join(dir, ".cursor"));
  fs.writeFileSync(path.join(dir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  const r = spawnSync(process.execPath, [BIN, "mcp", "add", "--client", "cursor"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cfg.mcpServers.foundry, { command: "foundry", args: ["serve"] });
  assert.ok(cfg.mcpServers.other, "pre-existing server preserved");
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

// --- the governance params ----------------------------------------------------------
// `_idempotency_key` is what turns an at-least-once call into an exactly-once one. It was
// read by handleCall but never advertised, so no agent reading tools/list could find it.

function tmpServeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-gov-"));
  store.writeProject(dir, { name: "gov", agent: {}, invoke: { workspace: null } });
  fs.mkdirSync(store.ledgerDir(dir), { recursive: true });
  return dir;
}

function serveCalls(dir, calls) {
  const input = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    ...calls.map((c, i) => JSON.stringify({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: c })),
  ].join("\n") + "\n";
  const r = spawnSync(process.execPath, [BIN, "serve", "--local"], { cwd: dir, input, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").map((l) => JSON.parse(l));
}

test("every effectful tool advertises _idempotency_key + _agent_id (built-ins AND connectors)", () => {
  const tools = aggregateTools({
    slack: { url: "x", tools: [{ name: "post_message", inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] } }] },
    bare: { url: "x", tools: ["do_thing"] }, // string form: no upstream schema at all
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["http.get", "http.post", "http.request", "file.read", "file.write", "slack.post_message", "bare.do_thing"]) {
    const props = byName[n].inputSchema.properties;
    assert.ok(props._idempotency_key, `${n} advertises _idempotency_key`);
    assert.ok(props._agent_id, `${n} advertises _agent_id`);
  }
  // injection must not disturb the tool's own schema
  assert.ok(byName["slack.post_message"].inputSchema.properties.channel, "upstream props preserved");
  assert.deepEqual(byName["slack.post_message"].inputSchema.required, ["channel"], "upstream required preserved");
  assert.deepEqual(byName["http.post"].inputSchema.required, ["url"], "built-in required preserved");
});

test("initialize tells the agent exactly-once is per-call, not automatic", () => {
  const dir = tmpServeProject();
  const [init] = serveCalls(dir, []);
  assert.match(init.result.instructions, /_idempotency_key/);
  assert.doesNotMatch(init.result.instructions, /is a receipted, exactly-once Execution/);
});

test("exactly-once through the MCP surface: a keyed repeat reconciles, an unkeyed repeat re-executes", () => {
  const dir = tmpServeProject();
  const write = (extra) => ({ name: "file.write", arguments: Object.assign({ path: "out.txt", content: "hello" }, extra) });
  const effects = () => new Ledger(store.ledgerDir(dir)).list().filter((e) => e.tool === "file.write");

  serveCalls(dir, [write({ _idempotency_key: "op-1" }), write({ _idempotency_key: "op-1" })]);
  assert.equal(effects().length, 1, "keyed repeat reconciled to the receipt — no second execution");

  // identical call, no key: still at-least-once. That is the documented behaviour now,
  // not an accident — which is why the key has to be discoverable from tools/list.
  serveCalls(dir, [write({}), write({})]);
  assert.equal(effects().filter((e) => !e.idempotency_key).length, 2, "unkeyed repeat really does run again");
});

test("_agent_id attributes the Execution instead of collapsing everything to 'coding-agent'", () => {
  const dir = tmpServeProject();
  serveCalls(dir, [{ name: "file.write", arguments: { path: "a.txt", content: "x", _agent_id: "billing-agent" } }]);
  const e = new Ledger(store.ledgerDir(dir)).list().find((x) => x.tool === "file.write");
  assert.equal(e.agent_id, "billing-agent");
  // and the underscore params never reach the tool itself
  assert.ok(!("_agent_id" in (e.params || {})), "governance params stripped before execution");
});
