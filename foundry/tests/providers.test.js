"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Ledger } = require("../src/ledger");
const { governed } = require("../src/model");

// A temp project dir. governed() reads foundry.json to decide whether to mirror, so give
// it a real one rather than relying on the error path.
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-prov-"));
  fs.writeFileSync(path.join(d, "foundry.json"), JSON.stringify({ name: "prov", agent: {} }));
  return d;
};
// Close stub servers no matter how the assertion goes — a leaked listener hangs node --test.
const withServers = async (servers, fn) => { try { return await fn(); } finally { servers.forEach((s) => s.close()); } };

// A stand-in upstream. `status` drives the failure mode; healthy ones return a completion.
function upstream(status = 200, label = "ok") {
  return http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (status >= 400) { res.writeHead(status); return res.end(JSON.stringify({ error: { message: label } })); }
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: label } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, () => r("http://127.0.0.1:" + s.address().port + "/v1")));
const call = (project, dir, model) =>
  governed(project, new Ledger(dir), "http://127.0.0.1:1/v1", null, { model, messages: [{ role: "user", content: "hi" }] }, dir, "tester");

test("falls through to the next provider when the first is down", async () => {
  const dead = upstream(503, "down"), live = upstream(200, "served by backup");
  const [dUrl, lUrl] = [await listen(dead), await listen(live)];
  const dir = tmp();
  const project = { providers: [
    { name: "primary", url: dUrl, models: ["gpt-*"] },
    { name: "backup", url: lUrl, models: ["gpt-*"] },
  ] };
  const out = await call(project, dir, "gpt-4o-mini");
  assert.equal(out.status, 200, "the caller never sees the outage");
  assert.equal(out.headers["x-foundry-provider"], "backup");
  assert.equal(out.headers["x-foundry-fallback"], "1");
  dead.close(); live.close();
});

test("the receipt records which provider served it and which failed first", async () => {
  const dead = upstream(429, "rate limited"), live = upstream(200, "ok");
  const [dUrl, lUrl] = [await listen(dead), await listen(live)];
  const dir = tmp();
  const project = { providers: [{ name: "a", url: dUrl, models: ["*"] }, { name: "b", url: lUrl, models: ["*"] }] };
  await call(project, dir, "gpt-4o-mini");
  const eff = new Ledger(dir).list().find((e) => e.type === "model");
  assert.equal(eff.provider, "b");
  assert.deepEqual(eff.fell_back, [{ provider: "a", status: 429 }], "the rate-limited attempt is auditable");
  dead.close(); live.close();
});

test("routes by model glob — a claude model skips gpt-only providers", async () => {
  const gpt = upstream(200, "from gpt provider"), claude = upstream(200, "from claude provider");
  const [gUrl, cUrl] = [await listen(gpt), await listen(claude)];
  const dir = tmp();
  const project = { providers: [
    { name: "openai", url: gUrl, models: ["gpt-*", "o3*"] },
    { name: "anthropic", url: cUrl, models: ["claude-*"] },
  ] };
  const out = await call(project, dir, "claude-3-5-haiku");
  assert.equal(out.headers["x-foundry-provider"], "anthropic");
  assert.equal(out.headers["x-foundry-fallback"], "0", "went straight there — no wasted attempt");
  gpt.close(); claude.close();
});

test("a malformed request (400) returns immediately instead of stampeding the chain", async () => {
  const bad = upstream(400, "bad request"), other = upstream(200, "never reached");
  const [bUrl, oUrl] = [await listen(bad), await listen(other)];
  const dir = tmp();
  const project = { providers: [{ name: "first", url: bUrl, models: ["*"] }, { name: "second", url: oUrl, models: ["*"] }] };
  await assert.rejects(() => call(project, dir, "gpt-4o-mini"), (e) => e.status === 400);
  bad.close(); other.close();
});

test("every provider failing surfaces what each one did", async () => {
  const a = upstream(503, "a down"), b = upstream(500, "b down");
  const [aUrl, bUrl] = [await listen(a), await listen(b)];
  const dir = tmp();
  const project = { providers: [{ name: "a", url: aUrl, models: ["*"] }, { name: "b", url: bUrl, models: ["*"] }] };
  await assert.rejects(
    () => call(project, dir, "gpt-4o-mini"),
    (e) => /every provider failed/.test(e.message) && /a: 503/.test(e.message) && /b: 500/.test(e.message)
  );
  a.close(); b.close();
});

test("with no providers configured, the single --upstream still works (back-compat)", async () => {
  const only = upstream(200, "legacy upstream");
  const url = await listen(only);
  const dir = tmp();
  const out = await governed({}, new Ledger(dir), url, null, { model: "gpt-4o-mini", messages: [] }, dir, "t");
  assert.equal(out.status, 200);
  assert.equal(out.headers["x-foundry-provider"], "upstream");
  only.close();
});
