"use strict";
// Minimal Model Context Protocol client over streamable HTTP — enough for Foundry to
// connect a real MCP server locally and govern its tools through the on-disk ledger.
// Uses node:https with family:4 (not global fetch): some hosts advertise AAAA records
// but have broken IPv6, and undici can pick the dead v6 address and time out.
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "foundry", version: "0.1.0" };

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
        timeout: 30000,
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

async function rpc(url, sessionId, payload) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await post(url, headers, JSON.stringify(payload));
  const sid = res.headers["mcp-session-id"] || sessionId;
  return { sessionId: sid, json: parseBody(res.body, res.headers["content-type"]), status: res.status };
}

async function handshake(url) {
  const init = await rpc(url, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT },
  });
  if (init.json && init.json.error) {
    throw new Error("initialize failed: " + (init.json.error.message || JSON.stringify(init.json.error)));
  }
  try { await rpc(url, init.sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }); } catch { /* ok */ }
  return init.sessionId;
}

// Connect: handshake + list the server's tools (full defs, incl. inputSchema).
async function connect(url) {
  const sessionId = await handshake(url);
  const list = await rpc(url, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (list.json && list.json.result && list.json.result.tools) || [];
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object" },
    })),
  };
}

// Call one tool. Fresh session per call (stateless, like the gateway's per-request model).
async function call(url, tool, args) {
  const sessionId = await handshake(url);
  const res = await rpc(url, sessionId, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: args || {} } });
  if (res.json && res.json.error) throw new Error(res.json.error.message || JSON.stringify(res.json.error));
  return res.json && res.json.result !== undefined ? res.json.result : res.json;
}

module.exports = { connect, call, _parseBody: parseBody };
