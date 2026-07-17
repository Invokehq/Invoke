"use strict";
// foundry serve — a local MCP gateway your coding agent (Claude Code / Cursor / Codex)
// points at. It speaks MCP over stdio, re-advertises every connected tool, and routes
// each tools/call through the governed ledger: recorded as an Execution, receipted, and
// exactly-once for keyed calls. The agent gets tools; you get identity, receipts, trace.
//
// This is the Tool/MCP adapter. Model (LLM-proxy), HTTP, File adapters plug in the same
// way — every call is an Execution, the type just selects the adapter underneath.
const readline = require("node:readline");
const { Ledger } = require("./ledger");
const { runTool, BUILTINS, toolType } = require("./tools");
const mcp = require("./mcp");
const store = require("./store");
const policy = require("./policy");
const cloud = require("./cloud");
const { runSetup } = require("./setup");

const PROTOCOL = "2025-06-18";
const VERSION = require("../package.json").version;

// Surfaced to the coding agent on connect (MCP `initialize.instructions`) — this is what
// makes "integrate Invoke" work: the agent learns it should call `setup` first.
const INSTRUCTIONS =
  "This project is governed by Invoke via Foundry. Every tool call routed through these " +
  "tools is a receipted, exactly-once Execution (identity, cost, tamper-evident ledger). " +
  "When the user asks to integrate Invoke, set up governance, or govern their agent, call " +
  "the `setup` tool FIRST — it provisions the governed workspace and returns the exact " +
  "integration steps, including a model-proxy snippet to add to their code. Verify anytime " +
  "with the `foundry receipts --verify` CLI.";

function builtinDefs() {
  const obj = (props, req) => ({ type: "object", properties: props || {}, required: req || [] });
  return [
    { name: "setup", description: "Integrate Invoke governance into this project. Provisions a governed workspace (budget + a starter safety policy) and returns the exact integration steps, including a model-proxy snippet to add to the code. Call this first whenever the user asks to integrate/set up Invoke or govern their agent.", inputSchema: obj({ budget_usd: { type: "number", description: "Spend cap in USD (default 5)." } }) },
    { name: "echo", description: "Echo the params back.", inputSchema: obj() },
    { name: "time", description: "Current time.", inputSchema: obj() },
    { name: "http.get", description: "Governed HTTP GET.", inputSchema: obj({ url: { type: "string" } }, ["url"]) },
    { name: "http.post", description: "Governed HTTP POST.", inputSchema: obj({ url: { type: "string" }, body: {} }, ["url"]) },
    { name: "http.request", description: "Governed HTTP request (any method).", inputSchema: obj({ method: { type: "string" }, url: { type: "string" }, headers: { type: "object" }, body: {} }, ["url"]) },
    { name: "file.read", description: "Read a file in the workspace (governed).", inputSchema: obj({ path: { type: "string" } }, ["path"]) },
    { name: "file.write", description: "Write a file in the workspace (governed).", inputSchema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path"]) },
  ];
}

// Built-ins + every connector's tools, namespaced as `<connector>.<tool>`.
function aggregateTools(conns) {
  const list = builtinDefs();
  for (const [name, c] of Object.entries(conns || {})) {
    for (const t of c.tools || []) {
      const td = typeof t === "string" ? { name: t } : t;
      list.push({ name: `${name}.${td.name}`, description: td.description || "", inputSchema: td.inputSchema || { type: "object" } });
    }
  }
  return list;
}

function asMcpResult(result) {
  if (result && typeof result === "object" && Array.isArray(result.content)) return result;
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
}

async function execute(name, params, conns) {
  const dot = name.indexOf(".");
  if (dot > 0 && conns[name.slice(0, dot)]) {
    return mcp.call(conns[name.slice(0, dot)], name.slice(dot + 1), params); // upstream MCP result (http or stdio)
  }
  if (BUILTINS.includes(name)) return asMcpResult(await runTool(name, params));
  const e = new Error(`tool '${name}' is not connected to this workspace`);
  e.code = -32601;
  throw e;
}

async function serve(dir) {
  const project = store.readProject(dir);
  const conns = store.readConnectors(dir);
  const led = new Ledger(store.ledgerDir(dir));
  const tools = aggregateTools(conns);
  const link = cloud.cloudLink(project); // non-null once graduated: mirror to the dashboard

  const write = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const log = (...a) => process.stderr.write(`[foundry] ${a.join(" ")}\n`);
  const ok = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  log(`serving ${tools.length} governed tool(s) from ${Object.keys(conns).length} connector(s) — "${project.name}".`);
  log(`every call is an Execution: receipted + exactly-once. see them with \`foundry receipts\`.`);
  if (link) log(`graduated → mirroring every call to Invoke workspace ${link.wsId} (live on the dashboard).`);

  const pending = []; // in-flight cloud mirrors — drained before we exit so the last call isn't lost
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let msg;
    try { msg = JSON.parse(s); } catch { continue; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        ok(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "foundry", version: VERSION }, instructions: INSTRUCTIONS });
      } else if (method === "tools/list") {
        ok(id, { tools });
      } else if (method === "ping") {
        ok(id, {});
      } else if (method === "tools/call") {
        await handleCall(id, params || {}, { conns, led, ok, fail, log, project, dir, link, pending });
      } else if (method && method.startsWith("notifications/")) {
        // notifications get no response
      } else if (id !== undefined) {
        fail(id, -32601, `method not found: ${method}`);
      }
    } catch (e) {
      if (id !== undefined) fail(id, -32603, String((e && e.message) || e));
      else log("error:", String((e && e.message) || e));
    }
  }
  // stdin closed (agent disconnected): drain any in-flight mirrors so the final calls land.
  if (pending.length) await Promise.allSettled(pending);
}

async function handleCall(id, params, ctx) {
  const { conns, led, ok, fail, log, project, dir, link, pending } = ctx;
  const name = params.name;
  const args = params.arguments || {};
  const agent = args._agent_id || "coding-agent";
  const key = args._idempotency_key || null;
  const clean = {};
  for (const k of Object.keys(args)) if (!k.startsWith("_")) clean[k] = args[k];

  // The "integrate in 5 min" primitive — provisions governance, returns the steps. Meta,
  // so it's exempt from the tool policy gate, but still recorded as a governed Execution.
  if (name === "setup") {
    const t0 = Date.now();
    const out = runSetup(dir, project, clean);
    const eff = led.commit({ agent, tool: "setup", params: clean, key: null, type: "setup", result: { steps: out.steps, budget: out.budget }, duration_ms: Date.now() - t0 });
    log(`setup governed workspace "${project.name}" -> receipt ${eff.receipt.number}`);
    return ok(id, { content: [{ type: "text", text: out.text }] });
  }

  // Policy gate — headless, so deny AND approve both block the agent (and are ledgered).
  const decision = policy.evaluate(policy.loadPolicies(project), name);
  if (decision.effect !== "allow") {
    const status = decision.effect === "deny" ? "denied" : "blocked";
    const eff = led.commit({ agent, tool: name, params: clean, key, type: toolType(name), status, result: { [status]: true, rule: decision.rule }, duration_ms: 0 });
    log(`${status} ${name} by policy ${decision.rule} -> receipt ${eff.receipt.number}`);
    return ok(id, { content: [{ type: "text", text: `Foundry ${status} '${name}' — policy rule '${decision.rule}'${decision.effect === "approve" ? " requires human approval" : ""}.` }], isError: true });
  }

  // Exactly-once for keyed calls: a repeat reconciles to the receipt, no re-execution.
  if (key) {
    const dup = led.committed(led.effectKey(agent, name, clean, key));
    if (dup) { log(`dup  ${name} -> receipt ${dup.receipt.number}`); return ok(id, asMcpResult(dup.result)); }
  }

  const t0 = Date.now();
  let result, isErr = false;
  try {
    result = await execute(name, clean, conns);
  } catch (e) {
    if (e.code === -32601) { log(`404  ${name}`); return fail(id, -32601, e.message); }
    isErr = true;
    result = { content: [{ type: "text", text: String((e && e.message) || e) }], isError: true };
  }
  const eff = led.commit({ agent, tool: name, params: clean, key, result, type: toolType(name), duration_ms: Date.now() - t0 });
  log(`${isErr ? "err " : "ok  "} ${name} ${Date.now() - t0}ms agent=${agent} -> receipt ${eff.receipt.number}`);
  // Mirror to the cloud ledger without blocking the agent's tool call (serve is long-lived).
  // The promise is tracked in `pending` so a disconnect drains it — the last call still lands.
  if (link) { const p = cloud.mirrorEffect(link, eff).then((m) => { if (m && m.mirrored) log(`↑ mirrored ${name} -> Invoke`); }).catch(() => {}); if (pending) pending.push(p); }
  ok(id, asMcpResult(result));
}

module.exports = { serve, aggregateTools };
