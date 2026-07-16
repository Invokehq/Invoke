"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTool, BUILTINS, toolType } = require("../src/tools");

test("execution type is selected by name (adapter routing)", () => {
  assert.equal(toolType("http.get"), "http");
  assert.equal(toolType("http.post"), "http");
  assert.equal(toolType("file.write"), "file");
  assert.equal(toolType("echo"), "tool");
  assert.equal(toolType("deepwiki.read_wiki_structure"), "tool");
});

test("built-ins include the HTTP + File adapters", () => {
  for (const t of ["http.get", "http.post", "http.request", "file.read", "file.write"]) {
    assert.ok(BUILTINS.includes(t), t);
  }
});

test("file adapter is sandboxed to the workspace", async () => {
  await assert.rejects(runTool("file.write", { path: "../../etc/pwn", content: "x" }), /escapes the workspace/);
});

test("file write -> read round-trips inside the workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-file-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const w = await runTool("file.write", { path: "notes/a.txt", content: "hi" });
    assert.equal(w.bytes, 2);
    const r = await runTool("file.read", { path: "notes/a.txt" });
    assert.equal(r.content, "hi");
  } finally {
    process.chdir(cwd);
  }
});
