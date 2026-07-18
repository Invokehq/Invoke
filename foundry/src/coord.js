"use strict";
// Multi-agent coordination — the piece that turns "several agents" into a team that
// doesn't collide. Two agents can want the same task; a task can depend on another;
// one agent can hand work to a second. The primitives, with the SAME semantics as
// Invoke's cloud so local and cloud agree:
//
//   claim   — an ATOMIC single-owner lock. N agents race for a task, exactly ONE wins;
//             everyone else is told "already claimed by X" instead of doing it twice.
//   deps    — a task can't be claimed until its upstream dependencies are done (DAG gate).
//   handoff — agent A hands a task (with context) to agent B, who accepts or rejects.
//
// Local claims are made atomic with a lockfile mutex around the read-modify-write, so two
// processes sharing this .foundry can't both win. Once graduated (`foundry push`), claims
// route to the cloud workspace, which is race-safe across machines — see src/cloud.js.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DONE = new Set(["done", "completed", "complete"]);
function now() { return Date.now(); }
function iso(ms) { return ms ? new Date(ms).toISOString() : null; }
// Dependency-free synchronous sleep (no busy loop) for the lock spin.
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } }

class Coord {
  constructor(dir) { this.file = path.join(dir, "coord.json"); this.lock = this.file + ".lock"; }

  _load() { try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return { tasks: [], deps: {}, handoffs: [] }; } }
  _save(d) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(d, null, 2)); }

  // Mutual exclusion via an O_EXCL lockfile: only one process holds it at a time, so a
  // read-then-conditional-write (the claim) can't interleave with a rival's.
  _withLock(fn) {
    for (let i = 0; i < 400; i++) {
      let fd;
      try { fd = fs.openSync(this.lock, "wx"); } catch (e) { if (e.code !== "EEXIST") throw e; sleepSync(5); continue; }
      try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(this.lock); } catch { /* gone */ } }
    }
    throw new Error("could not acquire the coordination lock");
  }

  _view(t, d) {
    return Object.assign({}, t, {
      depends_on: (d.deps[t.id] || []).slice(),
      blockers: this._blockers(d, t.id),
      claimed_at: iso(t.claimed_at), created_at: iso(t.created_at), updated_at: iso(t.updated_at),
    });
  }
  _blockers(d, taskId) {
    return (d.deps[taskId] || [])
      .map((id) => d.tasks.find((x) => x.id === id))
      .filter((x) => x && !DONE.has(x.status))
      .map((x) => ({ task_id: x.id, title: x.title, status: x.status }));
  }
  // Would adding dep_id → taskId create a cycle? Walk dep_id's ancestors for taskId.
  _wouldCycle(d, taskId, depId) {
    if (taskId === depId) return true;
    const seen = new Set(); const stack = [depId];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === taskId) return true;
      if (seen.has(cur)) continue; seen.add(cur);
      for (const up of d.deps[cur] || []) stack.push(up);
    }
    return false;
  }

  addTask({ title, required_capability, depends_on, agent, status }) {
    if (typeof title !== "string" || !title.trim()) throw new Error("task needs a title");
    return this._withLock(() => {
      const d = this._load();
      const t = { id: "task_" + crypto.randomBytes(6).toString("hex"), title: title.trim(), status: status || "open",
        assigned_agent: agent || null, claimed_by: null, claimed_at: null, required_capability: required_capability || null,
        output: null, created_at: now(), updated_at: now() };
      d.tasks.push(t);
      for (const dep of depends_on || []) if (d.tasks.find((x) => x.id === dep) && !this._wouldCycle(d, t.id, dep)) (d.deps[t.id] = d.deps[t.id] || []).push(dep);
      this._save(d);
      return this._view(t, d);
    });
  }

  list() { const d = this._load(); return d.tasks.map((t) => this._view(t, d)); }
  get(id) { const d = this._load(); const t = d.tasks.find((x) => x.id === id); return t ? this._view(t, d) : null; }

  addDep(taskId, depId) {
    return this._withLock(() => {
      const d = this._load();
      if (!d.tasks.find((x) => x.id === taskId)) throw new Error(`task '${taskId}' not found`);
      if (!d.tasks.find((x) => x.id === depId)) throw new Error(`dependency '${depId}' not found`);
      if (this._wouldCycle(d, taskId, depId)) throw new Error("that dependency would create a cycle");
      d.deps[taskId] = [...new Set([...(d.deps[taskId] || []), depId])];
      this._save(d);
      return this._view(d.tasks.find((x) => x.id === taskId), d);
    });
  }

  // The heart of it: atomic claim. Inside the lock, claim only if currently unclaimed and
  // unblocked — so a rival's concurrent attempt loses cleanly.
  claim(taskId, agent) {
    if (!agent) throw new Error("claiming a task needs an --agent");
    return this._withLock(() => {
      const d = this._load();
      const t = d.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`task '${taskId}' not found`);
      const blockers = this._blockers(d, taskId);
      if (t.claimed_by == null && blockers.length) return { claimed: false, blocked: true, blockers, task: this._view(t, d) };
      if (t.claimed_by && t.claimed_by !== agent) return { claimed: false, conflict: true, owner: t.claimed_by, task: this._view(t, d) };
      if (t.claimed_by === agent) return { claimed: true, already_owner: true, task: this._view(t, d) };
      t.claimed_by = agent; t.claimed_at = now(); t.status = "claimed"; t.assigned_agent = t.assigned_agent || agent; t.updated_at = now();
      this._save(d);
      return { claimed: true, task: this._view(t, d) };
    });
  }

  release(taskId, agent) {
    return this._withLock(() => {
      const d = this._load();
      const t = d.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`task '${taskId}' not found`);
      if (t.claimed_by == null) return { released: false, task: this._view(t, d) };
      if (t.claimed_by !== agent) return { released: false, conflict: true, owner: t.claimed_by, task: this._view(t, d) };
      t.claimed_by = null; t.claimed_at = null; t.status = "open"; t.updated_at = now();
      this._save(d);
      return { released: true, task: this._view(t, d) };
    });
  }

  complete(taskId, agent, output) {
    return this._withLock(() => {
      const d = this._load();
      const t = d.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`task '${taskId}' not found`);
      t.status = "done"; t.output = output != null ? output : t.output; t.updated_at = now();
      this._save(d);
      return { completed: true, task: this._view(t, d) };
    });
  }

  // Topological view of the dependency DAG (Kahn); flags a cycle if one slipped in.
  dag() {
    const d = this._load();
    const ids = d.tasks.map((t) => t.id);
    const indeg = {}; ids.forEach((t) => (indeg[t] = (d.deps[t] || []).length));
    const dependents = {}; ids.forEach((t) => (dependents[t] = []));
    for (const t of ids) for (const dep of d.deps[t] || []) if (dependents[dep]) dependents[dep].push(t);
    let ready = ids.filter((t) => indeg[t] === 0).sort();
    const order = [];
    while (ready.length) {
      const t = ready.shift(); order.push(t);
      for (const nxt of dependents[t]) if (--indeg[nxt] === 0) { ready.push(nxt); ready.sort(); }
    }
    return { order: order.map((id) => this._view(d.tasks.find((x) => x.id === id), d)), has_cycle: order.length !== ids.length };
  }

  // Handoffs: A offers work (with context) to B, who accepts (claims it) or rejects.
  handoff({ from, to, task_id, context }) {
    if (!to) throw new Error("a handoff needs a --to agent");
    return this._withLock(() => {
      const d = this._load();
      const h = { id: "ho_" + crypto.randomBytes(6).toString("hex"), from_agent: from || null, to_agent: to,
        task_id: task_id || null, context: context || "", status: "pending", created_at: now(), resolved_at: null };
      d.handoffs.push(h); this._save(d);
      return h;
    });
  }
  inbox(agent, status) { return this._load().handoffs.filter((h) => (!agent || h.to_agent === agent) && (!status || h.status === status)); }
  resolveHandoff(id, accept, by) {
    return this._withLock(() => {
      const d = this._load();
      const h = d.handoffs.find((x) => x.id === id);
      if (!h) throw new Error(`handoff '${id}' not found`);
      h.status = accept ? "accepted" : "rejected"; h.resolved_at = now(); if (by) h.to_agent = by;
      // Accepting a handoff claims its task for the receiver, so the work actually moves.
      let task = null;
      if (accept && h.task_id) {
        const t = d.tasks.find((x) => x.id === h.task_id);
        if (t) { t.claimed_by = h.to_agent; t.claimed_at = now(); t.status = "claimed"; t.assigned_agent = h.to_agent; t.updated_at = now(); task = this._view(t, d); }
      }
      this._save(d);
      return { handoff: h, task };
    });
  }
}

module.exports = { Coord, DONE };
