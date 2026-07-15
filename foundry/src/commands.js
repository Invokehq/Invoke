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

// The active target for run/receipts: "local" sandbox or the "cloud" Invoke workspace.
function activeTarget(project) {
  return project.target === "cloud" && project.invoke && project.invoke.workspace ? "cloud" : "local";
}
function cloudBase(project) {
  const cfg = store.readGlobalConfig();
  return (project.invoke && project.invoke.base) || cfg.invoke_base || process.env.INVOKE_API_URL || "https://api.invokehq.run";
}
async function invokeApi(base, apiPath, token, method = "GET", body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: { "X-API-Key": token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}
function isCloudError(env) {
  return !!(env && ((typeof env.error === "object" && env.error) || env.success === false));
}
function fmtBudget(bd) {
  if (!bd) return "-";
  const usd = (m) => "$" + ((Number(m) || 0) / 1e6).toFixed(2);
  return `${usd(bd.spent_micros)} spent / ${usd(bd.limit_micros)} limit`;
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

  // Follow the active target — no --cloud flag. Cloud routes through the Invoke gateway.
  if (activeTarget(project) === "cloud") return runCloud(project, { tool, params, agent, key }, args);

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
async function receipts(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  if (activeTarget(project) === "cloud") return receiptsCloud(project, args);
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

// ── cloud run: route the call through the graduated Invoke workspace's gateway ──
async function runCloud(project, { tool, params, agent, key }, args) {
  const cfg = store.readGlobalConfig();
  if (!cfg.invoke_token) throw new Error("Cloud target but not linked. Run `foundry login`, or `foundry workspace use local`.");
  const base = cloudBase(project);
  const ws = project.invoke.workspace;
  const argu = Object.assign({}, params, { _agent_id: agent });
  if (key) argu._idempotency_key = key;
  const t0 = Date.now();
  const { ok, status, json: env } = await invokeApi(base, `/v1/workspaces/${ws}/mcp`, cfg.invoke_token, "POST",
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: argu } });
  if (args.json) { console.log(JSON.stringify(env, null, 2)); return ok && !isCloudError(env) ? 0 : 1; }

  // Error shapes: JSON-RPC {error:{message,data.decision}}, {success:false,message},
  // a FastAPI {detail} on non-2xx, or any non-2xx status.
  const rpcErr = env && typeof env.error === "object" ? env.error : null;
  if (rpcErr || (env && env.success === false) || !ok) {
    const msg = (rpcErr && rpcErr.message) || (env && (env.message || env.detail || env.error)) || `HTTP ${status}`;
    const decision = rpcErr && rpcErr.data && rpcErr.data.decision;
    if (decision) { console.log(yellow(`⧗ ${decision}`) + ` — ${msg}  ${dim("(cloud)")}`); return 0; }
    console.log(yellow("cloud gateway: ") + msg);
    if (/not registered|not found|unknown|no tool/i.test(String(msg))) {
      console.log(dim(`  '${tool}' isn't connected to this workspace yet — that's what \`foundry workspace setup\` will do.`));
    }
    return 1;
  }
  console.log(green("✔ committed (cloud)") + `  ${dim(`${Date.now() - t0}ms`)}  agent=${b(agent)} tool=${b(tool)} ws=${b(ws)}`);
  const result = env && env.result !== undefined ? env.result : env;
  const rstr = JSON.stringify(result);
  console.log("  result: " + (rstr ? rstr.slice(0, 300) : String(result)));
  console.log(dim(`  governed + receipted in the cloud · foundry receipts`));
  return 0;
}

async function receiptsCloud(project, args) {
  const cfg = store.readGlobalConfig();
  const base = cloudBase(project);
  const ws = project.invoke.workspace;
  const { json } = await invokeApi(base, `/v1/workspaces/${ws}/effects?limit=${args.limit || 100}`, cfg.invoke_token);
  const effects = (json && json.effects) || [];
  if (args.verify) {
    // The cloud ledger is server-signed; confirm a receipt carries a signature.
    if (!effects.length) { console.log("No cloud receipts yet."); return 0; }
    const { json: r } = await invokeApi(base, `/v1/workspaces/${ws}/effects/${effects[0].effect_id}/receipt`, cfg.invoke_token);
    const signed = !!(r && r.receipt && r.receipt.signature);
    console.log((signed ? green("Cloud ledger signed") : yellow("no signature")) + ` — ${effects.length} receipt(s) in ${b(ws)}`);
    return signed ? 0 : 1;
  }
  if (args.json) { console.log(JSON.stringify({ workspace: ws, effects }, null, 2)); return 0; }
  if (!effects.length) { console.log(`No cloud receipts yet in ${b(ws)}. Run \`foundry run\`.`); return 0; }
  console.log(`RECEIPT\t\t\tAGENT\t\tTOOL\t\tSTATUS\tWHEN  ${dim("(cloud " + ws + ")")}`);
  for (const e of effects) {
    console.log(`${(e.effect_id || "-")}\t${(e.agent_id || "-").slice(0, 12)}\t${(e.target || e.action_type || "-").slice(0, 12)}\t${(e.status || "-").slice(0, 9)}\t${(e.created_at || "").slice(11, 19)}`);
  }
  console.log(dim(`\n${effects.length} governed call(s) in the cloud.`));
  return 0;
}

// ─────────────────────────────── workspace (active target) ───────────────────────────────
async function workspace(args) {
  if (args._[0] === "use") return workspaceUse(args);
  const dir = requireProject();
  const project = store.readProject(dir);
  const cfg = store.readGlobalConfig();
  const target = activeTarget(project);
  console.log(`Workspace ${dim("— the active target for run / receipts")}`);
  if (target === "local") {
    const n = new Ledger(store.ledgerDir(dir)).list().length;
    console.log(`  active:  ${green("local")} ${dim("sandbox")}   ${dim(n + " effect(s), .foundry/ledger.json")}`);
    const pushed = project.invoke && project.invoke.workspace;
    console.log(`  cloud:   ${pushed ? b(pushed) + dim("  — `foundry workspace use cloud`") : dim("none — `foundry push` to graduate")}`);
  } else {
    const ws = project.invoke.workspace, base = cloudBase(project);
    let budget = "-", effects = "-";
    try {
      const w = await invokeApi(base, `/v1/workspaces/${ws}`, cfg.invoke_token);
      budget = fmtBudget(w.json && (w.json.workspace ? w.json.workspace.budget : w.json.budget));
      const e = await invokeApi(base, `/v1/workspaces/${ws}/effects?limit=500`, cfg.invoke_token);
      effects = ((e.json && e.json.effects) || []).length;
    } catch { /* offline — show what we have */ }
    console.log(`  active:  ${green("cloud")}  ${b(ws)}   ${dim(base)}`);
    console.log(`  budget:  ${budget}`);
    console.log(`  effects: ${effects} governed call(s)`);
    console.log(`  switch:  ${dim("foundry workspace use local")}`);
  }
  return 0;
}

function workspaceUse(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const want = args._[1];
  if (want === "local") {
    project.target = "local"; store.writeProject(dir, project);
    console.log(green("✔ Active target: local sandbox") + dim("  — run/receipts are on-disk again."));
    return 0;
  }
  if (want === "cloud" || (want && want.startsWith("ws_"))) {
    const cfg = store.readGlobalConfig();
    if (!cfg.invoke_token) throw new Error("Not linked. Run `foundry login` first.");
    const ws = want === "cloud" ? (project.invoke && project.invoke.workspace) : want;
    if (!ws) throw new Error("No cloud workspace yet. Run `foundry push`, or `foundry workspace use <ws_id>`.");
    project.target = "cloud";
    project.invoke = Object.assign({}, project.invoke, { workspace: ws, base: cloudBase(project) });
    store.writeProject(dir, project);
    console.log(green("✔ Active target: cloud") + `  ${b(ws)}`);
    console.log(dim("  run/receipts now route through the cloud gateway (governed, durable)."));
    return 0;
  }
  throw new Error("Usage: foundry workspace use <local | cloud | ws_id>");
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
  const target = activeTarget(project);
  console.log(`  project:   ${b(project.name)}  ${dim(dir)}`);
  console.log(`  target:    ${target === "cloud" ? green("cloud ") + b(project.invoke.workspace) : green("local") + dim(" sandbox")}  ${dim("(foundry workspace use …)")}`);
  console.log(`  local:     ${effects.length} effect(s) ${dim(".foundry/ledger.json")}`);
  console.log(`  cloud:     ${project.invoke?.workspace ? project.invoke.workspace : dim("not pushed — `foundry push` to graduate")}`);
  return 0;
}

// ─────────────────────────────── push (graduate → Invoke) ───────────────────────────────
async function push(args) {
  const cfg = store.readGlobalConfig();
  if (!cfg.invoke_token) throw new Error("Not linked. Run `foundry login` to connect to Invoke first.");
  const dir = requireProject();
  const project = store.readProject(dir);
  const effects = new Ledger(store.ledgerDir(dir)).list();
  const base = args.baseUrl || cfg.invoke_base || process.env.INVOKE_API_URL || "https://api.invokehq.run";

  // Graduate: provision a real durable, isolated, org-owned workspace in the cloud.
  let wsId = project.invoke && project.invoke.workspace;
  if (!wsId) {
    const res = await fetch(base + "/v1/workspaces", {
      method: "POST",
      headers: { "X-API-Key": cfg.invoke_token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: project.name, budget_micros: 5000000 }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Invoke ${res.status}: ${text.slice(0, 200)}`);
    wsId = JSON.parse(text).workspace.id;
    project.invoke = Object.assign({}, project.invoke, { workspace: wsId, base });
    store.writeProject(dir, project);
  }
  if (args.json) { console.log(JSON.stringify({ graduated: true, workspace: wsId, base, local_effects: effects.length }, null, 2)); return 0; }
  console.log(green(`✔ Graduated "${project.name}" → Invoke`) + `  workspace ${b(wsId)}`);
  console.log(`  ${dim("durable, isolated, org-owned (Postgres-backed) — survives restarts, shareable with your team.")}`);
  console.log(`  ${effects.length} local effect(s) stay in your on-disk ledger; new cloud runs are governed there.`);
  console.log(dim(`  next: connect tools as governed connectors + route runs through the cloud gateway.`));
  return 0;
}

module.exports = { login, init, run, receipts, status, push, workspace };

function parseJson(s) {
  try { const v = JSON.parse(s); if (v && typeof v === "object") return v; throw 0; }
  catch { throw new Error(`params must be a JSON object, got: ${s}`); }
}
