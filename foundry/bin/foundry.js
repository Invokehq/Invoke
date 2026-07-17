#!/usr/bin/env node
"use strict";
// Prefer IPv4: some hosts (and WSL) advertise AAAA records but have broken IPv6, so
// Node's default resolution can pick an unreachable v6 address and time out.
try { require("node:dns").setDefaultResultOrder("ipv4first"); } catch { /* older node */ }
const commands = require("../src/commands");
const pkg = require("../package.json");

const BOOL_FLAGS = new Set(["json", "force", "verify", "help", "version"]);
const ALIAS = { h: "help", V: "version" };

// Minimal zero-dependency arg parser: --flag, --key value, -h; rest are positionals.
function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inlineV] = a.slice(2).split(/=(.*)/s);
      if (BOOL_FLAGS.has(k)) { args[k] = true; }
      else if (inlineV !== undefined) { args[k] = inlineV; }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) { args[k] = argv[++i]; }
      else { args[k] = true; }
      if (k === "idempotency-key") args.key = args[k];
      if (k === "base-url") args.baseUrl = args[k];
      if (k === "agent-id") args.agent = args[k];
    } else if (a.startsWith("-") && a.length === 2 && ALIAS[a[1]]) {
      args[ALIAS[a[1]]] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }

const HELP = `${bold("foundry")} — forge AI agents locally, then deploy to Invoke.

  ${dim("Invoke = the platform you deploy to.  Foundry = the thing you build with.")}

${bold("USAGE")}
  foundry <command> [options]

${bold("BUILD")}
  init [name]              Forge a local governed workspace (on-disk ledger)
  run [tool] [json]        Run an agent/tool against the active workspace — exactly-once
                            --key K    idempotency key (rerun -> duplicate blocked)
                            --agent A  attribute to an agent    --json
  receipts [--verify]      List receipts (active workspace), or verify the chain
  trace                    The execution pipeline: every governed step, cost, and receipt
  diff REF1 REF2           Compare two executions — cost, latency, output (why A vs B)
  policy [allow|deny|approve|rm|test] PATTERN
                           Execution control — gate tools/models (deny > approve > allow)
  workspace                Show the active workspace (target, tools, budget)
    workspace use TARGET     Switch target: local | cloud | ws_id
    workspace connect N URL  Connect an MCP tool server (governed)
    workspace setup          Guided: connect a tool + set a budget
    workspace tools          List available tools
  status                   Show project, target, and Invoke link

${bold("SERVE (run your coding agent on Foundry)")}
  serve                    Governed MCP gateway over stdio — point Claude Code/Cursor at it;
                            every tool call becomes a receipted Execution
  mcp [add --client X]     Wire Foundry into any agent — Claude Code, Cursor, Windsurf,
                            Claude Desktop, Codex, VS Code/Cline (bare lists them all)
  model serve              Governed LLM proxy (OpenAI-compatible) — model calls become
                            Executions: cost, budget, cache. ${dim("OPENAI_BASE_URL=localhost:4000/v1")}

${bold("DEPLOY (to Invoke)")}
  login [--token K]        Link this machine to Invoke (opens the web app)
  push                     Graduate the local workspace to a durable cloud one

  Built-in tools: echo | time | http.get '{"url":"..."}'

This is a prototype (v${pkg.version}).`;

async function main() {
  const args = parse(process.argv.slice(2));
  const cmd = args._.shift();

  if (args.version) { console.log(`foundry ${pkg.version}`); return 0; }
  if (!cmd) { console.log(HELP); return 0; }

  const table = {
    login: commands.login, init: commands.init, run: commands.run,
    receipts: commands.receipts, status: commands.status, push: commands.push,
    workspace: commands.workspace, serve: commands.serve, trace: commands.trace,
    model: commands.model, policy: commands.policy, diff: commands.diff, mcp: commands.mcp,
  };
  const fn = table[cmd];
  if (!fn) {
    console.error(`foundry: unknown command '${cmd}'.\n`);
    console.log(HELP);
    return 2;
  }
  if (args.help) { console.log(HELP); return 0; }
  return await fn(args);
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(`foundry: error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
