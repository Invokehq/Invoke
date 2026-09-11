"use strict";
// Device sign-in: `foundry login`, the MCP server's sign-in gate, and the Claude Code
// session hook — all against a fake Invoke device API (no network).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "foundry.js");
const CODE = "BCDF-GHJK";

// A stand-in for Invoke's /v1/device/* API. A request stays pending for `approveAfterPolls`
// polls, then hands out its member key exactly once (a later poll gets 410).
function fakeInvoke({ approveAfterPolls = 1, deny = false } = {}) {
  const state = { requests: new Map(), issued: 0, mirrored: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/device/code") {
        const dc = `dc_${state.requests.size + 1}`;
        state.requests.set(dc, { status: "pending", polls: 0, client_name: body.client_name });
        return send(200, { device_code: dc, user_code: CODE, verification_uri: "http://console.test/device",
          verification_uri_complete: `http://console.test/device?code=${CODE}`, expires_in: 900, interval: 0.05 });
      }
      if (req.url === "/v1/device/token") {
        const r = state.requests.get(body.device_code);
        if (!r) return send(404, { detail: "unknown device code" });
        if (r.status === "consumed") return send(410, { detail: "already completed" });
        if (deny) return send(403, { detail: "denied" });
        if (++r.polls <= approveAfterPolls) return send(200, { status: "pending", interval: 0.05 });
        r.status = "consumed";
        state.issued++;
        return send(200, { status: "approved", api_key: "inv_member_test_key", api_key_prefix: "inv_member_t...tkey",
          role: "member", org_id: "org_t", workspace_id: "ws_t", client_name: r.client_name });
      }
      // cloud mirroring from a signed-in `serve` (agent register + effect)
      if (/^\/v1\/workspaces\/[^/]+\/agents$/.test(req.url)) return send(201, { agent: { id: body.id } });
      if (/^\/v1\/workspaces\/[^/]+\/effects$/.test(req.url)) { state.mirrored.push({ url: req.url, key: req.headers["x-api-key"] }); return send(200, { decision: "committed" }); }
      send(404, { detail: "not found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

function sandbox(base) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fh-auth-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdr-auth-"));
  const env = { ...process.env, FOUNDRY_HOME: home, INVOKE_API_URL: base };
  delete env.INVOKE_API_KEY;
  delete env.FOUNDRY_LOCAL;
  return { home, dir, env, config: () => { try { return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")); } catch { return {}; } } };
}

// Async spawn (spawnSync would block this process, and with it the fake server).
function foundry(args, { cwd, env, input = "" }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const replies = (stdout) => Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m]));

test("serve refuses tools with the sign-in link until approved, then runs them on the new key", async () => {
  const api = await fakeInvoke({ approveAfterPolls: 1 });
  const s = sandbox(api.base);
  const input = [
    rpc(1, "initialize", {}),
    rpc(2, "tools/call", { name: "echo", arguments: { msg: "before" } }),
    rpc(3, "tools/call", { name: "echo", arguments: { msg: "after" } }),
  ].join("\n") + "\n";
  const r = await foundry(["serve"], { cwd: s.dir, env: s.env, input });
  api.server.close();
  const out = replies(r.stdout);

  // the agent is told up front, with the same code the person will see
  assert.match(out[1].result.instructions, new RegExp(CODE));
  // signed out: the call is refused with the link — nothing ran
  assert.equal(out[2].result.isError, true);
  assert.match(out[2].result.content[0].text, /Sign in to Invoke/);
  assert.match(out[2].result.content[0].text, new RegExp(`device\\?code=${CODE}`));
  // approved in between: the next call collects the key and runs
  assert.ok(!out[3].result.isError, r.stderr);
  assert.match(out[3].result.content[0].text, /after/);
  assert.equal(api.state.requests.size, 1, "one sign-in request, reused — not one per call");
  assert.equal(api.state.issued, 1);

  const cfg = s.config();
  assert.equal(cfg.invoke_token, "inv_member_test_key");
  assert.equal(cfg.invoke_key_role, "member");
  const project = JSON.parse(fs.readFileSync(path.join(s.dir, "foundry.json"), "utf8"));
  assert.equal(project.invoke.workspace, "ws_t", "project linked to the workspace it was authorized into");
  assert.ok(!fs.existsSync(path.join(s.home, "device.json")), "the spent sign-in is cleared");
});

test("a sign-in approved before the session starts is collected at initialize, linked and mirrored", async () => {
  const api = await fakeInvoke({ approveAfterPolls: 0 });
  const s = sandbox(api.base);
  await foundry(["hook", "session-start"], { cwd: s.dir, env: s.env }); // the hook starts the sign-in…
  // …the person approves (approveAfterPolls: 0), then the MCP server starts
  const input = [rpc(1, "initialize", {}), rpc(2, "tools/call", { name: "echo", arguments: { msg: "hi" } })].join("\n") + "\n";
  const r = await foundry(["serve"], { cwd: s.dir, env: s.env, input });
  api.server.close();
  const out = replies(r.stdout);
  assert.doesNotMatch(out[1].result.instructions, /not signed in/);
  assert.ok(!out[2].result.isError, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, "foundry.json"), "utf8")).invoke.workspace, "ws_t");
  assert.equal(api.state.mirrored.length, 1, "the call streamed to the workspace it signed into");
  assert.equal(api.state.mirrored[0].key, "inv_member_test_key", "…on the machine's own member key");
});

test("a signed-in machine links each new project it serves", async () => {
  const api = await fakeInvoke();
  const s = sandbox(api.base);
  fs.writeFileSync(path.join(s.home, "config.json"), JSON.stringify({ invoke_token: "inv_member_test_key", invoke_base: api.base, invoke_workspace: "ws_t" }));
  const r = await foundry(["serve"], { cwd: s.dir, env: s.env, input: rpc(1, "tools/call", { name: "echo", arguments: {} }) + "\n" });
  api.server.close();
  assert.ok(!replies(r.stdout)[1].result.isError, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, "foundry.json"), "utf8")).invoke.workspace, "ws_t");
  assert.equal(api.state.mirrored.length, 1);
});

test("serve --local works offline, with no sign-in", async () => {
  const s = sandbox("http://127.0.0.1:9"); // nothing listens here
  const input = [rpc(1, "initialize", {}), rpc(2, "tools/call", { name: "echo", arguments: { msg: "offline" } })].join("\n") + "\n";
  const r = await foundry(["serve", "--local"], { cwd: s.dir, env: s.env, input });
  const out = replies(r.stdout);
  assert.doesNotMatch(out[1].result.instructions, /not signed in/);
  assert.ok(!out[2].result.isError, r.stderr);
  assert.match(out[2].result.content[0].text, /offline/);
});

test("session hook shows the link + code when signed out, and stays quiet when signed in", async () => {
  const api = await fakeInvoke({ approveAfterPolls: 99 });
  const s = sandbox(api.base);
  const out = await foundry(["hook", "session-start"], { cwd: s.dir, env: s.env });
  assert.equal(out.status, 0, out.stderr);
  const msg = JSON.parse(out.stdout);
  assert.match(msg.systemMessage, new RegExp(CODE));
  assert.equal(msg.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(msg.hookSpecificOutput.additionalContext, /refuse/);

  fs.writeFileSync(path.join(s.home, "config.json"), JSON.stringify({ invoke_token: "inv_x" }));
  const quiet = await foundry(["hook", "session-start"], { cwd: s.dir, env: s.env });
  api.server.close();
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout.trim(), "");
});

test("session hook never fails the session when Invoke is unreachable", async () => {
  const s = sandbox("http://127.0.0.1:9");
  const out = await foundry(["hook", "session-start"], { cwd: s.dir, env: s.env });
  assert.equal(out.status, 0, out.stderr);
  assert.match(JSON.parse(out.stdout).systemMessage, /foundry login/);
});

test("login waits for the browser approval, then stores this machine's own member key", async () => {
  const api = await fakeInvoke({ approveAfterPolls: 1 });
  const s = sandbox(api.base);
  fs.writeFileSync(path.join(s.dir, "foundry.json"), JSON.stringify({ name: "demo", agent: {} }));
  const r = await foundry(["login", "--no-browser"], { cwd: s.dir, env: s.env });
  api.server.close();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(CODE));
  assert.match(r.stdout, /Signed in to Invoke/);
  assert.match(r.stdout, /can't change policy/);
  assert.equal(s.config().invoke_token, "inv_member_test_key");
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, "foundry.json"), "utf8")).invoke.workspace, "ws_t");
});

test("a denied login fails loudly and stores nothing", async () => {
  const api = await fakeInvoke({ deny: true });
  const s = sandbox(api.base);
  const r = await foundry(["login", "--no-browser"], { cwd: s.dir, env: s.env });
  api.server.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /denied/);
  assert.equal(s.config().invoke_token, undefined);
});

test("logout forgets the key but says it stays valid until revoked", async () => {
  const s = sandbox("http://127.0.0.1:9");
  fs.writeFileSync(path.join(s.home, "config.json"), JSON.stringify({ invoke_token: "inv_x", invoke_key_prefix: "inv_x...abcd" }));
  const r = await foundry(["logout"], { cwd: s.dir, env: s.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /inv_x\.\.\.abcd/);
  assert.equal(s.config().invoke_token, undefined);
});
