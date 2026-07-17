"use strict";
// Minimal Model Context Protocol client — enough for Foundry to connect a *real* MCP
// server and govern its tools through the ledger. Two transports, because the ecosystem
// has two shapes:
//
//   http   — hosted servers (deepwiki, Vercel). Streamable HTTP + optional auth header.
//   stdio  — the majority: launched via npx (Slack, GitHub, Postgres, filesystem, …),
//            speaking newline-delimited JSON-RPC over the child's stdin/stdout.
//
// Secrets never touch disk: header values and env vars are stored as `${VAR}` templates
// in connectors.json and resolved from the environment at call time.
//
// Uses node:https with family:4 (not global fetch): some hosts advertise AAAA records
// but have broken IPv6, and undici can pick the dead v6 address and time out.
const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "foundry", version: require("../package.json").version };
const TIMEOUT_MS = 30000;

// `${VAR}` → process.env.VAR. This is what keeps tokens out of connectors.json: the file
// holds the reference, the value lives in your environment.
function resolveEnv(str) {
  return String(str).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || "");
}

// A connector is either a bare URL (legacy), an http descriptor, or a stdio descriptor.
function normalize(conn) {
  if (typeof conn === "string") return { transport: "http", url: conn, headers: {} };
  if (conn && conn.command) {
    return { transport: "stdio", command: conn.command, args: conn.args || [], env: conn.env || {} };
  }
  return { transport: "http", url: conn.url, headers: conn.headers || {} };
}

function describe(conn) {
  const d = normalize(conn);
  return d.transport === "stdio" ? `${d.command} ${(d.args || []).join(" ")}`.trim() : d.url;
}

// ───────────────────────────────── http transport ─────────────────────────────────

function post(urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "POST",
        family: 4,
        timeout: TIMEOUT_MS,
        headers: Object.assign({ "content-length": Buffer.byteLength(bodyStr) }, headers),
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("MCP request timed out")));
    req.write(bodyStr);
    req.end();
  });
}

// Responses may be application/json or SSE (text/event-stream). Pull the JSON-RPC object.
function parseBody(text, contentType) {
  if (!text) return null;
  if ((contentType || "").includes("application/json")) {
    try { return JSON.parse(text); } catch { /* fall through to SSE */ }
  }
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (m && m[1].trim()) { try { last = JSON.parse(m[1]); } catch { /* skip */ } }
  }
  if (last) return last;
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

function authHeaders(desc) {
  const out = {};
  for (const [k, v] of Object.entries(desc.headers || {})) {
    const val = resolveEnv(v);
    if (val) out[k.toLowerCase()] = val;
  }
  return out;
}

async function httpRpc(desc, sessionId, payload) {
  const headers = Object.assign(
    { "content-type": "application/json", accept: "application/json, text/event-stream" },
    authHeaders(desc)
  );
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await post(desc.url, headers, JSON.stringify(payload));
  // A protected server (e.g. Vercel) answers 401 with a WWW-Authenticate challenge —
  // surface that as a clear "needs a token", not an opaque parse failure.
  if (res.status === 401 || res.status === 403) {
    const err = new Error(
      `server requires authorization (${res.status}). Connect it with a token:\n` +
      `    foundry workspace connect <name> ${desc.url} --header "Authorization: Bearer \${YOUR_TOKEN_ENV}"`
    );
    err.code = "EAUTH";
    throw err;
  }
  const sid = res.headers["mcp-session-id"] || sessionId;
  return { sessionId: sid, json: parseBody(res.body, res.headers["content-type"]), status: res.status };
}

// ──────────────────────────────── stdio transport ────────────────────────────────

// Spawn the server, run `fn(rpc)` against it, then always tear the child down.
function withStdio(desc, fn) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    for (const [k, v] of Object.entries(desc.env || {})) {
      // `--env FOO` (value true/empty) means "pass FOO through from my environment";
      // `--env FOO=${BAR}` resolves BAR. Either way the secret stays out of the file.
      const val = v === true || v === "" || v == null ? process.env[k] : resolveEnv(String(v));
      if (val) env[k] = val;
    }
    let child;
    try {
      child = spawn(desc.command, desc.args || [], { stdio: ["pipe", "pipe", "pipe"], env });
    } catch (e) { return reject(new Error(`could not launch '${desc.command}': ${e.message}`)); }

    const pending = new Map();
    let buf = "", stderr = "", done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* already gone */ }
      err ? reject(err) : resolve(val);
    };

    child.on("error", (e) => finish(new Error(`could not launch '${desc.command}': ${e.message}`)));
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => {
      if (pending.size || !done) {
        const hint = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 200);
        finish(new Error(`'${desc.command}' exited (code ${code})${hint ? ": " + hint : ""}`));
      }
    });
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; } // servers may log noise
        if (m.id != null && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
      }
    });

    const rpc = (payload) =>
      new Promise((res, rej) => {
        if (payload.id == null) { child.stdin.write(JSON.stringify(payload) + "\n"); return res(null); }
        const timer = setTimeout(() => {
          if (pending.has(payload.id)) { pending.delete(payload.id); rej(new Error(`'${desc.command}' timed out on ${payload.method}`)); }
        }, TIMEOUT_MS);
        pending.set(payload.id, { resolve: (m) => { clearTimeout(timer); res(m); } });
        child.stdin.write(JSON.stringify(payload) + "\n");
      });

    Promise.resolve()
      .then(() => fn(rpc))
      .then((v) => finish(null, v), (e) => finish(e));
  });
}

async function stdioHandshake(rpc) {
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
  if (init && init.error) throw new Error("initialize failed: " + (init.error.message || JSON.stringify(init.error)));
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
}

// ─────────────────────────────────── public API ───────────────────────────────────

function mapTools(tools) {
  return (tools || []).map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema || { type: "object" },
  }));
}

// Connect: handshake + list the server's tools (full defs, incl. inputSchema).
async function connect(conn) {
  const desc = normalize(conn);
  if (desc.transport === "stdio") {
    return withStdio(desc, async (rpc) => {
      await stdioHandshake(rpc);
      const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      return { tools: mapTools(list && list.result && list.result.tools) };
    });
  }
  const init = await httpRpc(desc, null, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
  if (init.json && init.json.error) throw new Error("initialize failed: " + (init.json.error.message || JSON.stringify(init.json.error)));
  try { await httpRpc(desc, init.sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }); } catch { /* ok */ }
  const list = await httpRpc(desc, init.sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return { tools: mapTools(list.json && list.json.result && list.json.result.tools) };
}

// Call one tool. Fresh session per call (stateless, like the gateway's per-request model).
async function call(conn, tool, args) {
  const desc = normalize(conn);
  if (desc.transport === "stdio") {
    return withStdio(desc, async (rpc) => {
      await stdioHandshake(rpc);
      const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args || {} } });
      if (res && res.error) throw new Error(res.error.message || JSON.stringify(res.error));
      return res && res.result !== undefined ? res.result : res;
    });
  }
  const sessionId = (await httpRpc(desc, null, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } })).sessionId;
  try { await httpRpc(desc, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }); } catch { /* ok */ }
  const res = await httpRpc(desc, sessionId, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args || {} } });
  if (res.json && res.json.error) throw new Error(res.json.error.message || JSON.stringify(res.json.error));
  return res.json && res.json.result !== undefined ? res.json.result : res.json;
}

module.exports = { connect, call, normalize, describe, resolveEnv, _parseBody: parseBody };
