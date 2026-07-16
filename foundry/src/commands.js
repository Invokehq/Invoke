"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const store = require("./store");
const { Ledger } = require("./ledger");
const { runTool, BUILTINS } = require("./tools");
const mcp = require("./mcp");
const policy = require("./policy");
const red = (s) => `\x1b[31m${s}\x1b[0m`;

// Execute a tool locally: a connector tool ("<connector>.<tool>") proxies to its MCP
// server; otherwise it's a built-in. The ledger (dedup + receipt) wraps this in run().
async function executeLocal(dir, tool, params) {
  const conns = store.readConnectors(dir);
  const dot = tool.indexOf(".");
  if (dot > 0) {
    const cname = tool.slice(0, dot);
    if (conns[cname]) return mcp.call(conns[cname].url, tool.slice(dot + 1), params);
  }
  return runTool(tool, params);
}

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

  // Policy gate — deny/approve before anything executes (local target).
  const decision = policy.evaluate(policy.loadPolicies(project), tool);
  if (decision.effect === "deny") {
    const e = led.commit({ agent, tool, params, key, status: "denied", result: { denied: true, rule: decision.rule }, duration_ms: 0 });
    console.log(red("✗ denied by policy") + ` — ${b(tool)} matches deny rule ${b(decision.rule)}.  ${dim(e.receipt.number)}`);
    return 1;
  }
  if (decision.effect === "approve") {
    let approved = !!(args.approve || args.yes);
    if (!approved && process.stdin.isTTY) {
      approved = (await ask(`${yellow("⚠")} ${b(tool)} requires approval (rule ${decision.rule}). Approve? [y/N] `)).toLowerCase().startsWith("y");
    }
    if (!approved) {
      const e = led.commit({ agent, tool, params, key, status: "blocked", result: { blocked: true, reason: "approval required", rule: decision.rule }, duration_ms: 0 });
      console.log(yellow("⧗ blocked") + ` — ${b(tool)} needs approval (rule ${b(decision.rule)}). Re-run with ${b("--approve")}.  ${dim(e.receipt.number)}`);
      return 1;
    }
  }

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
    result = await executeLocal(dir, tool, params);
  } catch (e) {
    ok = false; result = { error: String(e.message || e) };
  }
  const effect = led.commit({ agent, tool, params, key, result, duration_ms: Date.now() - t0 });
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

// ─────────────────────────────── trace (the execution pipeline) ───────────────────────────────
function fmtDur(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtCostMicros(micros) {
  const m = Number(micros) || 0;
  return "$" + (m > 0 && m < 10000 ? (m / 1e6).toFixed(4) : (m / 1e6).toFixed(2));
}
function execStatus(result) {
  if (result && (result.isError || result.error)) return "error";
  return "ok";
}
const TYPE_ICON = { model: "◇", tool: "▸", http: "⇄", memory: "▨", approval: "✋", mcp: "▸" };

async function trace(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  let rows, target;
  if (activeTarget(project) === "cloud") {
    const cfg = store.readGlobalConfig();
    const ws = project.invoke.workspace;
    const { json } = await invokeApi(cloudBase(project), `/v1/workspaces/${ws}/effects?limit=${args.limit || 100}`, cfg.invoke_token);
    rows = ((json && json.effects) || []).slice().reverse().map((e) => ({
      agent: e.agent_id, tool: e.target || e.action_type, type: /model/.test(e.action_type || "") ? "model" : "tool",
      dur: e.duration_ms, cost: e.cost_micros, status: e.status, receipt: e.effect_id,
    }));
    target = `cloud ${ws}`;
  } else {
    rows = new Ledger(store.ledgerDir(dir)).list().map((e) => ({
      agent: e.agent_id, tool: e.tool, type: e.type || "tool",
      dur: e.duration_ms, cost: e.cost_micros,
      status: e.status && e.status !== "committed" ? e.status : execStatus(e.result), receipt: e.receipt.number,
    }));
    target = "local";
  }
  if (args.json) { console.log(JSON.stringify({ target, executions: rows }, null, 2)); return 0; }
  if (!rows.length) { console.log(`No executions yet in ${target}. Run one, or point your agent at \`foundry serve\`.`); return 0; }

  const totalDur = rows.reduce((s, r) => s + (r.dur || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  console.log(`${b("Trace")} ${dim("— " + project.name + " (" + target + ")")}   ${rows.length} execution(s) · ${fmtDur(totalDur)} · ${fmtCostMicros(totalCost)}\n`);
  rows.forEach((r, i) => {
    const good = r.status === "ok" || r.status === "committed";
    const bad = r.status === "error" || r.status === "failed" || r.status === "denied";
    const stat = good ? green("✔") : bad ? "\x1b[31m✗\x1b[0m" : yellow("·");
    const agent = (r.agent || "-").slice(0, 14).padEnd(14);
    const tool = (r.tool || "-").slice(0, 26).padEnd(26);
    const type = (r.type || "").padEnd(6);
    const dur = fmtDur(r.dur).padStart(6);
    const cost = fmtCostMicros(r.cost).padStart(8);
    console.log(`  ${stat} ${TYPE_ICON[r.type] || "▸"} ${b(agent)} ${tool} ${dim(type)} ${dur} ${cost}  ${dim(r.receipt || "")}`);
    if (i < rows.length - 1) console.log(`  ${dim("↓")}`);
  });
  const agents = [...new Set(rows.map((r) => r.agent).filter(Boolean))];
  console.log(dim(`\n  agents: ${agents.join(", ")}   ·   prove it: foundry receipts --verify`));
  return 0;
}

// ─────────────────────────────── workspace (active target) ───────────────────────────────
async function workspace(args) {
  const sub = args._[0];
  if (sub === "use") return workspaceUse(args);
  if (sub === "connect") return workspaceConnect(args);
  if (sub === "tools") return workspaceTools(args);
  if (sub === "setup") return workspaceSetup(args);
  const dir = requireProject();
  const project = store.readProject(dir);
  const cfg = store.readGlobalConfig();
  const target = activeTarget(project);
  console.log(`Workspace ${dim("— the active target for run / receipts")}`);
  if (target === "local") {
    const n = new Ledger(store.ledgerDir(dir)).list().length;
    const conns = Object.keys(store.readConnectors(dir));
    console.log(`  active:  ${green("local")} ${dim("sandbox")}   ${dim(n + " effect(s), .foundry/ledger.json")}`);
    console.log(`  tools:   ${BUILTINS.length} built-in${conns.length ? " + " + conns.length + " connector(s) " + dim("(" + conns.join(", ") + ")") : ""}`);
    if (project.budget_usd) console.log(`  budget:  $${Number(project.budget_usd).toFixed(2)} ${dim("cap")}`);
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

// foundry workspace connect <name> <mcp_url> — wire a real MCP tool into the active workspace.
async function workspaceConnect(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const name = args._[1];
  const url = args._[2];
  if (!name || !url) throw new Error("Usage: foundry workspace connect <name> <mcp_url>");
  if (activeTarget(project) === "cloud") {
    const cfg = store.readGlobalConfig();
    const { ok, status, json } = await invokeApi(cloudBase(project), `/v1/workspaces/${project.invoke.workspace}/connectors`, cfg.invoke_token, "POST", { name, mcp_url: url });
    if (!ok) throw new Error(`Invoke ${status}: ${(json && (json.detail || json.message)) || "connect failed"}`);
    const c = (json && json.connector) || {};
    console.log(green(`✔ Connected ${b(name)}`) + ` to cloud ${b(project.invoke.workspace)} — ${c.tools_count != null ? c.tools_count : "?"} tool(s) governed.`);
    console.log(dim(`  run one:  foundry run ${name}.<tool> '<json>'   ·   list:  foundry workspace tools`));
    return 0;
  }
  // local: handshake the MCP server, import its tool defs into the local sandbox.
  const { tools } = await mcp.connect(url);
  const conns = store.readConnectors(dir);
  conns[name] = { url, tools, connected_at: new Date().toISOString() };
  store.writeConnectors(dir, conns);
  console.log(green(`✔ Connected ${b(name)}`) + ` — ${tools.length} tool(s), governed by your local ledger.`);
  for (const t of tools.slice(0, 6)) console.log(`  ${name}.${t.name}  ${dim((t.description || "").replace(/\s+/g, " ").slice(0, 66))}`);
  if (tools.length > 6) console.log(dim(`  …and ${tools.length - 6} more`));
  console.log(dim(`  run one:  foundry run ${name}.${tools[0] ? tools[0].name : "<tool>"} '<json>'`));
  return 0;
}

// foundry workspace tools — list the tools available in the active workspace.
async function workspaceTools(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  if (activeTarget(project) === "cloud") {
    const cfg = store.readGlobalConfig();
    const { json } = await invokeApi(cloudBase(project), `/v1/workspaces/${project.invoke.workspace}/mcp`, cfg.invoke_token, "POST",
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = (json && json.result && json.result.tools) || [];
    if (args.json) { console.log(JSON.stringify(tools, null, 2)); return 0; }
    console.log(`${tools.length} tool(s) in cloud ${b(project.invoke.workspace)}:`);
    for (const t of tools) console.log(`  ${t.name}  ${dim((t.description || "").replace(/\s+/g, " ").slice(0, 70))}`);
    return 0;
  }
  const conns = store.readConnectors(dir);
  if (args.json) { console.log(JSON.stringify({ builtins: BUILTINS, connectors: conns }, null, 2)); return 0; }
  console.log(`Built-in:  ${BUILTINS.join(", ")}`);
  const names = Object.keys(conns);
  if (!names.length) { console.log(dim("Connectors: none — `foundry workspace connect <name> <mcp_url>`")); return 0; }
  for (const n of names) {
    console.log(`${b(n)} ${dim(conns[n].url)}`);
    for (const t of conns[n].tools) console.log(`  ${n}.${typeof t === "string" ? t : t.name}`);
  }
  return 0;
}

// foundry workspace setup — guided: connect a tool + set a budget, then confirm ready.
async function workspaceSetup(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const target = activeTarget(project);
  console.log(`Setting up the ${target === "cloud" ? green("cloud") : green("local")} workspace ${dim("— connect tools + a budget")}\n`);

  // 1) connect a tool.  --connect name=url  (or interactive)
  let spec = args.connect;
  if (!spec && process.stdin.isTTY) {
    const url = await ask("Connect an MCP tool — server URL (Enter to skip): ");
    if (url) { const nm = await ask("  name it (e.g. deepwiki): "); spec = `${nm || "tool"}=${url}`; }
  }
  if (spec) {
    const eq = spec.indexOf("=");
    const name = eq > 0 ? spec.slice(0, eq) : spec;
    const url = eq > 0 ? spec.slice(eq + 1) : null;
    if (!url) throw new Error("--connect expects name=<mcp_url>");
    await workspaceConnect(Object.assign({}, args, { _: ["connect", name, url] }));
  } else {
    console.log(dim("  (no tool connected — foundry workspace connect <name> <url> anytime)"));
  }

  // 2) budget.  --budget <usd>  (or interactive)
  let budget = args.budget;
  if (budget == null && process.stdin.isTTY) budget = await ask("\nBudget cap in USD (Enter for $5): ");
  const usd = Number(budget) > 0 ? Number(budget) : 5;
  project.budget_usd = usd;
  store.writeProject(dir, project);
  console.log(`\n${green("✔ budget")} ${b("$" + usd.toFixed(2))} ${dim(target === "cloud" ? "(cloud budget is enforced server-side; set at push)" : "(local cap, shown in `foundry workspace`)")}`);

  console.log(green(`\n✔ ${project.name} is set up.`) + `  Run:  ${b("foundry run <tool> '<json>'")}  ·  see tools:  ${b("foundry workspace tools")}`);
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

// ─────────────────────────────── serve (the MCP gateway) ───────────────────────────────
async function serve(args) {
  const dir = requireProject();
  const conns = Object.keys(store.readConnectors(dir));
  // Guidance goes to stderr — stdout is the MCP JSON-RPC channel.
  process.stderr.write(green("foundry serve") + dim(" — governed MCP gateway for your coding agent\n"));
  if (!conns.length) {
    process.stderr.write(dim("  no tools connected yet — `foundry workspace connect <name> <mcp_url>` first.\n"));
  }
  process.stderr.write(dim("  point Claude Code / Cursor at this command, e.g.:  claude mcp add foundry -- foundry serve\n"));
  const { serve: runServer } = require("./serve");
  await runServer(dir, args);
  return 0;
}

// ─────────────────────────────── model (governed LLM proxy) ───────────────────────────────
async function model(args) {
  if (args._[0] === "serve") {
    const dir = requireProject();
    process.stderr.write(green("foundry model serve") + dim(" — governed LLM proxy (OpenAI-compatible)\n"));
    const { serveModel } = require("./model");
    await serveModel(dir, { port: args.port, upstream: args.upstream, keyEnv: args.key });
    return 0;
  }
  console.log(`${b("foundry model")} — govern model calls as Executions (cost, budget, cache).`);
  console.log(`  ${b("foundry model serve")} [--port 4000] [--upstream URL] [--key ENVVAR]`);
  console.log(dim("  Point your agent's SDK at the proxy:  OPENAI_BASE_URL=http://localhost:4000/v1"));
  console.log(dim("  Then see spend + latency in  foundry trace  ·  foundry receipts"));
  return 0;
}

// ─────────────────────────────── policy (execution control) ───────────────────────────────
async function policyCmd(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const sub = args._[0];
  const pol = policy.loadPolicies(project);

  if (["allow", "deny", "approve"].includes(sub)) {
    const pattern = args._[1];
    if (!pattern) throw new Error(`Usage: foundry policy ${sub} <pattern>   (e.g. 'stripe.*')`);
    project.policies = project.policies || {};
    project.policies[sub] = [...new Set([...(project.policies[sub] || []), pattern])];
    store.writeProject(dir, project);
    const color = sub === "deny" ? red : sub === "approve" ? yellow : green;
    console.log(green("✔") + ` policy ${color(sub)}: ${b(pattern)}`);
    return 0;
  }
  if (sub === "rm") {
    const pattern = args._[1];
    project.policies = project.policies || {};
    for (const k of ["deny", "approve", "allow"]) project.policies[k] = (project.policies[k] || []).filter((g) => g !== pattern);
    store.writeProject(dir, project);
    console.log(`removed ${b(pattern)} from all lists.`);
    return 0;
  }
  if (sub === "test") {
    const name = args._[1];
    if (!name) throw new Error("Usage: foundry policy test <tool-or-model>");
    const r = policy.evaluate(pol, name);
    const color = r.effect === "deny" ? red : r.effect === "approve" ? yellow : green;
    console.log(`${b(name)} -> ${color(r.effect)}${r.rule ? dim(" (rule: " + r.rule + ")") : dim(" (default)")}`);
    return 0;
  }
  // show
  const showList = (label, arr, color) => {
    console.log(`${label}`);
    if (arr.length) arr.forEach((g) => console.log(`  ${color(g)}`));
    else console.log(dim("  (none)"));
  };
  console.log(`Policies ${dim("— evaluated on every execution · deny > approve > allow > default allow")}\n`);
  showList(red("deny"), pol.deny, red);
  showList(yellow("approve"), pol.approve, yellow);
  showList(green("allow"), pol.allow, green);
  console.log(dim("\n  add:  foundry policy deny 'stripe.*'   ·   gate:  foundry policy approve 'github.create_*'"));
  console.log(dim("  test: foundry policy test github.read"));
  return 0;
}

module.exports = { login, init, run, receipts, status, push, workspace, serve, trace, model, policy: policyCmd };

function parseJson(s) {
  try { const v = JSON.parse(s); if (v && typeof v === "object") return v; throw 0; }
  catch { throw new Error(`params must be a JSON object, got: ${s}`); }
}
