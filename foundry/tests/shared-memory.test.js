"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { runMemoryTool, sharedDir, Memory } = require("../src/memory");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdr-sm-"));
// Each test gets its own machine-wide store, so the shared scope can't leak between tests.
function isolatedHome() {
  process.env.FOUNDRY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fh-sm-"));
  return process.env.FOUNDRY_HOME;
}

// Stub embeddings server: concepts onto orthogonal axes, enough to prove cross-scope ranking.
function mockEmbeddings() {
  const vec = (t) => {
    const s = String(t).toLowerCase();
    return [
      /pay|card|stripe|processor|billing|charge|vendor/.test(s) ? 1 : 0.01,
      /node|version|runtime|pin/.test(s) ? 1 : 0.01,
      /deploy|ship|release/.test(s) ? 1 : 0.01,
    ];
  };
  return http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const j = JSON.parse(b || "{}");
      const inputs = Array.isArray(j.input) ? j.input : [j.input];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: vec(t) })), model: j.model, usage: { total_tokens: 4 } }));
    });
  });
}

test("a --shared fact lands in the machine-wide store, not the project", async () => {
  isolatedHome();
  const repo = tmp();
  await runMemoryTool(repo, "memory.set", { key: "vendor", content: "We use Stripe", agent: "alice", shared: true });
  await runMemoryTool(repo, "memory.set", { key: "local", content: "pins Node 20", agent: "alice" });
  assert.equal(new Memory(sharedDir()).get("vendor").content, "We use Stripe");
  assert.equal(new Memory(sharedDir()).get("local"), null, "workspace facts stay in the project");
  assert.equal(new Memory(repo).get("local").content, "pins Node 20");
  assert.equal(new Memory(repo).get("vendor"), null, "shared facts are not copied into the project");
});

test("a fact written in repo A is found from repo B; repo A's private fact is not", async () => {
  isolatedHome();
  const repoA = tmp(), repoB = tmp();
  await runMemoryTool(repoA, "memory.set", { key: "vendor", content: "We use Stripe", agent: "alice", shared: true });
  await runMemoryTool(repoA, "memory.set", { key: "nodever", content: "pins Node 20", agent: "alice" });

  const hits = await runMemoryTool(repoB, "memory.search", { q: "Stripe" });
  const keys = hits.memory.map((m) => m.key);
  assert.ok(keys.includes("vendor"), "shared knowledge crosses repos");
  assert.equal(hits.memory.find((m) => m.key === "vendor").scope, "shared", "hits are labeled with their scope");

  const leak = await runMemoryTool(repoB, "memory.search", { q: "Node 20" });
  assert.ok(!leak.memory.some((m) => m.key === "nodever"), "repo A's workspace fact never leaks to repo B");
});

test("SEMANTIC search ranks shared + workspace facts together, across repos", async () => {
  isolatedHome();
  const srv = mockEmbeddings();
  await new Promise((r) => srv.listen(0, r));
  const project = { embeddings: { url: "http://127.0.0.1:" + srv.address().port + "/v1/embeddings", model: "stub" } };
  const repoA = tmp(), repoB = tmp();

  await runMemoryTool(repoA, "memory.set", { key: "vendor", content: "We settled on Stripe for card payments", agent: "alice", shared: true }, project);
  await runMemoryTool(repoB, "memory.set", { key: "uinote", content: "Ship the release on Friday", agent: "bob" }, project);

  // A query with no words in common with the answer — only meaning connects them.
  const r = await runMemoryTool(repoB, "memory.search", { q: "which payment processor did we pick" }, project);
  assert.equal(r.search, "semantic");
  assert.equal(r.memory[0].key, "vendor", "the other repo's shared fact ranks first, by meaning");
  assert.equal(r.memory[0].scope, "shared");
  assert.deepEqual(r.scopes, ["workspace", "shared"]);
  srv.close();
});

test("scope filter narrows the search to one store", async () => {
  isolatedHome();
  const repo = tmp();
  await runMemoryTool(repo, "memory.set", { key: "org", content: "org wide thing", agent: "a", shared: true });
  await runMemoryTool(repo, "memory.set", { key: "mine", content: "project thing", agent: "a" });
  const onlyShared = await runMemoryTool(repo, "memory.search", { q: "thing", scope: "shared" });
  assert.deepEqual(onlyShared.memory.map((m) => m.key), ["org"]);
  const onlyWs = await runMemoryTool(repo, "memory.search", { q: "thing", scope: "workspace" });
  assert.deepEqual(onlyWs.memory.map((m) => m.key), ["mine"]);
});

test("memory.get prefers this project's answer but still finds shared-only keys", async () => {
  isolatedHome();
  const repo = tmp();
  await runMemoryTool(repo, "memory.set", { key: "policy", content: "org default: 30 day retention", agent: "a", shared: true });
  const fromShared = await runMemoryTool(repo, "memory.get", { key: "policy" });
  assert.equal(fromShared.found, true);
  assert.equal(fromShared.scope, "shared");

  // the project overrides it locally
  await runMemoryTool(repo, "memory.set", { key: "policy", content: "this repo: 7 day retention", agent: "a" });
  const overridden = await runMemoryTool(repo, "memory.get", { key: "policy" });
  assert.equal(overridden.scope, "workspace");
  assert.match(overridden.content, /7 day/);
  assert.equal(overridden.also_shared, true, "flags that the org has a different answer");
  assert.match(overridden.shared_value, /30 day/);
});
