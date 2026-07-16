"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, loadPolicies, toRegex } = require("../src/policy");

test("precedence: deny > approve > allow > default(allow)", () => {
  const p = { deny: ["stripe.*"], approve: ["github.create_*"], allow: ["github.*"] };
  assert.equal(evaluate(p, "stripe.refund").effect, "deny");
  assert.equal(evaluate(p, "github.create_issue").effect, "approve"); // approve beats allow
  assert.equal(evaluate(p, "github.read").effect, "allow");
  assert.equal(evaluate(p, "anything.else").effect, "allow"); // default
});

test("glob matching is anchored", () => {
  assert.ok(toRegex("stripe.*").test("stripe.refund"));
  assert.ok(!toRegex("stripe.*").test("stripe")); // needs the dot
  assert.ok(toRegex("*").test("whatever.tool"));
  assert.ok(toRegex("github.read").test("github.read"));
  assert.ok(!toRegex("github.read").test("github.readme")); // exact, not prefix
});

test("loadPolicies tolerates missing config", () => {
  assert.deepEqual(loadPolicies({}), { deny: [], approve: [], allow: [] });
  assert.deepEqual(loadPolicies({ policies: { deny: ["x"] } }).deny, ["x"]);
});
