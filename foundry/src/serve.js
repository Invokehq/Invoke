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
const { runTool, BUILTINS } = require("./tools");
const mcp = require("./mcp");
const store = require("./store");
const policy = require("./policy");

const PROTOCOL = "2025-06-18";
const VERSION = require("../package.json").version;

function builtinDefs() {
  return [
    { name: "echo", description: "Echo the params back.", inputSchema: { type: "object" } },
    { name: "time", description: "Current time.", inputSchema: { type: "object" } },
    { name: "http.get", description: "HTTP GET a URL.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
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
    return mcp.call(conns[name.slice(0, dot)].url, name.slice(dot + 1), params); // upstream MCP result
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

  const write = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const log = (...a) => process.stderr.write(`[foundry] ${a.join(" ")}\n`);
  const ok = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  log(`serving ${tools.length} governed tool(s) from ${Object.keys(conns).length} connector(s) — "${project.name}".`);
  log(`every call is an Execution: receipted + exactly-once. see them with \`foundry receipts\`.`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let msg;
    try { msg = JSON.parse(s); } catch { continue; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        ok(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "foundry", version: VERSION } });
      } else if (method === "tools/list") {
        ok(id, { tools });
      } else if (method === "ping") {
        ok(id, {});
      } else if (method === "tools/call") {
        await handleCall(id, params || {}, { conns, led, ok, fail, log, project });
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
}

async function handleCall(id, params, ctx) {
  const { conns, led, ok, fail, log, project } = ctx;
  const name = params.name;
  const args = params.arguments || {};
  const agent = args._agent_id || "coding-agent";
  const key = args._idempotency_key || null;
  const clean = {};
  for (const k of Object.keys(args)) if (!k.startsWith("_")) clean[k] = args[k];

  // Policy gate — headless, so deny AND approve both block the agent (and are ledgered).
  const decision = policy.evaluate(policy.loadPolicies(project), name);
  if (decision.effect !== "allow") {
    const status = decision.effect === "deny" ? "denied" : "blocked";
    const eff = led.commit({ agent, tool: name, params: clean, key, status, result: { [status]: true, rule: decision.rule }, duration_ms: 0 });
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
  const eff = led.commit({ agent, tool: name, params: clean, key, result, type: "tool", duration_ms: Date.now() - t0 });
  log(`${isErr ? "err " : "ok  "} ${name} ${Date.now() - t0}ms agent=${agent} -> receipt ${eff.receipt.number}`);
  ok(id, asMcpResult(result));
}

module.exports = { serve, aggregateTools };
