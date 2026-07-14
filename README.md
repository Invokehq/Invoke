# Invoke

**Execution reliability infrastructure for AI agents** — governed, exactly-once tool calls with budgets, approvals, and cryptographically signed receipts.

> **Invoke** = the platform you deploy to. **Foundry** = the thing you build with.

## Packages

| Package | Command | What it is |
|---|---|---|
| [`foundry/`](./foundry) — `@invokehq/foundry` | `foundry` | Forge agents locally with a governed workspace (exactly-once, hash-chained signed receipts, **no account needed**). `foundry login` + `foundry push` graduate the workspace to Invoke. |

```bash
npm install -g @invokehq/foundry
foundry init && foundry run          # governed local execution in ~30 seconds
```

See [`foundry/README.md`](./foundry/README.md) for the full command set.
