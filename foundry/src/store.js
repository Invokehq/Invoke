"use strict";
// Where Foundry keeps things:
//   ~/.foundry/config.json   — global creds/link to Invoke (from `foundry login`)
//   ./foundry.json           — the project (created by `foundry init`)
//   ./.foundry/              — the local governed ledger + signing secret
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INVOKE_WEB = process.env.INVOKE_WEB_URL || "https://invokehq.run";

function home() {
  return process.env.FOUNDRY_HOME || path.join(os.homedir(), ".foundry");
}
function globalConfigPath() {
  return path.join(home(), "config.json");
}
function readGlobalConfig() {
  try {
    return JSON.parse(fs.readFileSync(globalConfigPath(), "utf8"));
  } catch {
    return {};
  }
}
function writeGlobalConfig(cfg) {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(globalConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function projectPath(cwd = process.cwd()) {
  return path.join(cwd, "foundry.json");
}
function findProject(start = process.cwd()) {
  let dir = start;
  while (true) {
    const p = path.join(dir, "foundry.json");
    if (fs.existsSync(p)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function readProject(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "foundry.json"), "utf8"));
}
function writeProject(dir, project) {
  fs.writeFileSync(path.join(dir, "foundry.json"), JSON.stringify(project, null, 2));
}
function ledgerDir(dir) {
  return path.join(dir, ".foundry");
}
function connectorsPath(dir) {
  return path.join(ledgerDir(dir), "connectors.json");
}
function readConnectors(dir) {
  try { return JSON.parse(fs.readFileSync(connectorsPath(dir), "utf8")); } catch { return {}; }
}
function writeConnectors(dir, conns) {
  fs.mkdirSync(ledgerDir(dir), { recursive: true });
  fs.writeFileSync(connectorsPath(dir), JSON.stringify(conns, null, 2));
}

module.exports = {
  INVOKE_WEB, home, globalConfigPath, readGlobalConfig, writeGlobalConfig,
  projectPath, findProject, readProject, writeProject, ledgerDir,
  connectorsPath, readConnectors, writeConnectors,
};
