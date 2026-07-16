"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { costMicros, priceFor } = require("../src/model");

test("model cost = prompt*in + completion*out (micros), by list price", () => {
  // gpt-4o [2.5,10]: 100*2.5 + 50*10 = 750 micros = $0.00075
  assert.equal(costMicros("gpt-4o", { prompt_tokens: 100, completion_tokens: 50 }), 750);
  // gpt-4o-mini [0.15,0.6]: 1000*0.15 + 500*0.6 = 150 + 300 = 450 micros
  assert.equal(costMicros("gpt-4o-mini", { prompt_tokens: 1000, completion_tokens: 500 }), 450);
});

test("local models are free; unknown models fall back to a non-zero default", () => {
  assert.equal(costMicros("llama4:latest", { prompt_tokens: 5000, completion_tokens: 5000 }), 0);
  assert.deepEqual(priceFor("some-brand-new-model"), [1, 3]);
  assert.equal(costMicros("some-brand-new-model", { prompt_tokens: 100, completion_tokens: 100 }), 400);
});
