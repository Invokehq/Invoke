"use strict";
// Built-in execution adapters. Each is a governed side effect: a Tool, an HTTP request,
// or a File op. The type just selects the adapter — the ledger, dedup, policy, receipt,
// and trace treat them identically. Connectors (MCP servers) plug in the same way.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

function httpRequest(method, url, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const body = params.body != null ? (typeof params.body === "string" ? params.body : JSON.stringify(params.body)) : null;
    const headers = Object.assign({ "user-agent": "foundry" }, params.headers || {});
    if (body) { if (!headers["content-type"]) headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(body); }
    const req = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method, family: 4, timeout: 30000, headers },
      (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, bytes: Buffer.byteLength(d), body: d.slice(0, 2000) })); }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("http request timed out")));
    if (body) req.write(body);
    req.end();
  });
}

// File ops are sandboxed to the workspace (cwd) — a governed side effect must not escape it.
function safePath(p) {
  const root = process.cwd();
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`path '${p}' escapes the workspace`);
  return abs;
}

async function runTool(tool, params = {}) {
  switch (tool) {
    case "echo":
      return { echoed: params };
    case "time":
      return { now: new Date().toISOString() };
    case "http.get": {
      if (!params.url) throw new Error("http.get needs params {\"url\": \"...\"}");
      return httpRequest("GET", params.url, params);
    }
    case "http.post": {
      if (!params.url) throw new Error("http.post needs {\"url\": \"...\"}");
      return httpRequest("POST", params.url, params);
    }
    case "http.request": {
      if (!params.url) throw new Error("http.request needs {\"url\": \"...\"}");
      return httpRequest(String(params.method || "GET").toUpperCase(), params.url, params);
    }
    case "file.read": {
      if (!params.path) throw new Error("file.read needs {\"path\": \"...\"}");
      return { path: params.path, content: fs.readFileSync(safePath(params.path), "utf8").slice(0, 4000) };
    }
    case "file.write": {
      if (!params.path) throw new Error("file.write needs {\"path\": \"...\"}");
      const abs = safePath(params.path);
      const content = String(params.content != null ? params.content : "");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return { path: params.path, bytes: Buffer.byteLength(content) };
    }
    default:
      throw new Error(`unknown tool '${tool}'. Built-ins: ${BUILTINS.join(", ")}`);
  }
}

const BUILTINS = ["echo", "time", "http.get", "http.post", "http.request", "file.read", "file.write"];

// The Execution type an execution's name maps to (adapter selection).
function toolType(name) {
  if (name && name.startsWith("http.")) return "http";
  if (name && name.startsWith("file.")) return "file";
  return "tool";
}

module.exports = { runTool, BUILTINS, toolType };
