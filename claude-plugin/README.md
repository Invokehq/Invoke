# Invoke — Claude Code plugin

One install gives an agent both halves of governed execution:

- **`.mcp.json`** — the *enforcement path*: registers `foundry serve` (stdio MCP
  gateway) via `npx`, zero preinstall. `foundry serve` self-initializes the
  project, so a fresh repo works immediately.
- **`skills/`** — the *routing discipline*: teaches the agent when to go through
  the gate and how to behave at its decision points (keys, approvals, denials).
  - `invoke:governed-actions` — act-time rules for external effects
  - `invoke:integrate` — setup flow around the MCP `setup` tool
- **`hooks/`** — *sign-in*: on session start, a machine that isn't signed in to
  Invoke shows a link + code to approve in the browser. Silent once signed in.

## Install

```
claude plugin marketplace add Invokehq/Invoke
claude plugin install invoke@invoke
```

Start a session and **sign in**: Claude Code shows

```
🔐 Invoke: sign in to govern this session → https://console.invokehq.run/device?code=WDJB-MJHT
```

Open it, sign in, check the code matches, **Authorize**. Foundry picks it up on
its own. This machine gets its *own* member key — its agents can run governed
calls in your workspace but can't change policy or approve their own actions.
Until you approve, foundry's tools answer with the same link instead of running.
(Headless box? `npx -y @invokehq/foundry login --no-browser` prints the link.)

Then open Claude Code in the project you want governed and say:

```
› integrate Invoke
```

Verify anytime:

```
npx -y @invokehq/foundry receipts --verify
```

## Design

| Layer | Where it lives | Job |
|---|---|---|
| API (`api.invokehq.run`) | backend | guarantees: ledger, budgets, approvals, exactly-once |
| MCP (`foundry serve`, workspace `/mcp`) | `foundry/` in this repo | interception — the effect physically passes through us |
| Skill (this plugin) | Claude Code | discovery + discipline — when to route, how to retry, what a pause means |

The skill deliberately claims **no enforcement** — instructions-only
"governance" is theater. Enforcement stays server-side; the MCP
`initialize.instructions` in `foundry/src/serve.js` remains the fallback
teaching layer for hosts without skills (Cursor, Windsurf, Codex).

Versioning: `.mcp.json` pins the npm-published foundry version (not `@latest`)
— supply-chain hygiene + predictable behavior. Bump the pin when publishing a
new foundry release so plugin and server move together.
