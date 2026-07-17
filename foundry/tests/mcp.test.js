"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const mcp = require("../src/mcp");
const { _parseBody } = mcp;
const store = require("../src/store");

// A stand-in hosted MCP server that records the headers it received.
function mockHttpServer(onHeaders) {
  return http.createServer((req, res) => {
    if (onHeaders) onHeaders(req.headers);
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b || "{}");
      res.setHeader("content-type", "application/json");
      if (m.method === "initialize") return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1" } } }));
      if (m.method === "tools/list") return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping", description: "p" }] } }));
      if (m.method === "tools/call") return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "pong" }] } }));
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
    });
  });
}

// A real stdio MCP server (tiny, inline) — the shape Slack/GitHub/Postgres servers ship in.
const STDIO_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin, terminal: false });
rl.on("line", (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  const send = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stdio-mock", version: "1" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "whoami", description: "returns the token from env" }] } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "token=" + (process.env.SECRET_TOKEN || "none") }] } });
});
`;

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

test("normalize handles a bare url (legacy), an http descriptor, and a stdio descriptor", () => {
  assert.deepEqual(mcp.normalize("https://x/mcp"), { transport: "http", url: "https://x/mcp", headers: {} });
  // legacy connectors.json entries ({url, tools}) keep working — back-compat
  assert.equal(mcp.normalize({ url: "https://x/mcp", tools: [] }).transport, "http");
  const s = mcp.normalize({ command: "npx", args: ["-y", "pkg"], env: { T: "" } });
  assert.equal(s.transport, "stdio");
  assert.equal(s.command, "npx");
});

test("resolveEnv expands ${VAR} from the environment (secrets live in env, not on disk)", () => {
  process.env.__FDR_T = "tok_abc";
  assert.equal(mcp.resolveEnv("Bearer ${__FDR_T}"), "Bearer tok_abc");
  assert.equal(mcp.resolveEnv("Bearer ${__FDR_MISSING}"), "Bearer ", "missing var → empty, no crash");
  delete process.env.__FDR_T;
});

test("http connector sends auth headers with ${ENV} resolved on the wire", async () => {
  let got = null;
  const srv = mockHttpServer((h) => { got = got || h; });
  await new Promise((r) => srv.listen(0, r));
  process.env.__FDR_TOKEN = "tok_live_abc123";
  const desc = { transport: "http", url: "http://127.0.0.1:" + srv.address().port, headers: { Authorization: "Bearer ${__FDR_TOKEN}", "X-Team": "acme" } };
  const { tools } = await mcp.connect(desc);
  assert.equal(tools[0].name, "ping");
  assert.equal(got.authorization, "Bearer tok_live_abc123", "template resolved before sending");
  assert.equal(got["x-team"], "acme", "arbitrary headers pass through");
  delete process.env.__FDR_TOKEN;
  srv.close();
});

test("a 401 from a token-gated server (Vercel-style) becomes an actionable EAUTH error", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' });
    res.end('{"error":"invalid_token"}');
  });
  await new Promise((r) => srv.listen(0, r));
  await assert.rejects(
    () => mcp.connect({ transport: "http", url: "http://127.0.0.1:" + srv.address().port, headers: {} }),
    (e) => e.code === "EAUTH" && /requires authorization \(401\)/.test(e.message) && /--header/.test(e.message)
  );
  srv.close();
});

test("stdio connector launches the server, lists tools, and calls one (the Slack/GitHub shape)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-stdio-"));
  const file = path.join(dir, "server.js");
  fs.writeFileSync(file, STDIO_SERVER);
  const desc = { transport: "stdio", command: process.execPath, args: [file], env: {} };
  const { tools } = await mcp.connect(desc);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "whoami");
  const r = await mcp.call(desc, "whoami", {});
  assert.match(r.content[0].text, /token=none/);
});

test("stdio connector passes env through by name — the value never touches connectors.json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-stdio2-"));
  const file = path.join(dir, "server.js");
  fs.writeFileSync(file, STDIO_SERVER);
  process.env.SECRET_TOKEN = "xoxb-real-slack-token";
  // env: {SECRET_TOKEN: ""} means "pass it through from my environment" — only the NAME is stored.
  const desc = { transport: "stdio", command: process.execPath, args: [file], env: { SECRET_TOKEN: "" } };
  const r = await mcp.call(desc, "whoami", {});
  assert.match(r.content[0].text, /token=xoxb-real-slack-token/, "child received the secret from env");
  assert.equal(JSON.stringify(desc).includes("xoxb-real-slack-token"), false, "secret is NOT in the stored descriptor");
  delete process.env.SECRET_TOKEN;
});

test("stdio connector surfaces a failed launch as a clear error, not a hang", async () => {
  await assert.rejects(
    () => mcp.connect({ transport: "stdio", command: "definitely-not-a-real-binary-xyz", args: [], env: {} }),
    (e) => /could not launch|exited/.test(e.message)
  );
});
