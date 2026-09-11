"use strict";
// Device sign-in: how Foundry gets its own Invoke key without anyone pasting one.
//
//   Foundry asks Invoke for a code  →  you open the link, sign in, approve  →  Foundry
//   collects a key minted for this machine and keeps it in ~/.foundry/config.json.
//
// The key is a *member* key: agents on this machine can run governed calls in your
// workspace, but can't change policy or clear their own approvals — that stays with you.
//
// A sign-in in flight lives in ~/.foundry/device.json, so `foundry login`, the MCP server
// and the Claude Code session hook all show the same code instead of each minting one.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("./store");

const DEFAULT_BASE = "https://api.invokehq.run";
// Invoke keeps an approved sign-in collectable for an hour after the approval.
const CLAIM_WINDOW_MS = 60 * 60 * 1000;
// Treat a code this close to expiring as already gone, so nobody is shown a dead one.
const EXPIRY_MARGIN_MS = 30 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiBase() {
  const cfg = store.readGlobalConfig();
  return (process.env.INVOKE_API_URL || cfg.invoke_base || DEFAULT_BASE).replace(/\/+$/, "");
}

function signedIn() {
  return !!(store.readGlobalConfig().invoke_token || process.env.INVOKE_API_KEY);
}

// What the approval page and the key list call this machine.
function clientName(projectName) {
  const host = (os.hostname() || "").split(".")[0] || "this machine";
  return `Foundry · ${host}${projectName ? ` · ${projectName}` : ""}`.slice(0, 80);
}

function pendingPath() { return path.join(store.home(), "device.json"); }
function readPending() {
  try {
    const p = JSON.parse(fs.readFileSync(pendingPath(), "utf8"));
    return p.base === apiBase() && Date.now() < p.expires_at + CLAIM_WINDOW_MS ? p : null;
  } catch { return null; }
}
function writePending(p) {
  fs.mkdirSync(store.home(), { recursive: true });
  fs.writeFileSync(pendingPath(), JSON.stringify(p, null, 2), { mode: 0o600 });
}
function clearPending() { try { fs.unlinkSync(pendingPath()); } catch { /* already gone */ } }

async function post(base, apiPath, body, timeoutMs = 10000) {
  const res = await fetch(base + apiPath, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "foundry" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

function saveCredentials(base, grant) {
  const cfg = store.readGlobalConfig();
  Object.assign(cfg, {
    invoke_token: grant.api_key,
    invoke_base: base,
    invoke_org: grant.org_id || null,
    invoke_workspace: grant.workspace_id || null,
    invoke_key_prefix: grant.api_key_prefix || null,
    invoke_key_role: grant.role || "member",
    linked_at: new Date().toISOString(),
    linked_via: "device",
  });
  store.writeGlobalConfig(cfg);
}

// Ask Invoke for a fresh code and remember it.
async function begin({ projectName, timeoutMs } = {}) {
  const base = apiBase();
  const { status, json } = await post(base, "/v1/device/code", { client_name: clientName(projectName) }, timeoutMs);
  if (status !== 200 || !json.device_code) throw new Error(`Invoke sign-in is unavailable (HTTP ${status})`);
  const pending = {
    base,
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    verification_uri_complete: json.verification_uri_complete,
    interval: json.interval || 5,
    expires_at: Date.now() + (json.expires_in || 900) * 1000,
  };
  writePending(pending);
  return pending;
}

// One poll → { state: signed_in | pending | slow_down | denied | expired }.
async function poll(pending, { timeoutMs } = {}) {
  if (signedIn()) { clearPending(); return { state: "signed_in" }; }
  const { status, json } = await post(pending.base, "/v1/device/token", { device_code: pending.device_code }, timeoutMs);
  if (status === 200 && json.status === "approved" && json.api_key) {
    saveCredentials(pending.base, json);
    clearPending();
    return { state: "signed_in" };
  }
  if (status === 200) return { state: "pending" };
  if (status === 429) return { state: "slow_down", interval: json.interval };
  if (status === 403) { clearPending(); return { state: "denied" }; }
  if (status === 410 || status === 404) {
    // 410 can mean another process on this machine just collected the key — give its
    // config write a moment to land before calling the sign-in expired.
    if (status === 410) await sleep(750);
    clearPending();
    return { state: signedIn() ? "signed_in" : "expired" };
  }
  return { state: "pending" }; // a transient server error is not a verdict — keep waiting
}

// Make progress without blocking: collect an approved key if there is one, otherwise make
// sure a live code exists. → { signedIn: true } | { signedIn: false, pending, denied }
async function advance({ projectName, timeoutMs } = {}) {
  if (signedIn()) return { signedIn: true };
  let denied = false;
  const existing = readPending();
  if (existing) {
    const r = await poll(existing, { timeoutMs });
    if (r.state === "signed_in") return { signedIn: true };
    const live = Date.now() < existing.expires_at - EXPIRY_MARGIN_MS;
    if ((r.state === "pending" || r.state === "slow_down") && live) return { signedIn: false, pending: existing, denied };
    denied = r.state === "denied";
    clearPending();
  }
  return { signedIn: false, pending: await begin({ projectName, timeoutMs }), denied };
}

// Block until the sign-in resolves (`foundry login`).
async function waitFor(pending, { onTick } = {}) {
  let interval = pending.interval || 5;
  while (Date.now() < pending.expires_at) {
    await sleep(interval * 1000);
    let r;
    try { r = await poll(pending); } catch { r = { state: "pending" }; } // network blip — keep going
    if (r.state === "slow_down") { interval = r.interval || interval + 5; continue; }
    if (r.state !== "pending") return r;
    if (onTick) onTick();
  }
  clearPending();
  return { state: "expired" };
}

// Point a project at the workspace this machine was authorized into, so its governed
// calls mirror to the dashboard. A project already linked somewhere keeps its link.
function linkProject(dir) {
  const cfg = store.readGlobalConfig();
  if (!cfg.invoke_workspace || !dir) return false;
  const project = store.readProject(dir);
  if (project.invoke && project.invoke.workspace) return false;
  project.invoke = Object.assign({}, project.invoke, { workspace: cfg.invoke_workspace, base: cfg.invoke_base });
  store.writeProject(dir, project);
  return true;
}

function minutesLeft(pending) {
  return Math.max(1, Math.round((pending.expires_at - Date.now()) / 60000));
}

// What a person reads when Foundry needs them — in a tool result, a hook, or the terminal.
function signInPrompt(pending, { denied = false } = {}) {
  return (denied ? "The last sign-in was denied.\n\n" : "") +
    `🔐 Sign in to Invoke to use Foundry.\n\n` +
    `Open ${pending.verification_uri_complete}\n` +
    `and confirm the code ${pending.user_code} (expires in ${minutesLeft(pending)} min).\n\n` +
    `Foundry picks up the approval on its own — then try again.`;
}

// Forget this machine's key (the key itself stays valid until revoked in the dashboard).
function logout() {
  const cfg = store.readGlobalConfig();
  const prefix = cfg.invoke_key_prefix || null;
  for (const k of ["invoke_token", "invoke_org", "invoke_workspace", "invoke_key_prefix", "invoke_key_role", "linked_at", "linked_via"]) delete cfg[k];
  store.writeGlobalConfig(cfg);
  clearPending();
  return prefix;
}

module.exports = {
  DEFAULT_BASE, apiBase, signedIn, clientName, begin, poll, advance, waitFor,
  linkProject, signInPrompt, minutesLeft, logout, saveCredentials, readPending,
};
