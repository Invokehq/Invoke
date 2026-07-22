# Invoke

**Execution reliability infrastructure for AI agents** — governed, exactly-once tool calls with budgets, approvals, and cryptographically signed receipts.

> **Invoke** = the platform you deploy to. **Foundry** = the thing you build with.

## Using Claude Code? Two commands

```bash
claude plugin marketplace add Invokehq/Invoke
claude plugin install invoke@invoke
```

Open Claude Code in the project you want governed and say **"integrate Invoke"**.
The plugin registers the Foundry MCP gateway (zero preinstall, runs via `npx`) and
two skills that teach the agent to route consequential actions through the governed
ledger — receipts, budgets, approvals, exactly-once. Prove any run afterwards:

```bash
npx -y @invokehq/foundry receipts --verify   # tamper-evident hash chain
```

Details: [`claude-plugin/`](./claude-plugin).

## Packages

| Package | Command | What it is |
|---|---|---|
| [`foundry/`](./foundry) — `@invokehq/foundry` | `foundry` | Forge agents locally with a governed workspace (exactly-once, hash-chained signed receipts, **no account needed**). `foundry login` + `foundry push` graduate the workspace to Invoke. |
| [`claude-plugin/`](./claude-plugin) | `claude plugin install invoke@invoke` | Claude Code plugin: the Foundry MCP gateway + governance skills in one install. |

```bash
npm install -g @invokehq/foundry
foundry init && foundry run          # governed local execution in ~30 seconds
```

See [`foundry/README.md`](./foundry/README.md) for the full command set.
