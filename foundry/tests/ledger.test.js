"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Ledger } = require("../src/ledger");

function tmpLedger() {
  return new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), "fdr-")));
}

test("commit records an effect and mints a signed receipt", () => {
  const l = tmpLedger();
  const e = l.commit({ agent: "a", tool: "echo", params: { x: 1 }, result: { ok: true } });
  assert.equal(e.status, "committed");
  assert.match(e.receipt.number, /^#[0-9a-f]{8}$/);
  assert.equal(e.receipt.alg, "HMAC-SHA256");
  assert.equal(l.list().length, 1);
});

test("exactly-once: same agent+tool+params+key dedups; a different key does not", () => {
  const l = tmpLedger();
  l.commit({ agent: "a", tool: "echo", params: { x: 1 }, key: "k1", result: 1 });
  const k = l.effectKey("a", "echo", { x: 1 }, "k1");
  assert.ok(l.committed(k), "identical effect is found as a duplicate");
  const other = l.effectKey("a", "echo", { x: 1 }, "k2");
  assert.equal(l.committed(other), undefined, "different key is a distinct effect");
});

test("params order does not change the effect identity (canonicalized)", () => {
  const l = tmpLedger();
  assert.equal(
    l.effectKey("a", "t", { x: 1, y: 2 }, "k"),
    l.effectKey("a", "t", { y: 2, x: 1 }, "k")
  );
});

test("verify passes for a clean chain and fails when a receipt is tampered", () => {
  const l = tmpLedger();
  l.commit({ agent: "a", tool: "echo", params: { n: 1 }, result: 1 });
  l.commit({ agent: "a", tool: "echo", params: { n: 2 }, result: 2 });
  assert.equal(l.verify().ok, true);

  const data = JSON.parse(fs.readFileSync(l.file, "utf8"));
  data.effects[0].result = { tampered: true };
  fs.writeFileSync(l.file, JSON.stringify(data));
  // result_hash no longer matches the receipt body -> chain/hash check fails
  assert.equal(l.verify().ok, false);
});
