"use strict";
// Execution-control policies. A policy names patterns that Foundry allows, denies, or
// gates behind approval — evaluated on every execution (tool or model) BEFORE it runs.
// Precedence: deny > approve > allow > default(allow). Patterns are globs ("stripe.*",
// "github.read", "*"). Stored in foundry.json under `policies`.

function toRegex(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function loadPolicies(project) {
  const p = (project && project.policies) || {};
  return { deny: p.deny || [], approve: p.approve || [], allow: p.allow || [] };
}

function evaluate(policies, name) {
  for (const g of policies.deny) if (toRegex(g).test(name)) return { effect: "deny", rule: g };
  for (const g of policies.approve) if (toRegex(g).test(name)) return { effect: "approve", rule: g };
  for (const g of policies.allow) if (toRegex(g).test(name)) return { effect: "allow", rule: g };
  return { effect: "allow", rule: null };
}

module.exports = { toRegex, loadPolicies, evaluate };
