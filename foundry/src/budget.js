"use strict";
// Budgets: a fleet cap (the whole workspace) plus optional per-agent caps. Enforced as a
// hard stop — once an agent's (or the fleet's) cumulative spend crosses its cap, the next
// spending call is refused (429), matching the cloud's trip-at-100% behavior. Free replays
// (cache hits, deduped retries) cost nothing, so they're always allowed — the caller checks
// the cache first, then the budget.
//
// Spend is summed from the ledger's cost_micros, per agent. Model calls are the usual
// spenders; any execution with a cost counts the same.

// Total spend and a per-agent breakdown, in micro-dollars.
function spend(ledger) {
  const by = {};
  let total = 0;
  for (const e of ledger.list()) {
    const c = e.cost_micros || 0;
    total += c;
    const a = e.agent_id || "—";
    by[a] = (by[a] || 0) + c;
  }
  return { total, by };
}

// Is a NEW spending call by `agent` already over a cap? null = fine; otherwise the tripped
// cap: { scope, cap, spent } (dollars). Fleet is checked first, then the agent's own cap.
function overCap(project, ledger, agent) {
  const s = spend(ledger);
  if (project.budget_usd && s.total / 1e6 >= project.budget_usd) {
    return { scope: "fleet", cap: Number(project.budget_usd), spent: s.total / 1e6 };
  }
  const caps = project.agent_budgets || {};
  if (agent && caps[agent] != null && (s.by[agent] || 0) / 1e6 >= caps[agent]) {
    return { scope: "agent " + agent, cap: Number(caps[agent]), spent: (s.by[agent] || 0) / 1e6 };
  }
  return null;
}

module.exports = { spend, overCap };
