---
name: integrate
description: >-
  Set up Invoke governance in the current project. Use when the user says
  "integrate Invoke", "govern this agent/project", "set up Foundry", asks for
  budgets/approvals/receipts on their agent, or wants their LLM calls capped
  and receipted.
---

# Integrate Invoke

The whole flow is one MCP tool call plus wiring. Do it in this order:

1. **Call the foundry `setup` tool first** (optionally `{ "budget_usd": N }`).
   It provisions the governed workspace — spend cap + starter safety policy
   (destructive tool patterns require human approval) — and returns the
   integration checklist plus a model-proxy snippet. The setup call itself is
   committed to the ledger as receipt #1.

2. **Apply the model-proxy snippet it returns**: point the project's
   OpenAI-compatible client at `http://localhost:4000/v1` (started with
   `foundry model serve`) so completions are receipted and budget-capped too.
   Edit the user's code where their LLM client is constructed; keep their API
   key handling unchanged.

3. **Verify**: run `foundry receipts --verify` and show the user the valid
   hash chain.

4. **Relay the checklist** the setup tool returned, then offer next steps:
   - `foundry trace --follow` — watch executions live while the agent works
   - `foundry workspace connect <name> <mcp_url>` — govern more tools
   - `foundry push` — graduate the local workspace to invokehq.run when a
     second human needs to see it (approvals, receipts, Mission Control)

From then on, follow the `governed-actions` skill for every consequential call.

If the foundry MCP tools are not available in this session, the gateway isn't
wired yet: run `npx -y @invokehq/foundry connect claude`, then restart the
session and start again at step 1.
