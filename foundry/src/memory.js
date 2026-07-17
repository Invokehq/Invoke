"use strict";
// Shared workspace memory — the Context layer, as a governed Execution type.
//
// The problem this solves: agents redo each other's research, and silently act on facts
// that changed under them. So memory here is NOT a scratchpad — it has the same semantics
// as Invoke's cloud memory, so local and cloud agree:
//
//   keyed upsert  — one canonical fact per key, instead of near-duplicate notes
//   version       — every write bumps it
//   revisions     — the last 10 prior values, with who wrote them and when
//   contested     — the last write replaced a DIFFERENT value: someone changed this
//                   under you. This is the stale-context signal.
//   stale         — a TTL'd fact whose time is up: it went quietly out of date
//
// Search is LEXICAL (substring/keyword match), not semantic. Real semantic retrieval
// needs embeddings; that is deliberately not built or claimed here.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MEMORY_TOOLS = ["memory.set", "memory.get", "memory.search"];
const MAX_REVISIONS = 10;

function now() { return Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }

class Memory {
  constructor(dir) { this.file = path.join(dir, "memory.json"); }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return { memory: [] }; }
  }
  _save(d) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(d, null, 2));
  }

  // Derived on read, exactly like the cloud does it — so a fact never lies about
  // whether it is contested or past its TTL.
  _view(m) {
    const revisions = m.revisions || [];
    return Object.assign({}, m, {
      contested: !!(revisions.length && revisions[revisions.length - 1].content !== m.content),
      stale: !!(m.expires_at && m.expires_at < now()),
      expires_at: m.expires_at ? iso(m.expires_at) : null,
      created_at: iso(m.created_at),
      updated_at: iso(m.updated_at || m.created_at),
    });
  }

  // Write a shared fact. A keyed write UPSERTS the one canonical fact for that key;
  // replacing a different value is a conflict — the prior value is kept in revisions
  // and returned, so a changed fact surfaces instead of silently overwriting.
  set({ key, content, agent, tags, ttl_seconds, confidence }) {
    if (typeof content !== "string" || !content.trim()) throw new Error("memory.set needs 'content'");
    content = content.trim();
    const d = this._load();
    const t = now();
    const expires_at = Number(ttl_seconds) > 0 ? t + Number(ttl_seconds) * 1000 : null;
    const memKey = typeof key === "string" && key.trim() ? key.trim() : null;

    if (memKey) {
      const existing = d.memory.find((m) => m.key === memKey);
      if (existing) {
        const conflict = existing.content !== content;
        existing.revisions = (existing.revisions || []).concat([{
          content: existing.content, by: existing.updated_by || existing.creator_agent,
          version: existing.version || 1, at: iso(existing.updated_at || existing.created_at),
        }]).slice(-MAX_REVISIONS);
        const previous = existing.content;
        existing.content = content;
        existing.version = (existing.version || 1) + 1;
        existing.updated_at = t;
        existing.updated_by = agent || null;
        if (tags) existing.tags = tags;
        if (confidence !== undefined) existing.confidence = confidence;
        existing.expires_at = expires_at;
        this._save(d);
        return { memory: this._view(existing), updated: true, conflict, previous: conflict ? previous : null };
      }
    }

    const rec = {
      id: "mem_" + crypto.randomBytes(6).toString("hex"),
      key: memKey,
      content,
      tags: tags || [],
      version: 1,
      creator_agent: agent || null,
      updated_by: agent || null,
      confidence: confidence !== undefined ? confidence : null,
      revisions: [],
      expires_at,
      created_at: t,
      updated_at: t,
    };
    d.memory.push(rec);
    this._save(d);
    return { memory: this._view(rec), updated: false, conflict: false, previous: null };
  }

  get(key) {
    const m = this._load().memory.find((x) => x.key === key);
    return m ? this._view(m) : null;
  }

  // Lexical search: substring match on content (and optional tag/key filters).
  // Not semantic — a query only matches text it literally contains.
  search({ q, tag, key, include_stale = true, limit = 100 } = {}) {
    let out = this._load().memory.map((m) => this._view(m));
    if (q) { const ql = String(q).toLowerCase(); out = out.filter((m) => m.content.toLowerCase().includes(ql)); }
    if (tag) out = out.filter((m) => (m.tags || []).includes(tag));
    if (key) out = out.filter((m) => m.key === key);
    if (!include_stale) out = out.filter((m) => !m.stale);
    return out.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1)).slice(0, Math.max(1, Math.min(limit, 500)));
  }

  list() { return this._load().memory.map((m) => this._view(m)); }
}

// The memory adapter behind the `memory.*` Execution type. Returns plain results; the
// caller wraps them in the ledger (so every read/write is receipted like any Execution).
async function runMemoryTool(dir, tool, params = {}) {
  const mem = new Memory(dir);
  switch (tool) {
    case "memory.set": {
      const r = mem.set(params);
      // The payoff: a write that replaced someone else's value says so, loudly.
      return r.conflict
        ? Object.assign({}, r, { warning: `contested: '${params.key}' held a different value (v${r.memory.version - 1}), written by ${r.memory.revisions.slice(-1)[0].by || "another agent"}. Previous kept in revisions.` })
        : r;
    }
    case "memory.get": {
      if (!params.key) throw new Error("memory.get needs {\"key\": \"...\"}");
      const m = mem.get(params.key);
      if (!m) return { found: false, key: params.key };
      return Object.assign({ found: true }, m,
        m.stale ? { warning: `stale: this fact's TTL expired at ${m.expires_at} — re-verify before acting on it.` } : {},
        m.contested ? { warning: `contested: last changed by ${m.updated_by || "another agent"} (v${m.version}); a different value was replaced. See revisions.` } : {});
    }
    case "memory.search":
      return { count: mem.search(params).length, memory: mem.search(params), search: "lexical" };
    default:
      throw new Error(`unknown memory tool '${tool}'. Try: ${MEMORY_TOOLS.join(", ")}`);
  }
}

module.exports = { Memory, runMemoryTool, MEMORY_TOOLS };
