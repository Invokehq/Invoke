"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const store = require("./store");
const { Ledger } = require("./ledger");
const { runTool, BUILTINS, toolType } = require("./tools");
const mcp = require("./mcp");
const policy = require("./policy");
const cloud = require("./cloud");
const memory = require("./memory");
const embeddings = require("./embeddings");
const coord = require("./coord");
const { Approvals } = require("./approvals");
const budget = require("./budget");
const red = (s) => `\x1b[31m${s}\x1b[0m`;

// Execute a tool locally: a connector tool ("<connector>.<tool>") proxies to its MCP
// server; otherwise it's a built-in. The ledger (dedup + receipt) wraps this in run().
async function executeLocal(dir, tool, params, project) {
  const conns = store.readConnectors(dir);
  // `memory.*` is a reserved namespace: the Context layer, governed like any Execution.
  if (tool.startsWith("memory.")) return memory.runMemoryTool(dir, tool, params, project || store.readProject(dir));
  const dot = tool.indexOf(".");
  if (dot > 0) {
    const cname = tool.slice(0, dot);
    if (conns[cname]) return mcp.call(conns[cname], tool.slice(dot + 1), params);
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

// Like requireProject, but auto-creates a minimal local workspace if there's none — so
// `claude mcp add foundry -- foundry serve` just works in any directory (no `init` first).
function ensureProject() {
  const found = store.findProject();
  if (found) return { dir: found, created: false };
  const dir = process.cwd();
  store.writeProject(dir, { name: path.basename(dir) || "foundry", agent: { id: "builder", tool: "http.get", params: { url: "https://api.github.com/zen" } }, invoke: { workspace: null } });
  const led = store.ledgerDir(dir);
  fs.mkdirSync(led, { recursive: true });
  new Ledger(led).secret();
  return { dir, created: true };
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
    const e = led.commit({ agent, tool, params, key, type: toolType(tool), status: "denied", result: { denied: true, rule: decision.rule }, duration_ms: 0 });
    console.log(red("✗ denied by policy") + ` — ${b(tool)} matches deny rule ${b(decision.rule)}.  ${dim(e.receipt.number)}`);
    return 1;
  }
  if (decision.effect === "approve") {
    let approved = !!(args.approve || args.yes);
    if (!approved && process.stdin.isTTY) {
      approved = (await ask(`${yellow("⚠")} ${b(tool)} requires approval (rule ${decision.rule}). Approve? [y/N] `)).toLowerCase().startsWith("y");
    }
    if (!approved) {
      const e = led.commit({ agent, tool, params, key, type: toolType(tool), status: "blocked", result: { blocked: true, reason: "approval required", rule: decision.rule }, duration_ms: 0 });
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
    result = await executeLocal(dir, tool, params, project);
  } catch (e) {
    ok = false; result = { error: String(e.message || e) };
  }
  const effect = led.commit({ agent, tool, params, key, result, type: toolType(tool), cost_micros: result && result.cost_micros, duration_ms: Date.now() - t0 });

  // If the project is graduated to Invoke, mirror this Execution to the cloud ledger so
  // it shows up live on the dashboard. Best-effort — never fails the local run.
  const link = cloud.cloudLink(project);
  const mirror = link ? await cloud.mirrorEffect(link, effect) : null;

  if (args.json) { console.log(JSON.stringify({ decision: ok ? "committed" : "committed_error", effect, mirrored: !!(mirror && mirror.mirrored) }, null, 2)); return ok ? 0 : 1; }

  console.log((ok ? green("✔ committed") : yellow("✔ committed (tool error captured)")) +
    `  ${dim(`${Date.now() - t0}ms`)}  agent=${b(agent)} tool=${b(tool)}`);
  console.log(`  receipt ${b(effect.receipt.number)}  ${dim("signed " + effect.receipt.alg)}`);
  if (mirror && mirror.mirrored) console.log(`  ${green("↑")} mirrored to Invoke  ${dim(link.wsId + " · live on the dashboard")}`);
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
const TYPE_ICON = { model: "◇", tool: "▸", http: "⇄", file: "▤", memory: "▨", approval: "✋", mcp: "▸", setup: "⚙", coord: "⑃" };

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
  const following = (args.follow || args.f) && target === "local";
  if (!rows.length && !following) { console.log(`No executions yet in ${target}. Run one, or point your agent at \`foundry serve\`.`); return 0; }
  if (!rows.length && following) {
    console.log(`${b("Trace")} ${dim("— " + project.name + " (" + target + ") · waiting for the agent…")}`);
    console.log(`\n  ${green("● LIVE")} ${dim("— new executions stream below (Ctrl-C to stop)")}`);
    console.log(dim("  " + "─".repeat(60)));
    return liveTail(dir);
  }

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
  if ((args.follow || args.f) && target === "local") {
    console.log(`\n  ${green("● LIVE")} ${dim("— new executions stream below (Ctrl-C to stop)")}`);
    console.log(dim("  " + "─".repeat(60)));
    return liveTail(dir);
  }
  return 0;
}

// ─────────────────────────────── diff (why A vs B) ───────────────────────────────
function textPreview(result) {
  if (!result || typeof result !== "object") return String(result ?? "");
  if (Array.isArray(result.choices) && result.choices[0]) return String(result.choices[0].message ? result.choices[0].message.content : "").trim();
  if (Array.isArray(result.content) && result.content[0]) return String(result.content[0].text || "").trim();
  if (result.error || result.denied || result.blocked) return JSON.stringify(result);
  return JSON.stringify(result);
}
function diffPair(label, av, bv) {
  const same = av === bv;
  const mark = same ? dim("=") : yellow("≠");
  return `  ${label.padEnd(10)} ${mark}  ${(av || "-").toString().padEnd(24)} ${same ? "" : (bv || "-")}`;
}
async function diff(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const [ref1, ref2] = [args._[0], args._[1]];
  if (!ref1 || !ref2) throw new Error("Usage: foundry diff <ref1> <ref2>   (receipt #ids or effect ids)");

  let list;
  if (activeTarget(project) === "cloud") {
    const cfg = store.readGlobalConfig();
    const { json } = await invokeApi(cloudBase(project), `/v1/workspaces/${project.invoke.workspace}/effects?limit=500`, cfg.invoke_token);
    list = ((json && json.effects) || []).map((e) => ({ id: e.effect_id, num: e.effect_id, type: /model/.test(e.action_type || "") ? "model" : "tool", agent: e.agent_id, tool: e.target || e.action_type, status: e.status, dur: e.duration_ms, cost: e.cost_micros, result: e.result }));
  } else {
    list = new Ledger(store.ledgerDir(dir)).list().map((e) => ({ id: e.effect_id, num: e.receipt.number, type: e.type, agent: e.agent_id, tool: e.tool, status: e.status, dur: e.duration_ms, cost: e.cost_micros, result: e.result }));
  }
  const find = (ref) => { const r = ref.replace(/^#/, ""); return list.find((e) => e.num === ref || e.num === "#" + r || e.id === ref || (e.id && e.id.startsWith(r)) || (e.num && e.num.replace(/^#/, "").startsWith(r))); };
  const A = find(ref1), B = find(ref2);
  if (!A) throw new Error(`no execution matching ${ref1}`);
  if (!B) throw new Error(`no execution matching ${ref2}`);

  if (args.json) { console.log(JSON.stringify({ a: A, b: B }, null, 2)); return 0; }
  const pa = textPreview(A.result), pb = textPreview(B.result);
  console.log(`${b("Diff")}  ${dim(A.num + "  vs  " + B.num)}\n`);
  console.log(`  ${dim("field".padEnd(10))}     ${dim(String(A.num).padEnd(24))} ${dim(B.num)}`);
  console.log(diffPair("type", A.type, B.type));
  console.log(diffPair("agent", A.agent, B.agent));
  console.log(diffPair("tool", A.tool, B.tool));
  console.log(diffPair("status", A.status, B.status));
  console.log(diffPair("duration", fmtDur(A.dur), fmtDur(B.dur)));
  console.log(diffPair("cost", fmtCostMicros(A.cost), fmtCostMicros(B.cost)));
  console.log(diffPair("output", pa === pb ? "same" : "differ", pa === pb ? "same" : ""));
  if (pa !== pb) {
    console.log(`\n  ${dim(A.num + " output:")} ${pa.replace(/\s+/g, " ").slice(0, 90)}`);
    console.log(`  ${dim(B.num + " output:")} ${pb.replace(/\s+/g, " ").slice(0, 90)}`);
  }
  // the insight line
  const notes = [];
  const ca = Number(A.cost) || 0, cb = Number(B.cost) || 0;
  if (ca && cb && ca !== cb) { const lo = ca < cb ? A : B; notes.push(`${lo.num} ${(Math.max(ca, cb) / Math.min(ca, cb)).toFixed(1)}× cheaper`); }
  if (A.dur && B.dur && A.dur !== B.dur) { const f = A.dur < B.dur ? A : B; notes.push(`${f.num} ${(Math.max(A.dur, B.dur) / Math.min(A.dur, B.dur)).toFixed(1)}× faster`); }
  if (A.status !== B.status) notes.push(`status differs (${A.status} vs ${B.status})`);
  notes.push(pa === pb ? "same output" : "outputs differ");
  console.log(dim(`\n  ↳ ${notes.join(" · ")}`));
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

// Build a connector descriptor from CLI flags. Two transports, because the ecosystem has
// two shapes: hosted HTTP servers (deepwiki, Vercel — often token-gated) and stdio servers
// launched via npx (Slack, GitHub, Postgres, …). Secrets are stored as ${VAR} references,
// never values: `--env SLACK_BOT_TOKEN` records the *name*, resolved from your env at call time.
function connectorFromArgs(args, url) {
  const cmd = args.cmd || args.command;
  if (cmd) {
    const parts = String(cmd).trim().split(/\s+/);
    const env = {};
    for (const e of [].concat(args.env || [])) {
      if (e === true) continue;
      const eq = String(e).indexOf("=");
      if (eq > 0) env[String(e).slice(0, eq)] = String(e).slice(eq + 1);
      else env[String(e)] = ""; // "" = pass this var through from the environment
    }
    return { transport: "stdio", command: parts[0], args: parts.slice(1), env };
  }
  const headers = {};
  for (const h of [].concat(args.header || [])) {
    if (h === true) continue;
    const i = String(h).indexOf(":");
    if (i > 0) headers[String(h).slice(0, i).trim()] = String(h).slice(i + 1).trim();
  }
  if (args.token) headers["Authorization"] = `Bearer ${args.token}`;
  return { transport: "http", url, headers };
}

// foundry workspace connect <name> <mcp_url|--cmd "..."> — wire a real MCP tool in.
async function workspaceConnect(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const name = args._[1];
  const url = args._[2];
  if (!name || (!url && !(args.cmd || args.command))) {
    throw new Error(
      "Usage:\n" +
      "  foundry workspace connect <name> <mcp_url> [--header \"Authorization: Bearer ${TOKEN}\"]\n" +
      "  foundry workspace connect <name> --cmd \"npx -y <mcp-server-pkg>\" [--env VAR]"
    );
  }
  if (activeTarget(project) === "cloud") {
    const cfg = store.readGlobalConfig();
    const { ok, status, json } = await invokeApi(cloudBase(project), `/v1/workspaces/${project.invoke.workspace}/connectors`, cfg.invoke_token, "POST", { name, mcp_url: url });
    if (!ok) throw new Error(`Invoke ${status}: ${(json && (json.detail || json.message)) || "connect failed"}`);
    const c = (json && json.connector) || {};
    console.log(green(`✔ Connected ${b(name)}`) + ` to cloud ${b(project.invoke.workspace)} — ${c.tools_count != null ? c.tools_count : "?"} tool(s) governed.`);
    console.log(dim(`  run one:  foundry run ${name}.<tool> '<json>'   ·   list:  foundry workspace tools`));
    return 0;
  }
  // local: handshake the MCP server (http or stdio), import its tool defs into the sandbox.
  const desc = connectorFromArgs(args, url);
  const { tools } = await mcp.connect(desc);
  const conns = store.readConnectors(dir);
  conns[name] = Object.assign({}, desc, { tools, connected_at: new Date().toISOString() });
  store.writeConnectors(dir, conns);
  console.log(green(`✔ Connected ${b(name)}`) + ` ${dim("via " + desc.transport)} — ${tools.length} tool(s), governed by your local ledger.`);
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
  // Backfill: stream every committed local effect up to the cloud ledger so the dashboard
  // isn't empty on arrival — the agents' history is there the moment you open it.
  const link = cloud.cloudLink(store.readProject(dir));
  const back = link ? await cloud.mirrorAll(link, effects) : { sent: 0, failed: 0 };
  const dashUrl = `${store.INVOKE_WEB}/dashboard/runtime?ws=${wsId}`;

  if (args.json) { console.log(JSON.stringify({ graduated: true, workspace: wsId, base, local_effects: effects.length, mirrored: back.sent, dashboard: dashUrl }, null, 2)); return 0; }
  console.log(green(`✔ Graduated "${project.name}" → Invoke`) + `  workspace ${b(wsId)}`);
  console.log(`  ${dim("durable, isolated, org-owned (Postgres-backed) — survives restarts, shareable with your team.")}`);
  console.log(`  ${green("↑")} streamed ${b(String(back.sent))} of ${effects.length} local effect(s) to the cloud ledger` + (back.failed ? dim(`  (${back.failed} failed)`) : ""));
  console.log(`  ${b("Watch it live:")}  ${dashUrl}`);
  console.log(dim(`  from here, every \`foundry run\` and every tool call through \`foundry serve\` streams to the dashboard.`));
  return 0;
}

// ─────────────────────────────── serve (the MCP gateway) ───────────────────────────────
async function serve(args) {
  const { dir, created } = ensureProject();
  const conns = Object.keys(store.readConnectors(dir));
  // Guidance goes to stderr — stdout is the MCP JSON-RPC channel.
  process.stderr.write(green("foundry serve") + dim(" — governed MCP gateway for your coding agent\n"));
  if (created) process.stderr.write(dim(`  initialized a local workspace here (${dir})\n`));
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

// ─────────────────────────────── mcp (wire into a coding agent) ───────────────────────────────
// Merge foundry into an mcpServers-style JSON config (create/update), preserving others.
function writeMcpServers(file, server) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let json = {};
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { json = {}; }
  json.mcpServers = json.mcpServers || {};
  const existed = !!json.mcpServers.foundry;
  json.mcpServers.foundry = server;
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return existed;
}

async function mcpCmd(args) {
  const os = require("node:os");
  const sub = args._[0] || "list";
  const server = { command: "foundry", args: ["serve"] };
  const cfg = { mcpServers: { foundry: server } };
  const printJson = (label) => { console.log(dim(label)); console.log(JSON.stringify(cfg, null, 2)); };

  if (sub === "add") {
    const client = (args.client || "claude").toLowerCase();
    switch (client) {
      case "claude":
      case "claude-code": {
        const scope = args.scope ? ["-s", String(args.scope)] : [];
        const r = require("node:child_process").spawnSync("claude", ["mcp", "add", "foundry", ...scope, "--", "foundry", "serve"], { stdio: "inherit" });
        if (r.error) { console.log(yellow("claude CLI not found.")); printJson("Add manually:"); return 1; }
        console.log(green("\n✔ wired into Claude Code.") + dim("  verify: claude mcp list"));
        return r.status || 0;
      }
      case "cursor": {
        const file = path.join(process.cwd(), ".cursor", "mcp.json");
        const existed = writeMcpServers(file, server);
        console.log(green(`✔ ${existed ? "updated" : "wrote"} ${file}`) + dim("  — restart Cursor; foundry's tools appear."));
        return 0;
      }
      case "windsurf": {
        const file = path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");
        const existed = writeMcpServers(file, server);
        console.log(green(`✔ ${existed ? "updated" : "wrote"} ${file}`) + dim("  — restart Windsurf."));
        return 0;
      }
      case "vscode":
      case "cline":
        printJson("Add to your VS Code / Cline MCP settings (mcpServers):");
        return 0;
      case "claude-desktop": {
        const p = process.platform === "darwin" ? "~/Library/Application Support/Claude/claude_desktop_config.json"
          : process.platform === "win32" ? "%APPDATA%\\Claude\\claude_desktop_config.json"
          : "~/.config/Claude/claude_desktop_config.json";
        printJson(`Add to Claude Desktop config (${p}) and restart:`);
        return 0;
      }
      case "codex":
        console.log(dim("Add to ~/.codex/config.toml:"));
        console.log('[mcp_servers.foundry]\ncommand = "foundry"\nargs = ["serve"]');
        return 0;
      default:
        printJson(`Config for ${client} (add to its MCP settings):`);
        return 0;
    }
  }

  // list / bare — every supported client
  console.log(`${b("Wire Foundry into your agent")} ${dim("— it speaks standard MCP, so any client works.")}\n`);
  console.log(`  ${b("Claude Code")}      foundry mcp add`);
  console.log(`  ${b("Cursor")}           foundry mcp add --client cursor        ${dim("(writes .cursor/mcp.json)")}`);
  console.log(`  ${b("Windsurf")}         foundry mcp add --client windsurf`);
  console.log(`  ${b("Claude Desktop")}   foundry mcp add --client claude-desktop`);
  console.log(`  ${b("Codex")}            foundry mcp add --client codex`);
  console.log(`  ${b("VS Code / Cline")}  foundry mcp add --client vscode`);
  console.log(dim("\nGeneric MCP config (any client):"));
  console.log(JSON.stringify(cfg, null, 2));
  console.log(dim("\nModel calls too — point OPENAI_BASE_URL at `foundry model serve`: works with any OpenAI-SDK framework."));
  return 0;
}

// ─────────────────────────────── memory (the Context layer) ───────────────────────────────
// foundry memory set|get|search — shared workspace memory, governed like any Execution.
// Every op goes through the ledger (type `memory`), so context changes are receipted too.
async function memoryCmd(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const sub = args._[0];
  const agent = args.agent || project.agent?.id || "builder";

  const link = cloud.cloudLink(project);
  const commit = async (tool, params, result) => {
    const eff = led.commit({ agent, tool, params, key: null, result, type: "memory", cost_micros: result && result.cost_micros, duration_ms: 0 });
    if (link) { try { await cloud.mirrorEffect(link, eff); } catch { /* offline — stays local */ } }
    return eff;
  };

  // Configure / show the embeddings provider that turns lexical memory into semantic memory.
  if (sub === "provider") {
    const url = args._[1], model = args._[2];
    if (url) { project.embeddings = { url, model: model || project.embeddings?.model || "text-embedding-3-small" }; store.writeProject(dir, project); }
    const prov = embeddings.provider(project);
    if (!prov) {
      console.log(`${yellow("○ no embeddings provider")} — memory search is ${b("lexical")} (keyword).`);
      console.log(dim("  turn on semantic search (pick one):"));
      console.log(`    ${b("local, free:")}   foundry memory provider http://localhost:11434/v1/embeddings nomic-embed-text   ${dim("(Ollama)")}`);
      console.log(`    ${b("openai:")}        export OPENAI_API_KEY=sk-…   ${dim("(defaults to text-embedding-3-small)")}`);
      return 0;
    }
    console.log(`${green("✔ embeddings provider")}  ${b(prov.model)}  ${dim(prov.url)}${prov.key ? dim("  · key set") : ""}`);
    console.log(dim(`  memory search is now semantic. backfill existing facts:  foundry memory reindex`));
    return 0;
  }

  // Backfill vectors for facts written before a provider was configured (or while offline).
  if (sub === "reindex") {
    const r = await memory.reindex(dir, project);
    if (r.error) { console.log(`${yellow("○")} ${r.error} — see ${b("foundry memory provider")}`); return 1; }
    if (r.reindexed) await commit("memory.reindex", { model: r.model }, r);
    console.log(`${green("✔ reindexed")} ${b(String(r.reindexed))} fact(s) with ${b(r.model)}  ${dim(fmtCostMicros(r.cost_micros || 0))}`);
    return 0;
  }

  if (sub === "set") {
    const key = args._[1], content = args._[2] || args.content;
    if (!content) throw new Error(`Usage: foundry memory set <key> "<fact>" [--ttl 3600] [--tags a,b]`);
    const params = { key, content, agent, shared: !!args.shared, ttl_seconds: args.ttl ? Number(args.ttl) : undefined, tags: args.tags ? String(args.tags).split(",") : undefined };
    const r = await memory.runMemoryTool(dir, "memory.set", params, project);
    const eff = await commit("memory.set", { key, content }, r);

    // Graduated? Share the fact with the workspace so other agents/machines see it — and
    // learn from the cloud whether a *remote* agent had a different value under this key.
    const link = cloud.cloudLink(project);
    const remote = link ? await cloud.mirrorMemory(link, params) : null;

    if (args.json) { console.log(JSON.stringify(Object.assign({}, r, { remote }), null, 2)); return 0; }
    if (remote && remote.conflict && !r.conflict) {
      console.log(`${yellow("⚠ contested remotely")} — another agent in ${b(link.wsId)} had a different value for ${b(key)}.`);
      console.log(`  ${dim("theirs:")}  ${remote.previous}`);
      console.log(`  ${dim("yours:")}   ${content}`);
      console.log(dim(`  your local copy was not stale — but the shared fact was. Both are kept in revisions.`));
    }
    if (r.conflict) {
      // The stale-context moment: you just replaced someone else's fact.
      console.log(`${yellow("⚠ contested")} — ${b(key)} held a different value (v${r.memory.version - 1}, by ${b(r.memory.revisions.slice(-1)[0].by || "?")}).`);
      console.log(`  ${dim("was:")}  ${r.previous}`);
      console.log(`  ${dim("now:")}  ${r.memory.content}`);
      console.log(dim(`  the prior value is kept in revisions — nothing was silently overwritten.`));
    } else {
      const scopeTag = r.scope === "shared" ? green(" [shared]") + dim(" — every project sees this") : "";
      console.log(`${green(r.updated ? "✔ updated" : "✔ remembered")}  ${key ? b(key) : dim("(unkeyed)")}  ${dim("v" + r.memory.version)}${r.embedded ? dim("  · embedded (semantic)") : ""}${scopeTag}`);
    }
    console.log(`  receipt ${b(eff.receipt.number)}  ${dim("memory Execution — receipted like any side effect")}`);
    return 0;
  }

  if (sub === "get") {
    const key = args._[1];
    if (!key) throw new Error("Usage: foundry memory get <key>");
    const r = await memory.runMemoryTool(dir, "memory.get", { key }, project);
    await commit("memory.get", { key }, r);
    if (args.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    if (!r.found) { console.log(dim(`no fact for key ${b(key)}`)); return 1; }
    console.log(`${b(key)}  ${dim("v" + r.version + " · by " + (r.updated_by || "?") + " · " + r.updated_at)}`);
    console.log(`  ${r.content}`);
    if (r.stale) console.log(`  ${yellow("⚠ stale")} ${dim("— TTL expired " + r.expires_at + "; re-verify before acting on it.")}`);
    if (r.contested) console.log(`  ${yellow("⚠ contested")} ${dim("— a different value was replaced (v" + r.version + "). See revisions.")}`);
    if (r.revisions && r.revisions.length) {
      console.log(dim(`  revisions (${r.revisions.length}):`));
      for (const rev of r.revisions.slice(-3)) console.log(dim(`    v${rev.version} · ${rev.by || "?"} · ${String(rev.content).slice(0, 60)}`));
    }
    return 0;
  }

  if (sub === "search" || sub === "list") {
    const q = sub === "search" ? args._[1] : undefined;
    const r = await memory.runMemoryTool(dir, "memory.search", { q, tag: args.tag, scope: args.scope, include_stale: !args["no-stale"] }, project);
    if (args.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    if (r.cost_micros) await commit("memory.search", { q }, r); // a semantic search made a real embed call
    const mode = r.search === "semantic" ? green("semantic") + dim(" (" + r.model + ")") : dim("lexical");
    console.log(`${b("Memory")} ${dim("— " + project.name + " · " + r.count + " fact(s)" + (q ? " matching \"" + q + "\"" : "") + " · " + (r.scopes || []).join("+") + " · ")}${mode}\n`);
    if (!r.count) { console.log(dim("  nothing yet — foundry memory set <key> \"<fact>\"")); return 0; }
    for (const m of r.memory) {
      const flags = [m.score != null ? dim(m.score.toFixed(2)) : null, m.scope === "shared" ? green("shared") : null, m.contested ? yellow("contested") : null, m.stale ? yellow("stale") : null].filter(Boolean).join(" ");
      console.log(`  ${b((m.key || "(unkeyed)").padEnd(22))} ${dim("v" + String(m.version).padEnd(2))} ${String(m.content).slice(0, 44).padEnd(46)} ${flags}`);
    }
    if (r.search === "lexical" && q) console.log(dim(`\n  lexical (keyword) search. for semantic: foundry memory provider`));
    return 0;
  }

  if (sub === "sync") {
    const r = await memory.syncShared(project, cloud);
    if (args.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    if (r.error) { console.log(`${yellow("○")} ${r.error}`); return 1; }
    console.log(`${green("✔ synced shared knowledge")} ${dim("· " + r.workspace)}`);
    console.log(`  ${dim("pushed")} ${b(String(r.pushed))} ${dim("· pulled")} ${b(String(r.pulled))}${r.contested ? "  " + yellow(r.contested + " contested") : ""}`);
    console.log(dim("  shared facts now span every machine on this org — not just this box."));
    if (r.pulled) console.log(dim("  new vectors needed? foundry memory reindex"));
    return 0;
  }

  console.log(`${b("foundry memory")} — the shared Context layer, governed.\n`);
  console.log(`  memory set <key> "<fact>" [--shared] [--ttl S]     --shared = every project sees it`);
  console.log(`  memory get <key>                                   warns if stale or contested`);
  console.log(`  memory search [q] [--scope workspace|shared]       spans both scopes by default`);
  console.log(`  memory sync                                        push/pull shared facts via the cloud`);
  console.log(`  memory provider [url] [model]                      turn on semantic search (Ollama/OpenAI)`);
  console.log(`  memory reindex                                     embed facts written before the provider`);
  console.log(dim(`\n  Your agents get the same store as MCP tools through \`foundry serve\`:`));
  console.log(dim(`  memory.set · memory.get · memory.search — every op receipted as a memory Execution.`));
  return 0;
}

// ─────────────────────────────── coordination (tasks + handoffs) ───────────────────────────────
// `foundry task` / `foundry handoff` — multiple agents, no collisions. Local board is
// authoritative when local; once graduated, claims route to the cloud workspace (race-safe
// across machines). Every op is a receipted `coord` Execution.
async function taskCmd(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const link = cloud.cloudLink(project);
  const c = new coord.Coord(store.ledgerDir(dir));
  const sub = args._[0] || "ls";
  const agent = args.agent || project.agent?.id || "builder";
  const where = link ? dim("cloud " + link.wsId) : dim("local");
  const rec = async (tool, params, result) => {
    const eff = led.commit({ agent, tool, params, key: null, result, type: "coord", duration_ms: 0 });
    if (link) { try { await cloud.mirrorEffect(link, eff); } catch { /* offline — stays local */ } }
    return eff;
  };
  const fmtTask = (t) => {
    const owner = t.claimed_by ? green("● " + t.claimed_by) : (t.blockers && t.blockers.length ? yellow("◌ blocked") : dim("○ open"));
    const deps = (t.depends_on && t.depends_on.length) ? dim(" needs:" + t.depends_on.length) : "";
    const cap = t.required_capability ? dim(" [" + t.required_capability + "]") : "";
    console.log(`  ${b((t.id || "").slice(0, 13).padEnd(13))} ${String(t.title).slice(0, 40).padEnd(42)} ${owner}${cap}${deps}`);
  };

  if (sub === "add") {
    const title = args._[1]; if (!title) throw new Error(`Usage: foundry task add "<title>" [--capability X] [--needs id,id] [--agent A]`);
    const depends_on = args.needs ? String(args.needs).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const t = link ? await cloud.cloudCoord.addTask(link, { title, required_capability: args.capability, depends_on, agent })
                   : c.addTask({ title, required_capability: args.capability, depends_on, agent });
    await rec("task.add", { title }, t);
    if (args.json) { console.log(JSON.stringify({ task: t }, null, 2)); return 0; }
    console.log(`${green("✔ task")} ${b(t.id)} ${dim("— " + where)}`);
    if (args.capability) console.log(dim(`  requires capability: ${args.capability}`));
    if (depends_on && depends_on.length) console.log(dim(`  depends on: ${depends_on.join(", ")}`));
    return 0;
  }

  if (sub === "claim") {
    const id = args._[1]; if (!id) throw new Error("Usage: foundry task claim <task_id> --agent A");
    const r = link ? await cloud.cloudCoord.claim(link, id, agent) : c.claim(id, agent);
    await rec("task.claim", { task: id }, r);
    if (args.json) { console.log(JSON.stringify(r, null, 2)); return r.claimed ? 0 : 1; }
    if (r.claimed) { console.log(`${green("✔ claimed")} ${b(id)} ${dim("by " + agent + (r.already_owner ? " (already yours)" : "") + " · " + where)}`); return 0; }
    if (r.blocked) { console.log(`${yellow("◌ blocked")} — ${b(id)} has unfinished dependencies:`); (r.blockers || []).forEach((x) => console.log(`    ${dim("·")} ${x.title} ${dim("(" + x.status + ")")}`)); return 1; }
    if (r.conflict) { console.log(`${red("✗ already claimed")} by ${b(r.owner)} ${dim("— exactly-one-owner: your agent did NOT double-book the work" + (r.capability ? " (or lacks the capability)" : ""))}`); return 1; }
    console.log(`${red("✗")} ${r.error || "claim failed"}`); return 1;
  }

  if (sub === "release") {
    const id = args._[1]; if (!id) throw new Error("Usage: foundry task release <task_id> --agent A");
    const r = link ? await cloud.cloudCoord.release(link, id, agent) : c.release(id, agent);
    await rec("task.release", { task: id }, r);
    console.log(r.released ? `${green("✔ released")} ${b(id)} ${dim("— open for the next agent")}` : `${yellow("○")} not released ${dim(r.owner || "(you don't own it)")}`);
    return r.released ? 0 : 1;
  }

  if (sub === "done" || sub === "complete") {
    const id = args._[1]; const output = args._[2] || args.output;
    if (!id) throw new Error("Usage: foundry task done <task_id> [output] --agent A");
    const r = link ? await cloud.cloudCoord.complete(link, id, agent, output) : c.complete(id, agent, output);
    await rec("task.done", { task: id }, r);
    if (args.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(`${green("✔ done")} ${b(id)} ${dim("— dependents can now be claimed · " + where)}`);
    return 0;
  }

  if (sub === "dep" || sub === "needs") {
    const id = args._[1], depId = args._[2];
    if (!id || !depId) throw new Error("Usage: foundry task dep <task_id> <depends_on_id>");
    if (link) { const r = await cloud.cloudCoord.addDep(link, id, depId); if (r.status >= 400) throw new Error((r.json && r.json.detail) || `cloud ${r.status}`); }
    else c.addDep(id, depId);
    await rec("task.dep", { task: id, dep: depId }, { ok: true });
    console.log(`${green("✔")} ${b(id)} now depends on ${b(depId)} ${dim("— can't be claimed until that's done")}`);
    return 0;
  }

  if (sub === "dag") {
    const dag = link ? { order: await cloud.cloudCoord.list(link), has_cycle: false } : c.dag();
    console.log(`${b("Task DAG")} ${dim("— " + where + (dag.has_cycle ? " · " + red("cycle detected") : ""))}\n`);
    if (!dag.order.length) { console.log(dim("  no tasks — foundry task add \"<title>\"")); return 0; }
    for (const t of dag.order) fmtTask(t);
    return 0;
  }

  // default: list the board
  const tasks = link ? await cloud.cloudCoord.list(link) : c.list();
  if (args.json) { console.log(JSON.stringify({ tasks }, null, 2)); return 0; }
  console.log(`${b("Tasks")} ${dim("— " + project.name + " · " + tasks.length + " · " + where)}\n`);
  if (!tasks.length) { console.log(dim("  no tasks yet — foundry task add \"<title>\"  ·  claim one:  foundry task claim <id> --agent A")); return 0; }
  for (const t of tasks) fmtTask(t);
  return 0;
}

async function handoffCmd(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const link = cloud.cloudLink(project);
  const c = new coord.Coord(store.ledgerDir(dir));
  const sub = args._[0];
  const agent = args.agent || project.agent?.id || "builder";
  const rec = async (tool, params, result) => {
    const eff = led.commit({ agent, tool, params, key: null, result, type: "coord", duration_ms: 0 });
    if (link) { try { await cloud.mirrorEffect(link, eff); } catch { /* offline — stays local */ } }
    return eff;
  };

  if (sub === "inbox") {
    const items = link ? await cloud.cloudCoord.inbox(link, agent, "pending") : c.inbox(agent, "pending");
    console.log(`${b("Handoffs")} ${dim("— inbox for " + agent + " · " + items.length + " pending")}\n`);
    if (!items.length) { console.log(dim("  empty")); return 0; }
    for (const h of items) console.log(`  ${b((h.id || "").slice(0, 12))} ${dim("from " + (h.from_agent || "?"))}  ${String(h.context || "").slice(0, 44)}  ${h.task_id ? dim("→ " + h.task_id) : ""}`);
    console.log(dim(`\n  accept:  foundry handoff accept <id> --agent ${agent}`));
    return 0;
  }
  if (sub === "accept" || sub === "reject") {
    const id = args._[1]; if (!id) throw new Error(`Usage: foundry handoff ${sub} <handoff_id> --agent A`);
    const r = link ? await cloud.cloudCoord.resolveHandoff(link, id, sub === "accept", agent) : c.resolveHandoff(id, sub === "accept", agent);
    await rec("handoff." + sub, { handoff: id }, r);
    if (sub === "accept") console.log(`${green("✔ accepted")} ${b(id)} ${dim("— " + (r && r.task ? "task " + (r.task.id || r.task.task_id || "") + " is now yours" : "handoff taken"))}`);
    else console.log(`${yellow("✗ rejected")} ${b(id)} ${dim("— back to the sender")}`);
    return 0;
  }
  // default: create a handoff.  foundry handoff <to> "<context>" [--task id] [--from A]
  const to = sub, context = args._[1] || args.context || "";
  if (!to) { console.log(`${b("foundry handoff")} — pass work to another agent.\n`);
    console.log(`  handoff <to> "<context>" [--task id]   offer a task to another agent`);
    console.log(`  handoff inbox --agent A                 an agent's pending handoffs`);
    console.log(`  handoff accept|reject <id> --agent A    take it (claims the task) or decline`);
    return 0; }
  const h = link ? await cloud.cloudCoord.handoff(link, { from: agent, to, task_id: args.task, context })
                 : c.handoff({ from: agent, to, task_id: args.task, context });
  await rec("handoff.create", { to, task: args.task }, h);
  console.log(`${green("✔ handoff")} ${b((h && h.id) || "")} ${dim("— " + agent + " → " + to + (args.task ? " · task " + args.task : ""))}`);
  console.log(dim(`  ${to} sees it:  foundry handoff inbox --agent ${to}`));
  return 0;
}

// ─────────────────────────────── connect (the 5-minute live wire-up) ───────────────────────────────
const CLIENT_LABEL = { claude: "Claude Code", "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", windsurf: "Windsurf" };
function clientInstalled(bin) {
  try { return require("node:child_process").spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0; } catch { return false; }
}
function detectClient() {
  if (clientInstalled("claude")) return "claude";
  if (clientInstalled("codex")) return "codex";
  return "claude";
}
function ensureCodexToml() {
  const file = path.join(require("node:os").homedir(), ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let toml = ""; try { toml = fs.readFileSync(file, "utf8"); } catch { /* new */ }
  if (!/\[mcp_servers\.foundry\]/.test(toml)) {
    fs.writeFileSync(file, (toml && !toml.endsWith("\n") ? toml + "\n" : toml) + '\n[mcp_servers.foundry]\ncommand = "foundry"\nargs = ["serve"]\n');
  }
  return file;
}
// Wire Foundry into a client quietly (no sub-command chatter) — returns a short detail.
function wireClientQuiet(client) {
  const os = require("node:os");
  const server = { command: "foundry", args: ["serve"] };
  if (client === "claude" || client === "claude-code") {
    const r = require("node:child_process").spawnSync("claude", ["mcp", "add", "foundry", "-s", "local", "--", "foundry", "serve"], { stdio: "ignore" });
    return r.status === 0 ? "claude mcp (local)" : "config written";
  }
  if (client === "cursor") { writeMcpServers(path.join(process.cwd(), ".cursor", "mcp.json"), server); return ".cursor/mcp.json"; }
  if (client === "windsurf") { writeMcpServers(path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"), server); return "windsurf config"; }
  if (client === "codex") { ensureCodexToml(); return "~/.codex/config.toml"; }
  return "config printed";
}

// Live tail: stream new Executions from the ledger as the agent makes them. Runs until Ctrl-C.
function liveTail(dir) {
  return new Promise((resolve) => {
    const led = new Ledger(store.ledgerDir(dir));
    let seen = led.list().length;
    const render = (e) => {
      const good = e.status === "committed" && !(e.result && (e.result.error || e.result.isError));
      const stat = e.status === "denied" || e.status === "blocked" ? red("✗") : good ? green("✓") : yellow("·");
      const icon = TYPE_ICON[e.type || "tool"] || "▸";
      const agent = (e.agent_id || "-").slice(0, 12).padEnd(12);
      const tool = (e.tool || "-").slice(0, 28).padEnd(28);
      const dur = fmtDur(e.duration_ms).padStart(6);
      const cost = fmtCostMicros(e.cost_micros).padStart(8);
      console.log(`  ${stat} ${icon} ${b(agent)} ${tool} ${dim(dur)} ${dim(cost)}  ${dim(e.receipt ? e.receipt.number : "")}`);
    };
    const poll = () => { const all = led.list(); for (let i = seen; i < all.length; i++) render(all[i]); seen = all.length; };
    const iv = setInterval(poll, 400);
    const stop = () => { clearInterval(iv); console.log(dim("\n  ● stopped · full run: foundry trace   ·   prove it: foundry receipts --verify")); resolve(0); };
    process.on("SIGINT", stop);
  });
}

async function connect(args) {
  const client = String(args._[0] || args.client || detectClient()).toLowerCase();
  const label = CLIENT_LABEL[client] || client;
  const tty = process.stdout.isTTY;
  const sleep = (ms) => new Promise((r) => setTimeout(r, tty ? ms : 0));
  const ok = (msg, detail) => console.log(`  ${green("✓")} ${msg}${detail ? dim("   " + detail) : ""}`);
  const skip = (msg) => console.log(`  ${yellow("○")} ${msg}`);

  console.log(`\n  ${b("● Connecting Foundry to " + label)}\n`);
  await sleep(180);

  if (["claude", "codex", "cursor", "windsurf"].includes(client)) {
    const bin = client === "claude" ? "claude" : client;
    clientInstalled(bin) ? ok(`${label} detected`) : skip(`${label} CLI not detected — writing its config anyway`);
  } else ok(`Target: ${label}`);
  await sleep(160);

  const { dir } = ensureProject();
  const project = store.readProject(dir);
  ok("Workspace ready", project.name);
  await sleep(160);

  const conns = store.readConnectors(dir);
  if (!Object.keys(conns).length) {
    const spec = args.connect || "deepwiki=https://mcp.deepwiki.com/mcp";
    const eq = spec.indexOf("="); const nm = spec.slice(0, eq) || "deepwiki"; const url = spec.slice(eq + 1);
    try {
      const { tools } = await mcp.connect(url);
      const c = store.readConnectors(dir);
      c[nm] = { url, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
      store.writeConnectors(dir, c);
      ok(`Connected ${nm}`, `${tools.length} tools, governed`);
    } catch (e) { skip(`couldn't reach ${nm} (${String(e.message).slice(0, 40)}) — connect one later`); }
  } else ok("Tools connected", Object.keys(conns).join(", "));
  await sleep(160);

  const detail = wireClientQuiet(client);
  ok(`Foundry wired into ${label}`, detail);
  await sleep(140);

  console.log(`\n  ${b("Now open " + label + " here and say:")}`);
  console.log(`      ${green("› integrate Invoke")}`);
  console.log(dim(`  ${label} will call Foundry's setup tool and govern this project in ~5 min.`));
  if (activeTarget(project) === "cloud") console.log(`  → Mission Control:  ${b("https://invokehq.run/dashboard")}`);
  if (args["no-follow"] || !tty) { console.log(dim("\n  live view:  foundry trace --follow")); return 0; }

  console.log(`\n  ${green("● LIVE")} ${dim("— every action your agent takes shows up here   (Ctrl-C to stop)")}`);
  console.log(dim("  " + "─".repeat(60)));
  return liveTail(dir);
}

// ─────────────────────────────── worker (agents that stay running) ───────────────────────────────
// A deployed agent, not a one-shot run: the worker stays alive, claims work off the shared
// board, runs it, and repeats. Because claims are atomic, you scale by starting MORE
// workers — exactly one wins each task, so none of them duplicate work. `--once` drains
// the board and exits, which is what you point cron at.
async function workerCmd(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const link = cloud.cloudLink(project);
  const board = new coord.Coord(store.ledgerDir(dir));
  const agent = args.agent || project.agent?.id || "worker";
  const cmd = args.cmd || args.command || null;
  const interval = Math.max(250, Number(args.interval || 2) * 1000);
  const once = !!args.once;
  const maxTasks = args.max ? Number(args.max) : Infinity;

  const list = async () => (link ? await cloud.cloudCoord.list(link) : board.list());
  const claim = async (id) => (link ? await cloud.cloudCoord.claim(link, id, agent) : board.claim(id, agent));
  const finish = async (id, out) => (link ? await cloud.cloudCoord.complete(link, id, agent, out) : board.complete(id, agent, out));
  const giveBack = async (id) => (link ? await cloud.cloudCoord.release(link, id, agent) : board.release(id, agent));
  const rec = async (tool, params, result, status) => {
    const eff = led.commit({ agent, tool, params, key: null, result, type: "coord", status: status || "committed", duration_ms: 0 });
    if (link) await cloud.mirrorEffect(link, eff).catch(() => {});
    return eff;
  };

  console.log(`\n  ${b("● worker " + agent)}  ${dim(link ? "cloud " + link.wsId : "local")}`);
  console.log(dim(`  ${cmd ? "runs: " + cmd : "no --cmd — claims and completes only"}`));
  console.log(dim(`  polling every ${interval / 1000}s · ${once ? "--once (drain, then exit)" : "Ctrl-C to stop"}\n`));

  let completed = 0, stopping = false;
  // Tasks this worker already failed. A failure releases the task so someone else can
  // retry it — but without this, the same worker would instantly re-claim it and spin in
  // a hot retry loop, never draining and never exiting.
  const failedHere = new Set();
  process.on("SIGINT", () => { stopping = true; console.log(dim("\n  ● finishing the current task, then stopping…")); });

  while (!stopping && completed < maxTasks) {
    let worked = false;
    for (const t of (await list()).filter((x) => x.status === "open" && !failedHere.has(x.id))) {
      if (stopping) break;
      const got = await claim(t.id);
      if (!got.claimed) continue; // blocked by a dependency, or another worker won the race
      await rec("task.claim", { task: t.id }, got);
      console.log(`  ${green("▸ claimed")}  ${b(String(t.title).slice(0, 46))} ${dim(t.id)}`);

      const t0 = Date.now();
      let ok = true, output = "";
      if (cmd) {
        const res = spawnSync(cmd, {
          shell: true, encoding: "utf8", cwd: dir, timeout: Number(args.timeout || 300) * 1000,
          env: { ...process.env, FOUNDRY_TASK_ID: t.id, FOUNDRY_TASK_TITLE: t.title, FOUNDRY_AGENT: agent },
          input: JSON.stringify(t),
        });
        ok = res.status === 0;
        output = ((ok ? res.stdout : res.stderr || res.stdout) || "").trim();
      }
      const dur = Date.now() - t0;
      await rec("worker.task", { task: t.id, cmd }, { task: t.id, ok, output: output.slice(0, 500) }, ok ? "committed" : "denied");

      if (ok) {
        await finish(t.id, output.slice(0, 2000));
        completed++;
        console.log(`  ${green("✓ done")}     ${b(String(t.title).slice(0, 46))} ${dim(fmtDur(dur) + (output ? " · " + output.split("\n")[0].slice(0, 52) : ""))}`);
      } else {
        failedHere.add(t.id);  // don't re-grab it ourselves; another worker still can
        await giveBack(t.id);  // hand it back so someone else (or a later run) retries it
        console.log(`  ${red("✗ failed")}   ${b(String(t.title).slice(0, 46))} ${dim("released · " + output.split("\n")[0].slice(0, 52))}`);
      }
      worked = true;
      break; // re-read the board: finishing this task may have unblocked dependents
    }
    if (!worked) {
      if (once) break;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  console.log(`\n  ${b("worker stopped")} ${dim(completed + " task(s) completed")}`);
  return 0;
}

// ─────────────────────────────── budget (fleet + per-agent caps) ───────────────────────────────
// A fleet cap (all agents) plus optional per-agent caps. Enforced by the model proxy: once
// an agent — or the fleet — crosses its cap, its next spending call is refused (429).
async function budgetCmd(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const sub = args._[0] || "show";
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);

  if (sub === "set") {
    if (args.fleet != null) {
      const usd = Number(args.fleet);
      if (!(usd >= 0)) throw new Error("Usage: foundry budget set --fleet <usd>");
      project.budget_usd = usd; store.writeProject(dir, project);
      console.log(`${green("✔ fleet budget")} ${b("$" + usd.toFixed(2))} ${dim("— total spend cap across all agents")}`);
      return 0;
    }
    const agent = args._[1]; const usd = Number(args._[2]);
    if (!agent || !(usd >= 0)) throw new Error("Usage:\n  foundry budget set <agent> <usd>\n  foundry budget set --fleet <usd>");
    project.agent_budgets = project.agent_budgets || {};
    project.agent_budgets[agent] = usd; store.writeProject(dir, project);
    console.log(`${green("✔ budget")} ${b(agent)} ${b("$" + usd.toFixed(2))} ${dim("— per-agent cap")}`);
    return 0;
  }
  if (sub === "rm" || sub === "unset") {
    if (args.fleet != null) { delete project.budget_usd; store.writeProject(dir, project); console.log(dim("fleet budget removed")); return 0; }
    const agent = args._[1];
    if (!agent) throw new Error("Usage: foundry budget rm <agent>   ·   foundry budget rm --fleet");
    if (project.agent_budgets) delete project.agent_budgets[agent];
    store.writeProject(dir, project); console.log(dim(`${agent} budget removed`)); return 0;
  }

  // show — spend vs caps, fleet then each agent
  const s = budget.spend(led);
  const caps = project.agent_budgets || {};
  const fleetCap = project.budget_usd;
  if (args.json) {
    const agents = Object.fromEntries([...new Set([...Object.keys(s.by), ...Object.keys(caps)])].filter((a) => a && a !== "—").map((a) => [a, { cap: caps[a] ?? null, spent_usd: (s.by[a] || 0) / 1e6 }]));
    console.log(JSON.stringify({ fleet: { cap: fleetCap ?? null, spent_usd: s.total / 1e6 }, agents }, null, 2)); return 0;
  }
  const bar = (spent, cap) => {
    if (cap == null) return dim("no cap · $" + spent.toFixed(2) + " spent");
    const pct = cap === 0 ? 1 : Math.min(1, spent / cap);
    const n = Math.round(pct * 16);
    const col = pct >= 1 ? red : pct >= 0.8 ? yellow : green;
    return col("█".repeat(n)) + dim("░".repeat(16 - n)) + "  $" + spent.toFixed(2) + dim("/$" + Number(cap).toFixed(2)) + (pct >= 1 ? " " + red("EXHAUSTED") : "");
  };
  console.log(`${b("Budget")} ${dim("— " + project.name)}\n`);
  console.log(`  ${pad("fleet", 14)} ${bar(s.total / 1e6, fleetCap)}`);
  const agents = [...new Set([...Object.keys(s.by), ...Object.keys(caps)])].filter((a) => a && a !== "—").sort();
  for (const a of agents) console.log(`  ${pad(a, 14)} ${bar((s.by[a] || 0) / 1e6, caps[a] ?? null)}`);
  if (!agents.length) console.log(dim("  no agents have spent yet"));
  console.log(dim("\n  cap an agent:  foundry budget set <agent> <usd>   ·   fleet:  foundry budget set --fleet <usd>"));
  return 0;
}

// ─────────────────────────────── approvals (human-in-the-loop) ───────────────────────────────
// When a policy marks a tool `approve`, the gateway queues it here instead of running it.
// A person approves → the effect runs once + is receipted → the agent gets it exactly-once.
async function approvalsCmd(args) {
  const dir = requireProject();
  const project = store.readProject(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const ap = new Approvals(store.ledgerDir(dir));
  const link = cloud.cloudLink(project);
  const sub = args._[0] || "list";

  if (sub === "list" || sub === "ls") {
    const pend = ap.list("pending");
    if (args.json) { console.log(JSON.stringify({ pending: pend }, null, 2)); return 0; }
    console.log(`${b("Approvals")} ${dim("— " + pend.length + " pending")}\n`);
    if (!pend.length) { console.log(dim("  nothing waiting on you.")); return 0; }
    for (const a of pend) console.log(`  ${b(a.id)}  ${dim((a.agent || "agent").slice(0, 12).padEnd(12))} ${b(a.tool)}  ${dim("rule " + (a.rule || "?"))}`);
    console.log(dim("\n  approve:  foundry approvals approve <id>   ·   deny:  foundry approvals deny <id>"));
    return 0;
  }

  if (sub === "approve" || sub === "deny") {
    const id = args._[1];
    if (!id) throw new Error(`Usage: foundry approvals ${sub} <id>`);
    const a = ap.get(id);
    if (!a) throw new Error(`approval '${id}' not found`);
    if (a.status !== "pending") { console.log(dim(`${a.id} is already ${a.status}.`)); return 0; }

    if (sub === "deny") {
      ap.resolve(a.id, "deny", args.by || "human");
      const eff = led.commit({ agent: a.agent, tool: a.tool, params: a.params, key: a.key, type: toolType(a.tool), status: "denied", result: { denied: true, by: "human", rule: a.rule }, duration_ms: 0 });
      if (link) await cloud.mirrorEffect(link, eff).catch(() => {});
      console.log(`${red("✗ denied")} ${b(a.tool)} ${dim("— " + a.id + " · a signed refusal is in the ledger " + eff.receipt.number)}`);
      return 0;
    }

    // approve → run the deferred side effect once + commit, so the agent's next identical
    // call reconciles to this receipt (exactly-once — never executed twice).
    ap.resolve(a.id, "approve", args.by || "human");
    const dup = led.committed(a.effect_key);
    if (dup) { console.log(`${green("✓ approved")} ${b(a.tool)} ${dim("— already executed, receipt " + dup.receipt.number)}`); return 0; }
    const t0 = Date.now();
    let result, okr = true;
    try { result = await executeLocal(dir, a.tool, a.params, project); }
    catch (e) { okr = false; result = { error: String(e.message || e) }; }
    const eff = led.commit({ agent: a.agent, tool: a.tool, params: a.params, key: a.key, result, type: toolType(a.tool), duration_ms: Date.now() - t0 });
    if (link) await cloud.mirrorEffect(link, eff).catch(() => {});
    console.log(`${green("✓ approved & executed")} ${b(a.tool)} ${dim(a.id + " · receipt " + eff.receipt.number)}`);
    console.log("  result: " + JSON.stringify(result).slice(0, 200));
    console.log(dim("  the agent gets this exact result on its next identical call."));
    return okr ? 0 : 1;
  }

  console.log(`${b("foundry approvals")} — human-in-the-loop.\n`);
  console.log("  approvals list              what's waiting on you");
  console.log("  approvals approve <id>      run the effect + record a signed receipt");
  console.log("  approvals deny <id>         refuse it (a signed refusal is logged)");
  console.log(dim("\n  Gate a tool with:  foundry policy approve \"<pattern>\"   ·   agents hit it through foundry serve."));
  return 0;
}

// ─────────────────────────────── setup (govern all your agents) + doctor ───────────────────────────────
const ALL_CLIENTS = ["claude", "cursor", "codex", "windsurf"];
const clientBin = (c) => (c === "claude" ? "claude" : c);

// Is Foundry wired into this client's MCP config? (what `doctor` checks)
function clientWired(c) {
  const os = require("node:os");
  try {
    if (c === "claude") return require("node:child_process").spawnSync("claude", ["mcp", "get", "foundry"], { stdio: "ignore" }).status === 0;
    if (c === "cursor") { const f = path.join(process.cwd(), ".cursor", "mcp.json"); return fs.existsSync(f) && /"foundry"/.test(fs.readFileSync(f, "utf8")); }
    if (c === "codex") { const f = path.join(os.homedir(), ".codex", "config.toml"); return fs.existsSync(f) && /\[mcp_servers\.foundry\]/.test(fs.readFileSync(f, "utf8")); }
    if (c === "windsurf") { const f = path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"); return fs.existsSync(f) && /"foundry"/.test(fs.readFileSync(f, "utf8")); }
  } catch { /* treat as not wired */ }
  return false;
}

// foundry setup — govern every coding agent on this machine in one shot: detect them all,
// wire them in, and turn on the governance features. The onboarding front door.
async function setupCmd(args) {
  const yes = !!(args.yes || args.y) || !process.stdout.isTTY;
  const confirm = async (q) => (yes ? true : !(await ask(`  ${q} [Y/n] `)).toLowerCase().startsWith("n"));
  console.log(`\n  ${b("● Governing your agents")}\n`);

  // 1. detect + wire every installed client
  const wired = [];
  for (const c of ALL_CLIENTS) {
    if (clientInstalled(clientBin(c))) {
      const detail = wireClientQuiet(c);
      wired.push(c);
      console.log(`  ${green("✓")} ${CLIENT_LABEL[c]} detected  ${dim("· wired (" + detail + ")")}`);
    } else {
      console.log(`  ${dim("○ " + CLIENT_LABEL[c] + " not found")}`);
    }
  }
  if (!wired.length) console.log(`  ${yellow("○")} no coding agents detected — install one, or wire manually with ${b("foundry mcp")}.`);

  const { dir } = ensureProject();
  const project = store.readProject(dir);
  project.setup = project.setup || {};
  console.log("");

  // 2. governance toggles
  if (await confirm("Enable governance?")) {
    project.policies = project.policies || {};
    project.policies.approve = [...new Set([...(project.policies.approve || []), "*delete*", "*destroy*", "*.remove", "*drop*"])];
    project.setup.governance = true;
    console.log(`  ${green("✓ governance")}     ${dim("policy engine on · destructive tools require approval")}`);
  }
  if (await confirm("Enable receipts?")) {
    project.setup.receipts = true;
    console.log(`  ${green("✓ receipts")}       ${dim("every execution signed + hash-chained (foundry receipts --verify)")}`);
  }
  if (await confirm("Enable shared memory?")) {
    project.setup.memory = true;
    const prov = embeddings.provider(project);
    console.log(`  ${green("✓ shared memory")}  ${dim("memory.* tools live · " + (prov ? "semantic (" + prov.model + ")" : "lexical — foundry memory provider for semantic"))}`);
  }
  if (await confirm("Enable model proxy?")) {
    project.setup.model_proxy = true;
    console.log(`  ${green("✓ model proxy")}    ${dim("run `foundry model serve` · point OPENAI_BASE_URL at :4000 · calls costed + budgeted")}`);
  }
  store.writeProject(dir, project);

  console.log(`\n  ${b("Done.")} Your agents are now governed.`);
  const cfg = store.readGlobalConfig();
  if (!cfg.invoke_token) console.log(dim("  → link the cloud + dashboard:  foundry login  then  foundry push"));
  else if (!(project.invoke && project.invoke.workspace)) console.log(dim("  → stream to the dashboard:  foundry push"));
  console.log(dim("  → verify everything:  foundry doctor"));
  return 0;
}

// foundry doctor — a health check across the whole setup: which agents are wired, and
// whether governance, memory, policies, receipts, and cloud sync are actually working.
async function doctorCmd(args) {
  const dir = store.findProject();
  const rows = [];
  const ok = (label, detail) => rows.push([green("✓"), label, detail]);
  const warn = (label, detail) => rows.push([yellow("○"), label, detail]);
  const bad = (label, detail) => rows.push([red("✗"), label, detail]);

  for (const c of ALL_CLIENTS) {
    if (!clientInstalled(clientBin(c))) { warn(CLIENT_LABEL[c], "not installed"); continue; }
    clientWired(c) ? ok(CLIENT_LABEL[c], "wired") : bad(CLIENT_LABEL[c], "installed but not wired — run foundry setup");
  }

  if (!dir) {
    warn("Workspace", "no project here — run foundry setup");
  } else {
    const project = store.readProject(dir);
    const prov = embeddings.provider(project);
    ok("Memory", prov ? "ready · semantic (" + prov.model + ")" : "ready · lexical (foundry memory provider for semantic)");
    const p = project.policies || {};
    const nrules = (p.deny || []).length + (p.approve || []).length + (p.allow || []).length;
    nrules ? ok("Policies", nrules + " rule(s)") : warn("Policies", "none set — foundry policy add");
    const nCaps = Object.keys(project.agent_budgets || {}).length;
    if (project.budget_usd || nCaps) ok("Budget", (project.budget_usd ? "fleet $" + Number(project.budget_usd).toFixed(2) : "no fleet cap") + (nCaps ? " · " + nCaps + " agent cap(s)" : ""));
    else warn("Budget", "no caps — foundry budget set");
    try {
      const led = new Ledger(store.ledgerDir(dir));
      const v = led.verify();
      v.ok ? ok("Receipts", led.list().length + " receipt(s) · ledger valid") : bad("Receipts", "ledger INVALID — " + (v.reason || ""));
    } catch { warn("Receipts", "no ledger yet"); }
    const link = cloud.cloudLink(project);
    if (link) {
      let reachable = false;
      try { const r = await cloud.mirrorEffect(link, { status: "noop" }); reachable = !(r && r.error); } catch { /* offline */ }
      ok("Cloud Sync", "linked · " + link.wsId + (reachable ? " · reachable" : ""));
    } else {
      const cfg = store.readGlobalConfig();
      warn("Cloud Sync", cfg.invoke_token ? "logged in · not pushed (foundry push)" : "local-only (foundry login + push)");
    }
  }

  if (args.json) { console.log(JSON.stringify(rows.map(([s, l, d]) => ({ check: l, ok: s === green("✓"), detail: d })), null, 2)); return 0; }
  console.log(`\n  ${b("foundry doctor")}\n`);
  for (const [sym, label, detail] of rows) console.log(`  ${sym} ${String(label).padEnd(14)} ${dim(detail)}`);
  const anyBad = rows.some((r) => r[0] === red("✗"));
  console.log(anyBad ? `\n  ${yellow("Some checks need attention")} ${dim("— see above.")}` : `\n  ${green("All good.")} ${dim("Your agents are governed.")}`);
  return anyBad ? 1 : 0;
}

module.exports = { login, init, run, receipts, status, push, workspace, serve, trace, model, policy: policyCmd, diff, mcp: mcpCmd, connect, memory: memoryCmd, task: taskCmd, handoff: handoffCmd, setup: setupCmd, doctor: doctorCmd, approvals: approvalsCmd, budget: budgetCmd, worker: workerCmd };

function parseJson(s) {
  try { const v = JSON.parse(s); if (v && typeof v === "object") return v; throw 0; }
  catch { throw new Error(`params must be a JSON object, got: ${s}`); }
}
