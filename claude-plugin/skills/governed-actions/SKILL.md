---
name: governed-actions
description: >-
  Routing discipline for external effects when the Invoke/Foundry MCP server is
  connected. Use BEFORE any call that changes state outside this machine — HTTP
  POST/PUT/DELETE to remote APIs, payments, refunds, emails, messages, any
  connector tool — and when retrying a failed external call, handling a "queued
  for human approval" or "denied by policy" result, starting work another agent
  might also pick up, or when the user asks about receipts, budgets, idempotency,
  or proving what an agent did. Not needed for local dev commands (builds, tests,
  package installs, local git).
---

# Governed actions through Invoke

This project routes consequential actions through Foundry, Invoke's governed
gateway. Every call that passes through it becomes an **Execution**:
identity-stamped, receipted on a tamper-evident ledger, budget-capped, and
exactly-once when keyed. The rules below are the difference between a governed
run and an ungoverned one — follow them whenever the `foundry` MCP tools are
available.

## 1. Route external effects through the gate

**In scope — always through foundry tools** (`http.post`, `http.request`,
`<connector>.<tool>`), never raw `curl`/ad-hoc scripts:

- network mutations against remote APIs (POST/PUT/PATCH/DELETE)
- payments, refunds, transfers — anything that moves money
- emails, messages, notifications — anything a human receives
- any connector tool (they exist to be governed)

An external effect that bypasses the gate is invisible to the ledger: nothing
can prove it, cap it, dedupe it, or replay it.

**Out of scope — use your normal tools, no gate needed:**

- the local dev toolchain: builds, tests, linters, `npm install`, compilers
- local git (commit, branch, merge; pushing to a shared remote is the user's
  call, not a reason to reroute through the gate)
- reading/writing files in the working tree, grep, local scripts without
  network side effects
- read-only HTTP (GET against public endpoints)

The test: **does it change state outside this machine, or affect another person
or system?** Yes → through the gate. No → normal tools. When genuinely unsure
about a one-way door (e.g. a script that calls a remote API internally), prefer
the gate.

## 2. Always key mutating calls

Pass `_idempotency_key` on every mutating call, derived from the action's
*intent*, plus `_agent_id` naming your role:

```json
http.post { "url": ..., "body": ...,
            "_idempotency_key": "refund-order-4812",
            "_agent_id": "billing-agent" }
```

On timeout or ambiguous failure, **retry with the SAME key**. The ledger
reconciles the repeat to the committed receipt instead of re-executing — that is
what makes retries safe. Never retry a mutation with a fresh key: that is how
agents double-charge, double-send, and double-delete.

## 3. Governance outcomes are results, not errors

- **`⏸ queued for human approval`** — the call is parked, not failed. Tell the
  user exactly what is pending and under which rule. After a human approves,
  call again with the **same arguments**: exactly-once semantics return the
  result without running it twice.
- **`denied by policy rule …`** — a signed refusal. Do not route around it
  (no falling back to Bash/curl for the same effect). Surface the rule; changing
  policy is `foundry policy` and a human decision.
- **Budget exhausted (429 from the model proxy)** — the spend cap is hit. Stop
  and report; do not hunt for an ungoverned path.

## 4. Coordinate before you work

- `task.claim` before starting anything another agent might also pick up.
  `claimed: false` means someone owns it — pick other work, never duplicate.
- `memory.search` before research; `memory.set` with a stable `key` after
  learning something durable. Treat `contested` or stale results as warnings to
  verify, not facts to act on.

## 5. Prove the run

After a governed run, verify out loud:

```
foundry receipts --verify   # tamper-evident hash chain over every Execution
foundry trace               # the run, execution by execution
```

## What this skill cannot do

These rules are discipline, not enforcement. Enforcement — dedup, budgets,
approvals, receipts — lives in the Foundry/Invoke server, which is exactly why
effects must physically pass through it. If the foundry tools are missing, say
so and offer `/invoke:integrate` rather than proceeding ungoverned.
