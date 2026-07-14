"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const store = require("./store");
const { Ledger } = require("./ledger");
const { runTool, BUILTINS } = require("./tools");

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); return true; } catch { return false; }
}
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}
function requireProject() {
  const dir = store.findProject();
  if (!dir) {
    throw new Error("No foundry project here. Run `foundry init` first.");
  }
  return dir;
}

// ─────────────────────────────── login ───────────────────────────────
async function login(args) {
  const url = store.INVOKE_WEB + "/signup?from=foundry";
  console.log(`Foundry forges agents locally — you do ${b("not")} need to log in to build.`);
  console.log(`Logging in links this machine to ${b("Invoke")}, the platform you deploy to.\n`);
  let token = args.token;
  if (!token) {
    console.log(`Opening ${url} …  (sign in, create your team, copy your key)`);
    openBrowser(url);
    if (!process.stdin.isTTY) {
      throw new Error("Non-interactive shell — pass --token <invoke_key>.");
    }
    token = await ask("Paste your Invoke key (or Enter to stay local): ");
  }
  if (!token) {
    console.log(dim("\nStaying local. Build away — `foundry init` then `foundry run`."));
    return 0;
  }
  const cfg = store.readGlobalConfig();
  cfg.invoke_token = token.trim();
  cfg.invoke_base = args.baseUrl || cfg.invoke_base || (process.env.INVOKE_API_URL || "https://api.invokehq.run");
  cfg.linked_at = new Date().toISOString();
  store.writeGlobalConfig(cfg);
  console.log(green(`\n✔ Linked to Invoke.`) + ` You can now ${b("foundry push")} a local build to the cloud.`);
  console.log(dim(`(Prototype: paste-key stands in for the browser device-code flow.)`));
  return 0;
}

// ─────────────────────────────── init ───────────────────────────────
function init(args) {
  const name = args._[0] || path.basename(process.cwd());
  const dir = process.cwd();
  if (fs.existsSync(store.projectPath(dir)) && !args.force) {
    throw new Error("foundry.json already exists here (use --force to overwrite).");
  }
  const project = {
    name,
    // A ready-to-run sample agent so `foundry run` does something real immediately.
    agent: { id: "builder", tool: "http.get", params: { url: "https://api.github.com/zen" } },
    invoke: { workspace: null }, // filled by `foundry push` when you graduate to the cloud
  };
  store.writeProject(dir, project);
  const led = store.ledgerDir(dir);
  fs.mkdirSync(led, { recursive: true });
  new Ledger(led).secret(); // materialize the signing secret
  const gi = path.join(dir, ".gitignore");
  const line = ".foundry/\n";
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, line);
  else if (!fs.readFileSync(gi, "utf8").includes(".foundry")) fs.appendFileSync(gi, line);

  console.log(green(`✔ Forged local workspace "${name}"`) + `  ${dim("(governed, on-disk ledger — no account needed)")}`);
  console.log(`  ${dim("project:")} foundry.json     ${dim("ledger:")} .foundry/ledger.json\n`);
  console.log("Next:");
  console.log(`  ${b("foundry run")}                       ${dim("# run the sample agent, governed")}`);
  console.log(`  ${b("foundry run echo '{\"hi\":1}'")}       ${dim("# run a tool with dedup + a receipt")}`);
  console.log(`  ${b("foundry receipts --verify")}         ${dim("# prove the ledger")}`);
  return 0;
}

// ─────────────────────────────── run ───────────────────────────────
async function run(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));

  let tool, params, agent;
  if (args._[0]) {
    tool = args._[0];
    params = args._[1] ? parseJson(args._[1]) : {};
    agent = args.agent || project.agent?.id || "builder";
  } else {
    const a = project.agent || {};
    tool = a.tool; params = a.params || {}; agent = args.agent || a.id || "builder";
    if (!tool) throw new Error("No default agent in foundry.json. Try `foundry run <tool> '<json>'`.");
  }
  const key = args.key || args["idempotency-key"] || null;

  // Exactly-once: if this exact effect already committed, reconcile to its receipt
  // instead of running the tool again — the blind-retry / duplicate guard, locally.
  const dup = led.committed(led.effectKey(agent, tool, params, key));
  if (dup) {
    if (args.json) { console.log(JSON.stringify({ decision: "duplicate_blocked", receipt: dup.receipt, result: dup.result }, null, 2)); return 0; }
    console.log(yellow(`⧗ duplicate blocked`) + ` — identical effect already committed as receipt ${b(dup.receipt.number)}.`);
    console.log(dim("  reconciled (no re-execution). agent=") + agent + dim(" tool=") + tool);
    return 0;
  }

  const t0 = Date.now();
  let result, ok = true;
  try {
    result = await runTool(tool, params);
  } catch (e) {
    ok = false; result = { error: String(e.message || e) };
  }
  const effect = led.commit({ agent, tool, params, key, result });
  if (args.json) { console.log(JSON.stringify({ decision: ok ? "committed" : "committed_error", effect }, null, 2)); return ok ? 0 : 1; }

  console.log((ok ? green("✔ committed") : yellow("✔ committed (tool error captured)")) +
    `  ${dim(`${Date.now() - t0}ms`)}  agent=${b(agent)} tool=${b(tool)}`);
  console.log(`  receipt ${b(effect.receipt.number)}  ${dim("signed " + effect.receipt.alg)}`);
  console.log("  result: " + JSON.stringify(result).slice(0, 300));
  console.log(dim(`\n  run it again` + (key ? "" : " with --key K") + ` to see the duplicate guard · foundry receipts`));
  return ok ? 0 : 1;
}

// ─────────────────────────────── receipts ───────────────────────────────
function receipts(args) {
  const dir = requireProject();
  const led = new Ledger(store.ledgerDir(dir));
  if (args.verify) {
    const v = led.verify();
    if (v.ok) { console.log(green(`Ledger valid`) + ` — ${v.events} receipt(s), head ${v.head.slice(0, 16)}…`); return 0; }
    console.log(`\x1b[31mLedger INVALID\x1b[0m at ${v.at}: ${v.reason}`); return 1;
  }
  const effects = led.list();
  if (args.json) { console.log(JSON.stringify(effects, null, 2)); return 0; }
  if (!effects.length) { console.log("No receipts yet. Run `foundry run`."); return 0; }
  console.log("RECEIPT\t\tAGENT\t\tTOOL\t\tWHEN");
  for (const e of effects) {
    console.log(`${e.receipt.number}\t${(e.agent_id || "-").slice(0, 12)}\t${(e.tool || "-").slice(0, 12)}\t${(e.at || "").slice(11, 19)}`);
  }
  console.log(dim(`\n${effects.length} receipt(s). Prove them: foundry receipts --verify`));
  return 0;
}

// ─────────────────────────────── status ───────────────────────────────
function status() {
  const cfg = store.readGlobalConfig();
  const linked = cfg.invoke_token ? green("linked to Invoke") : dim("local only (not logged in)");
  console.log(`Foundry ${dim("— forge locally, deploy to Invoke")}`);
  console.log(`  account:   ${linked}`);
  const dir = store.findProject();
  if (!dir) { console.log(`  project:   ${dim("none here — run `foundry init`")}`); return 0; }
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const effects = led.list();
  console.log(`  project:   ${b(project.name)}  ${dim(dir)}`);
  console.log(`  workspace: ${green("local")} ${dim("(.foundry/ledger.json, governed)")}`);
  console.log(`  effects:   ${effects.length} committed`);
  console.log(`  cloud:     ${project.invoke?.workspace ? project.invoke.workspace : dim("not pushed — `foundry push` to graduate")}`);
  return 0;
}

// ─────────────────────────────── push (graduate → Invoke) ───────────────────────────────
function push() {
  const cfg = store.readGlobalConfig();
  if (!cfg.invoke_token) throw new Error("Not linked. Run `foundry login` to connect to Invoke first.");
  const dir = requireProject();
  const project = store.readProject(dir);
  const effects = new Ledger(store.ledgerDir(dir)).list();
  console.log(`Graduating ${b(project.name)} → Invoke (${effects.length} local effect(s))…`);
  console.log(yellow("  prototype:") + " cloud push is stubbed. This is where the local governed workspace");
  console.log("  becomes a durable, shareable, team-owned Invoke workspace (Postgres-backed).");
  console.log(dim("  next: mirror the local ledger to POST /v1/workspaces + gateway, pin the id here."));
  return 0;
}

module.exports = { login, init, run, receipts, status, push };

function parseJson(s) {
  try { const v = JSON.parse(s); if (v && typeof v === "object") return v; throw 0; }
  catch { throw new Error(`params must be a JSON object, got: ${s}`); }
}
