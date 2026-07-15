"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _parseBody } = require("../src/mcp");
const store = require("../src/store");

test("parseBody reads a JSON-RPC result from an SSE frame", () => {
  const sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"echo\"}]}}\n\n";
  const out = _parseBody(sse, "text/event-stream");
  assert.equal(out.result.tools[0].name, "echo");
});

test("parseBody reads plain application/json", () => {
  const out = _parseBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', "application/json");
  assert.equal(out.result.ok, true);
});

test("parseBody takes the last data frame (final response wins)", () => {
  const sse = "data: {\"id\":1,\"result\":\"partial\"}\n\ndata: {\"id\":1,\"result\":\"final\"}\n\n";
  assert.equal(_parseBody(sse, "text/event-stream").result, "final");
});

test("connectors store round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-conn-"));
  assert.deepEqual(store.readConnectors(dir), {});
  store.writeConnectors(dir, { deepwiki: { url: "https://x/mcp", tools: ["read_wiki_structure"] } });
  const back = store.readConnectors(dir);
  assert.equal(back.deepwiki.url, "https://x/mcp");
  assert.deepEqual(back.deepwiki.tools, ["read_wiki_structure"]);
});
