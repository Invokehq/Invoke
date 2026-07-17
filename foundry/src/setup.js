"use strict";
// The "integrate in 5 minutes" primitive.
//
// This is what makes the hero flow real: you're inside Claude Code (or Codex), you say
// "integrate Invoke", and the agent — because `foundry serve` is its MCP server — calls
// this `setup` tool. It provisions governance on the project (budget + a starter safety
// policy), then hands the agent the exact integration steps + the model-proxy snippet to
// drop into the codebase. The agent does the wiring; Foundry makes every call governed.
const store = require("./store");

const DESTRUCTIVE = ["*delete*", "*destroy*", "*.remove", "*drop*"];

function runSetup(dir, project, args = {}) {
  const steps = [];

  // 1) Budget — a spend cap the model proxy enforces (429 once exhausted).
  const budget = Number(args.budget_usd) > 0 ? Number(args.budget_usd) : (project.budget_usd || 5);
  const hadBudget = !!project.budget_usd;
  project.budget_usd = budget;
  steps.push(`Budget set — $${budget.toFixed(2)} cap${hadBudget ? " (kept)" : ""}`);

  // 2) Starter safety policy — destructive tools require human approval before they run.
  project.policies = project.policies || {};
  project.policies.approve = project.policies.approve || [];
  let added = 0;
  for (const p of DESTRUCTIVE) if (!project.policies.approve.includes(p)) { project.policies.approve.push(p); added++; }
  steps.push(added ? `Starter policy — ${added} destructive pattern(s) now require approval` : `Policy — destructive tools already gated`);

  store.writeProject(dir, project);

  const conns = Object.keys(store.readConnectors(dir) || {});
  steps.unshift(
    `Governed workspace ready — ${project.name}`,
    `Tool calls route through the Invoke ledger — identity, exactly-once, signed receipts` +
      (conns.length ? ` (${conns.length} connector: ${conns.join(", ")})` : "")
  );

  const snippet = {
    js: `import OpenAI from "openai";\n// Governed by Invoke — every completion is a receipted, budgeted Execution\nconst client = new OpenAI({ baseURL: "http://localhost:4000/v1", apiKey: process.env.OPENAI_API_KEY });`,
    py: `from openai import OpenAI\n# Governed by Invoke — every completion is a receipted, budgeted Execution\nclient = OpenAI(base_url="http://localhost:4000/v1", api_key=os.environ["OPENAI_API_KEY"])`,
  };
  const commands = [
    ["foundry model serve", "start the governed model proxy (localhost:4000)"],
    ["foundry receipts --verify", "prove every call — tamper-evident hash-chain"],
    ["foundry trace --follow", "watch executions stream live as your agent works"],
  ];

  // The text the agent reads back — a Didit-style checklist it can relay + act on.
  const text =
    steps.map((s) => `✓ ${s}`).join("\n") +
    `\n\nTo govern your model calls too, point your LLM client at the Foundry proxy:\n\n` +
    `  // JavaScript\n  ${snippet.js.replace(/\n/g, "\n  ")}\n\n` +
    `  # Python\n  ${snippet.py.replace(/\n/g, "\n  ")}\n\n` +
    `Then:\n` + commands.map(([c, d]) => `  ${c.padEnd(26)} # ${d}`).join("\n") +
    `\n\n→ Governed in ~5 min. Mission Control: ${store.INVOKE_WEB}/dashboard`;

  return { budget, steps, snippet, commands, text };
}

module.exports = { runSetup, DESTRUCTIVE };
