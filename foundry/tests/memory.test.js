"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Memory, runMemoryTool } = require("../src/memory");
const { toolType } = require("../src/tools");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fdr-mem-"));

test("a keyed write upserts one canonical fact instead of duplicating", () => {
  const m = new Memory(tmp());
  m.set({ key: "pricing", content: "$20/seat", agent: "researcher" });
  m.set({ key: "pricing", content: "$35/seat", agent: "analyst" });
  const all = m.list();
  assert.equal(all.length, 1, "one fact per key");
  assert.equal(all[0].version, 2);
  assert.equal(all[0].content, "$35/seat");
});

test("replacing a DIFFERENT value is contested — prior value kept, never silently overwritten", () => {
  const m = new Memory(tmp());
  m.set({ key: "pricing", content: "$20/seat", agent: "researcher" });
  const r = m.set({ key: "pricing", content: "$35/seat", agent: "analyst" });
  assert.equal(r.conflict, true, "conflict flagged");
  assert.equal(r.previous, "$20/seat", "the replaced value comes back");
  assert.equal(r.memory.contested, true);
  assert.equal(r.memory.revisions.length, 1);
  assert.equal(r.memory.revisions[0].content, "$20/seat");
  assert.equal(r.memory.revisions[0].by, "researcher", "who wrote it is preserved");
  // A later reader sees the contest without having been there.
  assert.equal(m.get("pricing").contested, true);
});

test("re-affirming the SAME value is not contested (no false alarms)", () => {
  const m = new Memory(tmp());
  m.set({ key: "k", content: "same", agent: "a" });
  const r = m.set({ key: "k", content: "same", agent: "b" });
  assert.equal(r.conflict, false);
  assert.equal(r.memory.contested, false, "re-affirmation is not a conflict");
  assert.equal(r.memory.version, 2, "still a new version");
});

// Move a fact's expiry into the past — the same state as having waited out its TTL.
function age(dir, key) {
  const file = path.join(dir, "memory.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  d.memory.find((r) => r.key === key).expires_at = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(d));
}

test("a TTL'd fact goes stale so memory doesn't quietly go out of date", () => {
  const dir = tmp();
  const m = new Memory(dir);
  m.set({ key: "deploy", content: "green", agent: "ci", ttl_seconds: 60 });
  assert.equal(m.get("deploy").stale, false, "fresh while inside its TTL");
  age(dir, "deploy");
  assert.equal(m.get("deploy").stale, true, "past its TTL → stale");

  m.set({ key: "k", content: "v", agent: "a" });
  assert.equal(m.get("k").stale, false, "no TTL → never stale");
  // A non-positive TTL means "no expiry", matching the cloud's `ttl_seconds > 0` rule.
  m.set({ key: "z", content: "v", agent: "a", ttl_seconds: 0 });
  assert.equal(m.get("z").expires_at, null);
});

test("revisions are capped at the last 10 prior values", () => {
  const m = new Memory(tmp());
  for (let i = 0; i < 15; i++) m.set({ key: "k", content: "v" + i, agent: "a" });
  const got = m.get("k");
  assert.equal(got.revisions.length, 10);
  assert.equal(got.version, 15);
  assert.equal(got.revisions[9].content, "v13", "keeps the most recent priors");
});

test("search is lexical: it matches literal text, and says so", async () => {
  const dir = tmp();
  const m = new Memory(dir);
  m.set({ key: "a", content: "Competitor pricing is $35/seat", agent: "x", tags: ["market"] });
  m.set({ key: "b", content: "Deploy pipeline uses Vercel", agent: "y", tags: ["infra"] });
  assert.equal(m.search({ q: "pricing" }).length, 1);
  assert.equal(m.search({ q: "PRICING" }).length, 1, "case-insensitive");
  assert.equal(m.search({ tag: "infra" }).length, 1, "tag filter");
  // Honest boundary: a semantically-related query does NOT match. This is not semantic search.
  assert.equal(m.search({ q: "how much do they charge" }).length, 0, "no semantic retrieval — by design");
  const r = await runMemoryTool(dir, "memory.search", { q: "pricing" });
  assert.equal(r.search, "lexical", "the result labels itself lexical");
});

test("memory.get warns an agent when a fact is stale or contested", async () => {
  const dir = tmp();
  const m = new Memory(dir);
  m.set({ key: "p", content: "old", agent: "a" });
  m.set({ key: "p", content: "new", agent: "b" });
  const got = await runMemoryTool(dir, "memory.get", { key: "p" });
  assert.equal(got.found, true);
  assert.match(got.warning, /contested/, "the reading agent is told the fact was changed under it");

  m.set({ key: "s", content: "x", agent: "a", ttl_seconds: 60 });
  age(dir, "s");
  const stale = await runMemoryTool(dir, "memory.get", { key: "s" });
  assert.match(stale.warning, /stale/);
  assert.equal((await runMemoryTool(dir, "memory.get", { key: "nope" })).found, false);
});

test("memory.set through the adapter surfaces the contest to the writing agent", async () => {
  const dir = tmp();
  await runMemoryTool(dir, "memory.set", { key: "k", content: "first", agent: "a" });
  const r = await runMemoryTool(dir, "memory.set", { key: "k", content: "second", agent: "b" });
  assert.equal(r.conflict, true);
  assert.match(r.warning, /contested/);
  assert.match(r.warning, /written by a/, "names who held the previous value");
});

test("memory.* is its own Execution type, and bad input fails cleanly", async () => {
  assert.equal(toolType("memory.set"), "memory");
  assert.equal(toolType("memory.get"), "memory");
  assert.equal(toolType("http.get"), "http", "other types unaffected");
  await assert.rejects(() => runMemoryTool(tmp(), "memory.set", {}), /needs 'content'/);
  await assert.rejects(() => runMemoryTool(tmp(), "memory.get", {}), /needs \{"key"/);
  await assert.rejects(() => runMemoryTool(tmp(), "memory.bogus", {}), /unknown memory tool/);
});
