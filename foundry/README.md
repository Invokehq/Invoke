# @invokehq/foundry

**Forge AI agents locally with a governed workspace — exactly-once, receipted, no account needed.**
Deploy to [Invoke](https://invokehq.run) when you're ready.

> **Invoke** = the platform you deploy to. **Foundry** = the thing you build with.

```bash
npm install -g @invokehq/foundry

foundry connect claude   # or: codex — detect your agent, wire it in, connect tools,
                         # then watch its actions stream live. ~5 minutes to your first
                         # governed agent session.
```

Or piece by piece:
```bash
foundry init            # forge a local governed workspace (no account)
foundry run             # run an agent, governed — exactly-once + a signed receipt
foundry trace --follow  # watch executions stream in live as your agent acts
foundry receipts        # see what happened; --verify proves the ledger
foundry login           # link to Invoke for durable, shareable, team workspaces
```

## Why

Every governed call in Foundry goes through a **local effect ledger** — the same model
as Invoke's cloud, on your disk:

- **Exactly-once.** Re-run an identical call (same agent + tool + params + idempotency key)
  and it's **reconciled to the existing receipt**, not executed twice. Blind retries are safe.
- **Receipted.** Every commit mints a hash-chained, HMAC-signed receipt. `foundry receipts
  --verify` recomputes the chain and signatures — tamper-evident.
- **Local-first.** No login, no server, no signup to get to value. When you want durability,
  teammates, and org isolation, `foundry login` + `foundry push` graduate the workspace to Invoke.

## Commands

| Command | What it does |
|---|---|
| `foundry init [name]` | Create `foundry.json` + a local governed ledger under `.foundry/` |
| `foundry run [tool] [json]` | Run a tool/agent through the ledger. `--key K` (idempotency), `--agent A`, `--json` |
| `foundry receipts [--verify]` | List receipts (active workspace), or verify the signed hash-chain |
| `foundry policy [allow\|deny\|approve\|rm\|test] <pattern>` | Execution control — gate tools/models (deny > approve > allow) |
| `foundry trace` | The execution pipeline — every governed step, agent, duration, cost, receipt |
| `foundry diff <ref1> <ref2>` | Compare two executions — cost, latency, output ("why A vs B") |
| `foundry serve` | Governed MCP gateway (stdio) — point Claude Code/Cursor at it; tool calls become Executions |
| `foundry model serve [--port] [--upstream]` | Governed LLM proxy (OpenAI-compatible) — model calls become Executions (cost, budget, cache) |
| `foundry workspace` | Show the active workspace — target, tools, budget |
| `foundry workspace use <local\|cloud\|ws_id>` | Switch what `run`/`receipts` target |
| `foundry workspace connect <name> <mcp_url>` | Connect a real MCP tool server (governed) |
| `foundry workspace setup [--connect n=url] [--budget usd]` | Guided: connect a tool + set a budget |
| `foundry workspace tools` | List available tools |
| `foundry serve` | Governed MCP gateway (stdio) — point your coding agent at it |
| `foundry status` | Project, active target, and Invoke link state |
| `foundry login [--token K]` | Link this machine to Invoke (opens the web app) |
| `foundry push` | Graduate the local workspace to a durable cloud one |

Built-in execution adapters: `echo` · `time` · **`http.get`/`http.post`/`http.request`** (governed HTTP) ·
**`file.read`/`file.write`** (governed, sandboxed to the workspace). Each is a governed Execution
(type `http`/`file`) — policy-gated, deduped, receipted, and typed in `trace` (⇄ / ▤).
**Connect real tools** with `foundry workspace connect`
(e.g. `foundry workspace connect deepwiki https://mcp.deepwiki.com/mcp`) — any MCP server, governed by
the ledger locally *and* in the cloud. `run`/`receipts` follow the active workspace; no `--cloud` flag.

## Run your coding agent on Foundry

`foundry serve` is a governed MCP gateway over stdio. Point Claude Code / Cursor / Codex at it and
**every tool call your agent makes becomes a governed Execution** — identity, exactly-once (blind
retries reconcile to the receipt), and a signed, replayable ledger — without the agent knowing:

```bash
claude mcp add foundry -- foundry serve      # Claude Code
# then, after your agent works:
foundry receipts            # everything it did, receipted
foundry receipts --verify   # prove the ledger
```

**Everything is an Execution** — tool calls today; model calls, HTTP, memory, and approvals plug in
as more execution types (same identity / policy / retry / trace / cost / replay for each).

## Example

```bash
foundry init hello
foundry run echo '{"msg":"hi"}' --key demo
foundry run echo '{"msg":"hi"}' --key demo     # ⧗ duplicate blocked — reconciled to the receipt
foundry receipts --verify                       # Ledger valid — 1 receipt(s), head …
```

## Everything is an Execution

Foundry governs every side effect an agent produces — not just tools. A **tool call**, an
**LLM call**, an **MCP request**: each is an `Execution` with a `type`, and each gets the
same treatment — identity, dedup/exactly-once, cost, a signed receipt, and a line in `trace`.

### Wire it into your coding agent — any of them

Foundry `serve` speaks standard MCP, so **every MCP client works**. `foundry mcp add` wires the
right config for each:

```bash
foundry mcp add                          # Claude Code
foundry mcp add --client cursor          # writes .cursor/mcp.json
foundry mcp add --client windsurf        # ~/.codeium/windsurf/mcp_config.json
foundry mcp add --client codex           # prints ~/.codex/config.toml snippet
foundry mcp                              # lists Claude Desktop, VS Code/Cline, … too
```

Then connect tools and watch the agent's calls flow through Foundry — governed, receipted:
```bash
foundry workspace connect deepwiki https://mcp.deepwiki.com/mcp
foundry trace
```
Verified end-to-end: Claude Code shows `foundry: ✔ Connected`, and a tool call lands in the
ledger attributed to `claude-code`. **Model** calls too — point `OPENAI_BASE_URL` at
`foundry model serve` and any OpenAI-SDK framework (LangChain, LlamaIndex, Vercel AI SDK, …)
is governed the same way.

- `foundry serve` puts Foundry **between your coding agent and its tools** (MCP gateway).
- `foundry model serve` puts Foundry **in front of the model** (OpenAI-compatible proxy):
  point `OPENAI_BASE_URL` at it and every completion is costed, budgeted, and cached
  (identical request → cache hit → $0). `foundry trace` then shows the whole reasoning
  pipeline — model *and* tool steps — with per-step cost.

Requires Node ≥ 18. Zero dependencies. Prototype — `v0.1.0`.
