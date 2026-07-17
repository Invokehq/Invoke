"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const embeddings = require("../src/embeddings");
const { Memory, runMemoryTool, reindex } = require("../src/memory");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdr-emb-"));
const EMBED_ENV = ["FOUNDRY_EMBED_URL", "FOUNDRY_EMBED_MODEL", "FOUNDRY_EMBED_KEY", "OPENAI_API_KEY"];
function clearEnv() { const saved = {}; for (const k of EMBED_ENV) { saved[k] = process.env[k]; delete process.env[k]; } return saved; }
function restoreEnv(saved) { for (const k of EMBED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }

// A stub OpenAI-compatible embeddings server. It is NOT a real model — it maps a few known
// concepts onto orthogonal axes, which is enough to prove Foundry embeds/stores/ranks
// correctly. Real semantic *quality* is the provider's job; this proves the plumbing.
function mockEmbeddings() {
  const vec = (text) => {
    const t = String(text).toLowerCase();
    return [
      /pric|cost|charge|\$|much|expensive|seat|fee/.test(t) ? 1 : 0.01,
      /deploy|ship|release|vercel|pipeline|build/.test(t) ? 1 : 0.01,
      /hir|recruit|candidate|interview|headcount|engineer/.test(t) ? 1 : 0.01,
    ];
  };
  let calls = 0;
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      calls++;
      const j = JSON.parse(b || "{}");
      const inputs = Array.isArray(j.input) ? j.input : [j.input];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: vec(t) })), model: j.model, usage: { total_tokens: inputs.join(" ").length } }));
    });
  });
  return { server, calls: () => calls };
}
function provFor(port) { return { url: "http://127.0.0.1:" + port + "/v1/embeddings", model: "stub-embed", key: null }; }

test("provider() is null with nothing configured, and resolves from project + env", () => {
  const saved = clearEnv();
  assert.equal(embeddings.provider(null), null, "unconfigured → null (caller falls back to lexical)");
  assert.equal(embeddings.provider({ embeddings: { url: "http://x/v1/embeddings", model: "m" } }).model, "m", "project config");
  process.env.OPENAI_API_KEY = "sk-test";
  const p = embeddings.provider(null);
  assert.ok(p && /openai\.com/.test(p.url) && p.model === "text-embedding-3-small", "a bare OPENAI_API_KEY defaults to OpenAI");
  restoreEnv(saved);
});

test("cosine similarity: identical→1, orthogonal→0, mismatched dims→0", () => {
  assert.equal(embeddings.cosine([1, 0], [1, 0]), 1);
  assert.equal(embeddings.cosine([1, 0], [0, 1]), 0);
  assert.equal(embeddings.cosine([1, 0, 0], [1, 0]), 0, "incomparable dims are safe, not a crash");
});

test("embed() speaks the OpenAI /v1/embeddings contract and returns vectors + cost", async () => {
  const { server } = mockEmbeddings();
  await new Promise((r) => server.listen(0, r));
  const e = await embeddings.embed(provFor(server.address().port), ["hello", "world"]);
  assert.equal(e.vectors.length, 2);
  assert.equal(e.vectors[0].length, 3);
  assert.ok(e.cost_micros >= 0);
  server.close();
});

test("SEMANTIC search finds a fact that shares NO words with the query (lexical cannot)", async () => {
  const saved = clearEnv();
  const dir = tmp();
  const { server } = mockEmbeddings();
  await new Promise((r) => server.listen(0, r));
  const project = { embeddings: { url: "http://127.0.0.1:" + server.address().port + "/v1/embeddings", model: "stub-embed" } };

  await runMemoryTool(dir, "memory.set", { key: "pricing", content: "Competitor charges $35 per seat", agent: "a" }, project);
  await runMemoryTool(dir, "memory.set", { key: "deploy", content: "We ship to production via Vercel", agent: "b" }, project);

  // The query "how expensive is it" shares zero literal words with the pricing fact.
  const lexical = new Memory(dir).search({ q: "how expensive is it" });
  assert.equal(lexical.length, 0, "lexical substring search finds nothing — the whole point");

  const r = await runMemoryTool(dir, "memory.search", { q: "how expensive is it" }, project);
  assert.equal(r.search, "semantic", "ran semantic, and says so");
  assert.equal(r.memory[0].key, "pricing", "the pricing fact ranks first by meaning");
  assert.ok(r.memory[0].score > r.memory[1].score, "ranked by cosine score");
  restoreEnv(saved);
  server.close();
});

test("no provider → search falls back to LEXICAL and labels itself (never fakes semantic)", async () => {
  const saved = clearEnv();
  const dir = tmp();
  await runMemoryTool(dir, "memory.set", { key: "k", content: "Competitor charges $35 per seat", agent: "a" });
  const r = await runMemoryTool(dir, "memory.search", { q: "charges" });
  assert.equal(r.search, "lexical");
  assert.equal(r.memory.length, 1);
  const none = await runMemoryTool(dir, "memory.search", { q: "how expensive" });
  assert.equal(none.memory.length, 0, "lexical genuinely can't match by meaning — not hidden");
  restoreEnv(saved);
});

test("a write is embedded when a provider exists; reindex backfills facts written before it", async () => {
  const saved = clearEnv();
  const dir = tmp();
  const { server } = mockEmbeddings();
  await new Promise((r) => server.listen(0, r));
  const project = { embeddings: { url: "http://127.0.0.1:" + server.address().port + "/v1/embeddings", model: "stub-embed" } };

  // written with NO provider → no vector
  await runMemoryTool(dir, "memory.set", { key: "a", content: "Competitor charges $35 per seat", agent: "x" });
  assert.equal(new Memory(dir).unembedded("stub-embed").length, 1, "unembedded before reindex");
  const semanticBefore = await runMemoryTool(dir, "memory.search", { q: "how much per seat" }, project);
  assert.equal(semanticBefore.count, 0, "no vectors yet → nothing to rank");

  const rr = await reindex(dir, project);
  assert.equal(rr.reindexed, 1);
  const semanticAfter = await runMemoryTool(dir, "memory.search", { q: "how much per seat" }, project);
  assert.equal(semanticAfter.memory[0].key, "a", "found by meaning after backfill");
  restoreEnv(saved);
  server.close();
});

test("changing a fact re-embeds it — a stale vector never points at replaced text", async () => {
  const saved = clearEnv();
  const dir = tmp();
  const { server, calls } = mockEmbeddings();
  await new Promise((r) => server.listen(0, r));
  const project = { embeddings: { url: "http://127.0.0.1:" + server.address().port + "/v1/embeddings", model: "stub-embed" } };
  await runMemoryTool(dir, "memory.set", { key: "topic", content: "Competitor charges $35 per seat", agent: "a" }, project);
  const before = calls();
  await runMemoryTool(dir, "memory.set", { key: "topic", content: "We now deploy via Vercel pipelines", agent: "b" }, project);
  assert.ok(calls() > before, "re-embedded on content change");
  // the updated fact must now match the NEW meaning, not the old
  const r = await runMemoryTool(dir, "memory.search", { q: "release pipeline shipping" }, project);
  assert.equal(r.memory[0].key, "topic");
  assert.ok(r.memory[0].score > 0.9, "matches the new content's concept");
  restoreEnv(saved);
  server.close();
});