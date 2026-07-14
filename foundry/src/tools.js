"use strict";
// Built-in local tools so `foundry run` does something real out of the box — no MCP
// server to stand up. In Invoke these become governed connectors; here they run in-proc.
async function runTool(tool, params = {}) {
  switch (tool) {
    case "echo":
      return { echoed: params };
    case "time":
      return { now: new Date().toISOString() };
    case "http.get": {
      const url = params.url;
      if (!url) throw new Error("http.get needs params {\"url\": \"...\"}");
      const res = await fetch(url, { headers: { "user-agent": "foundry" } });
      const text = await res.text();
      return { status: res.status, bytes: text.length, body: text.slice(0, 280) };
    }
    default:
      throw new Error(`unknown tool '${tool}'. Built-ins: echo, time, http.get`);
  }
}

const BUILTINS = ["echo", "time", "http.get"];

module.exports = { runTool, BUILTINS };
