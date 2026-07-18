"use strict";
// Human-in-the-loop approvals. When a policy marks a tool `approve`, the agent's call is
// not silently blocked — it queues a PENDING approval a person reviews. On approve, the
// effect executes once and commits, so the agent gets the result exactly-once on its next
// identical call (the ledger dedups on the effect key). On deny, a signed refusal is
// recorded. Race-safe via the same lockfile mutex as coord/memory.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } }

class Approvals {
  constructor(dir) { this.file = path.join(dir, "approvals.json"); this.lock = this.file + ".lock"; }
  _load() { try { const d = JSON.parse(fs.readFileSync(this.file, "utf8")); d.approvals = d.approvals || []; return d; } catch { return { approvals: [] }; } }
  _save(d) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(d, null, 2)); }
  _withLock(fn) {
    for (let i = 0; i < 400; i++) {
      let fd;
      try { fd = fs.openSync(this.lock, "wx"); } catch (e) { if (e.code !== "EEXIST") throw e; sleepSync(5); continue; }
      try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(this.lock); } catch { /* gone */ } }
    }
    throw new Error("could not acquire the approvals lock");
  }

  // Queue an approval for an effect. Idempotent on effect_key: an agent that re-calls while
  // still pending gets back the SAME request, not a growing pile.
  request({ agent, tool, params, key, effect_key, rule }) {
    return this._withLock(() => {
      const d = this._load();
      const existing = d.approvals.find((x) => x.effect_key === effect_key && x.status === "pending");
      if (existing) return { approval: existing, existing: true };
      const a = {
        id: "apr_" + crypto.randomBytes(5).toString("hex"),
        agent: agent || null, tool, params: params || {}, key: key || null,
        effect_key, rule: rule || null, status: "pending",
        created_at: Date.now(), resolved_at: null, by: null,
      };
      d.approvals.push(a); this._save(d);
      return { approval: a, existing: false };
    });
  }

  list(status = "pending") { return this._load().approvals.filter((a) => !status || a.status === status); }
  get(id) { return this._load().approvals.find((a) => a.id === id || (id && a.id.endsWith(id))); }

  // Mark an approval approved/denied. Returns { approval } (or { already } if not pending).
  // Execution of the approved effect happens in the caller, which has the tool adapters.
  resolve(id, decision, by) {
    return this._withLock(() => {
      const d = this._load();
      const a = d.approvals.find((x) => x.id === id || (id && x.id.endsWith(id)));
      if (!a) throw new Error(`approval '${id}' not found`);
      if (a.status !== "pending") return { approval: a, already: true };
      a.status = decision === "approve" ? "approved" : "denied";
      a.resolved_at = Date.now(); a.by = by || null;
      this._save(d);
      return { approval: a };
    });
  }
}

module.exports = { Approvals };
