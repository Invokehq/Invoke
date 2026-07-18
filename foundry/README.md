# @invokehq/foundry

**Forge AI agents locally with a governed workspace — exactly-once, receipted, no account needed.**
Deploy to [Invoke](https://invokehq.run) when you're ready.

> **Invoke** = the platform you deploy to. **Foundry** = the thing you build with.

```bash
npm install -g @invokehq/foundry
foundry connect claude          # or: codex — wire Foundry into your coding agent (once)
```

Then open your agent and just say it:

```text
$ claude
› integrate Invoke

  ✓ Governed workspace ready — myapp
  ✓ Tool + model calls route through the Invoke ledger — identity, exactly-once, receipts
  ✓ Budget set — $5.00 cap
  ✓ Starter policy — destructive tools require approval
  → Governed in ~5 min · foundry receipts --verify
```

Your agent calls Foundry's `setup` tool over MCP and governs the project for you — you never
leave the editor. `foundry connect` wires it in; **"integrate Invoke" is the 5-minute primitive.**

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
| `foundry memory set\|get\|search` | Shared context — one canonical fact per key; warns when a fact is **stale** or **contested** |
| `foundry task add\|claim\|done\|dep\|dag` | Multi-agent coordination — **atomic claim** (exactly one owner) + dependency DAG |
| `foundry handoff <to> "ctx"` | Pass a task to another agent (`inbox` / `accept` / `reject`) |
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
| `foundry push` | Graduate the workspace to a durable cloud one **and stream every execution to the Invoke dashboard, live** |

Built-in execution adapters: `echo` · `time` · **`http.get`/`http.post`/`http.request`** (governed HTTP) ·
**`file.read`/`file.write`** (governed, sandboxed to the workspace). Each is a governed Execution
(type `http`/`file`) — policy-gated, deduped, receipted, and typed in `trace` (⇄ / ▤).
## Connect real tools

The MCP ecosystem ships in two shapes, and Foundry speaks both — so the tools you actually use
(Slack, GitHub, Postgres, Vercel) become governed Executions:

```bash
# stdio servers — launched via npx. Most of the ecosystem: Slack, GitHub, Postgres, filesystem…
foundry workspace connect slack  --cmd "npx -y @nrjdalal/slack-mcp-server" --env SLACK_MCP_XOXP_TOKEN
foundry workspace connect github --cmd "npx -y @modelcontextprotocol/server-github" --env GITHUB_TOKEN

# hosted HTTP servers — some anonymous, some token-gated
foundry workspace connect deepwiki https://mcp.deepwiki.com/mcp
foundry workspace connect vercel   https://mcp.vercel.com --header "Authorization: Bearer \${VERCEL_TOKEN}"
```

Then every call through them is receipted, deduped, policy-gated, and costed like any other Execution:

```bash
foundry run slack.post_message '{"channel":"#eng","text":"deploy done"}' --key deploy-42
foundry run slack.post_message '{"channel":"#eng","text":"deploy done"}' --key deploy-42
#  ⧗ duplicate blocked — reconciled to receipt #… (your agent did NOT double-post)
```

**Secrets never touch disk.** `--env SLACK_MCP_XOXP_TOKEN` stores the variable's *name*; the value is
read from your environment when the server launches. `--header "... \${VERCEL_TOKEN}"` stores the
template and resolves it at call time. `connectors.json` is safe to commit.

A token-gated server you connect without credentials fails with an actionable error, not a hang:
```
server requires authorization (401). Connect it with a token:
    foundry workspace connect <name> https://mcp.vercel.com --header "Authorization: Bearer ${YOUR_TOKEN_ENV}"
```

`run`/`receipts` follow the active workspace; no `--cloud` flag.

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

## Shared context — memory that tells you when it's wrong

Agents redo each other's research, and act on facts that changed under them. Foundry's
Context layer is shared workspace memory where **a keyed fact has one canonical value** —
and, crucially, it tells a reader when that value is untrustworthy:

```bash
foundry memory set pricing "Competitor charges \$20/seat" --agent researcher
foundry memory set pricing "Competitor charges \$35/seat" --agent analyst
#  ⚠ contested — pricing held a different value (v1, by researcher).
#    was:  Competitor charges $20/seat
#    now:  Competitor charges $35/seat
#    the prior value is kept in revisions — nothing was silently overwritten.

foundry memory get pricing --agent planner
#  ⚠ contested — a different value was replaced (v2). See revisions.
#  revisions (1):  v1 · researcher · Competitor charges $20/seat
```

- **contested** — the last write replaced a *different* value: someone changed this under you.
  Re-affirming the same value is *not* contested (no false alarms).
- **stale** — a `--ttl` fact whose time is up: `⚠ stale — re-verify before acting on it.`
- **revisions** — the last 10 prior values, with who wrote them and when. Nothing is lost.
- Every op is a receipted `memory` Execution, and your agents get the same store as MCP tools
  through `foundry serve` (`memory.set` · `memory.get` · `memory.search`).

Once you `foundry push`, the store is the workspace's: a write learns from the cloud if a
**remote** agent already had a different value — stale-context detection *across machines*.

### Semantic search — find facts by meaning

`memory.search` is **semantic** when you configure an embeddings provider — a query finds a
fact even when they share no words. Point it at a local model (free, private) or OpenAI:

```bash
foundry memory provider http://localhost:11434/v1/embeddings nomic-embed-text   # Ollama, local
#  or:  export OPENAI_API_KEY=sk-…                                              # OpenAI

foundry memory reindex                       # embed facts written before the provider
foundry memory search "how expensive is it"
#  Memory — 3 fact(s) matching "how expensive is it" · semantic (nomic-embed-text)
#    pricing   Competitor charges $35 per seat   0.71   ← found by meaning, not keywords
```

Real learned embeddings do the work (there's no honest zero-dependency shortcut), each embed
is a **governed, costed Execution**, and a fact is re-embedded when its content changes so a
vector never points at replaced text. Vectors from different models aren't compared.

> **Honest fallback.** With **no provider configured, search is lexical** (substring/keyword) and
> the output says so — Foundry never dresses a keyword match up as semantic. `"how expensive is it"`
> matches nothing lexically; that's the gap the provider closes.

## Multi-agent coordination — a team, not a mob

Several agents on one workspace need to *not* collide: two shouldn't do the same task, and
work has an order. Foundry gives them the primitives — and every op is a receipted Execution:

```bash
research=$(foundry task add "Research competitors")          # -> task_…
foundry task add "Write the brief" --needs $research         # can't start until research is done

foundry task claim $write --agent writer
#  ◌ blocked — Write the brief has unfinished dependencies:  Research competitors (open)

# two agents race for the same task — exactly ONE wins:
foundry task claim $research --agent alice   #  ✔ claimed
foundry task claim $research --agent bob     #  ✗ already claimed by alice — you did NOT double-book

foundry task done $research --agent alice    #  now dependents unblock
foundry handoff editor "final polish" --task $write --agent writer
foundry handoff accept <id> --agent editor   #  the task is now editor's
```

- **Atomic claim** — the whole point. N agents race, one wins, everyone else is told *"already
  claimed by X"* instead of doing the work twice. (Verified under an 8-process race, and
  cross-machine against the cloud.)
- **Dependency DAG** — `--needs` gates a task until its upstream tasks are done; cycles are refused.
- **Handoffs** — pass a task to another agent with context; they accept (it becomes theirs) or reject.
- **Agents self-coordinate** through `foundry serve`: `task.add` · `task.list` · `task.claim` ·
  `task.complete` · `handoff.create` are MCP tools, so Claude/Codex claim work before starting it.

Local, the board is authoritative (atomic within one `.foundry`). Once you `foundry push`, claims
route to the **cloud workspace** — race-safe across machines, so agents on different laptops still
never double-book.

## Deploy to Invoke — and watch it live

`foundry push` graduates your local workspace to a durable, org-owned cloud one **and turns on
live mirroring**: from then on, every `foundry run` and every tool call through `foundry serve`
is streamed to the Invoke workspace ledger as it happens — so the dashboard shows your agents
working in real time.

```bash
foundry login          # link this machine to Invoke
foundry push           # graduate + backfill history, then stream live
#  ✔ Graduated "myapp" → Invoke  workspace ws_…
#  ↑ streamed 12 of 12 local effect(s) to the cloud ledger
#  Watch it live:  https://invokehq.run/dashboard/runtime?ws=ws_…
```

- **Local-first stays fast.** Execution happens on your machine; mirroring is best-effort and never
  blocks the agent or fails a run. Offline? Everything still works; it's all in your on-disk ledger.
- **Exactly-once, end to end.** The local `effect_id` is the cloud idempotency key, so a re-`push`
  (or a blind retry) reconciles to the existing cloud receipt instead of duplicating.
- **Privacy-preserving.** Foundry mirrors the *hash + metadata* (agent, action, cost, receipt) —
  never your raw params. The payload stays in your local ledger.

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

Requires Node ≥ 18. Zero dependencies. Prototype.
