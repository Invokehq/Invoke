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
// Search is SEMANTIC when an embeddings provider is configured (real vectors, ranked by
// cosine), and falls back to lexical substring matching otherwise — the result always says
// which ran. Facts live in one of two scopes: this workspace, or `shared` — knowledge that
// spans every project, so an agent in one repo finds what another repo already learned.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const embeddings = require("./embeddings");
const store = require("./store");

const MEMORY_TOOLS = ["memory.set", "memory.get", "memory.search"];
const MAX_REVISIONS = 10;

function now() { return Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } }

class Memory {
  constructor(dir) { this.file = path.join(dir, "memory.json"); this.lock = this.file + ".lock"; }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return { memory: [] }; }
  }
  _save(d) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(d, null, 2));
  }
  // Mutex for the read-modify-write in set()/attachEmbedding(): without it, two agents
  // writing concurrently could lose an update — and contested-detection needs the
  // read-then-write to be atomic to see the prior value.
  _withLock(fn) {
    // The directory may not exist yet — the shared store lives outside any project, so its
    // first write creates it. The lockfile is opened before _save(), so mkdir must be here.
    fs.mkdirSync(path.dirname(this.lock), { recursive: true });
    for (let i = 0; i < 400; i++) {
      let fd;
      try { fd = fs.openSync(this.lock, "wx"); } catch (e) { if (e.code !== "EEXIST") throw e; sleepSync(5); continue; }
      try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(this.lock); } catch { /* gone */ } }
    }
    throw new Error("could not acquire the memory lock");
  }

  // Derived on read, exactly like the cloud does it — so a fact never lies about
  // whether it is contested or past its TTL. The raw vector is stripped from the view
  // (it's large + not human-facing); `embedded` records that one exists.
  _view(m, extra) {
    const revisions = m.revisions || [];
    const v = Object.assign({}, m, {
      contested: !!(revisions.length && revisions[revisions.length - 1].content !== m.content),
      stale: !!(m.expires_at && m.expires_at < now()),
      embedded: !!(m.embedding && m.embedding.length),
      embed_model: m.embed_model || null,
      expires_at: m.expires_at ? iso(m.expires_at) : null,
      created_at: iso(m.created_at),
      updated_at: iso(m.updated_at || m.created_at),
    });
    delete v.embedding;
    return extra ? Object.assign(v, extra) : v;
  }

  // Write a shared fact. A keyed write UPSERTS the one canonical fact for that key;
  // replacing a different value is a conflict — the prior value is kept in revisions
  // and returned, so a changed fact surfaces instead of silently overwriting.
  set(params) { return this._withLock(() => this._setLocked(params)); }
  _setLocked({ key, content, agent, tags, ttl_seconds, confidence, embedding, embed_model }) {
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
        // Re-embed on content change (a stale vector for new text is worse than none).
        if (embedding) { existing.embedding = embedding; existing.embed_model = embed_model || null; }
        else if (conflict) { delete existing.embedding; delete existing.embed_model; }
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
      embedding: embedding || null,
      embed_model: embedding ? (embed_model || null) : null,
      created_at: t,
      updated_at: t,
    };
    d.memory.push(rec);
    this._save(d);
    return { memory: this._view(rec), updated: false, conflict: false, previous: null };
  }

  // Facts that still need a vector for this model (for backfill/reindex).
  unembedded(model) {
    return this._load().memory.filter((m) => !(m.embedding && m.embedding.length && m.embed_model === model));
  }

  // Attach an embedding to an existing fact by id (used by reindex).
  attachEmbedding(id, embedding, embed_model) {
    return this._withLock(() => {
      const d = this._load();
      const m = d.memory.find((x) => x.id === id);
      if (!m) return false;
      m.embedding = embedding; m.embed_model = embed_model;
      this._save(d);
      return true;
    });
  }

  // Semantic ranking: cosine of the query vector against every fact embedded with the
  // SAME model (vectors from different models aren't comparable). Returns facts + score.
  semanticSearch(queryVec, model, { tag, include_stale = true, limit = 10 } = {}) {
    let cands = this._load().memory.filter((m) => m.embedding && m.embedding.length && m.embed_model === model);
    if (tag) cands = cands.filter((m) => (m.tags || []).includes(tag));
    return cands
      .map((m) => this._view(m, { score: Number(embeddings.cosine(queryVec, m.embedding).toFixed(4)) }))
      .filter((m) => include_stale || !m.stale)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 500)));
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
// `project` supplies the embeddings provider config; with a provider, writes are embedded
// and search is semantic — otherwise everything gracefully falls back to lexical.
// Knowledge that outlives one project. A fact written `--shared` lands in a store above
// any workspace, so an agent working in a DIFFERENT repo can still find it — by meaning,
// not just by key. Reads always span both scopes and label where each hit came from.
function sharedDir() { return path.join(store.home(), "shared"); }
const withScope = (rows, scope) => rows.map((m) => Object.assign({}, m, { scope }));

async function runMemoryTool(dir, tool, params = {}, project) {
  const mem = new Memory(dir);
  const shared = new Memory(sharedDir());
  const prov = embeddings.provider(project);
  const limit = Math.max(1, Math.min(Number(params.limit) || 10, 200));

  switch (tool) {
    case "memory.set": {
      // Embed the fact so it's findable by meaning. Best-effort: a provider hiccup must
      // never fail the write — the fact is stored, just without a vector (reindex later).
      let cost = 0;
      if (prov) {
        try {
          const e = await embeddings.embed(prov, params.content);
          params = Object.assign({}, params, { embedding: e.vectors[0], embed_model: e.model });
          cost = e.cost_micros;
        } catch { /* store unembedded; `foundry memory reindex` backfills */ }
      }
      const scope = params.shared ? "shared" : "workspace";
      const r = (params.shared ? shared : mem).set(params);
      r.cost_micros = cost;
      r.embedded = !!(prov && params.embedding);
      r.scope = scope;
      return r.conflict
        ? Object.assign(r, { warning: `contested: '${params.key}' held a different value (v${r.memory.version - 1}), written by ${r.memory.revisions.slice(-1)[0].by || "another agent"}. Previous kept in revisions.` })
        : r;
    }
    case "memory.get": {
      if (!params.key) throw new Error("memory.get needs {\"key\": \"...\"}");
      const local = mem.get(params.key);
      const org = shared.get(params.key);
      const m = local || org;                       // this project's answer wins over the org's
      if (!m) return { found: false, key: params.key };
      return Object.assign({ found: true, scope: local ? "workspace" : "shared" }, m,
        local && org ? { also_shared: true, shared_value: org.content } : {},
        m.stale ? { warning: `stale: this fact's TTL expired at ${m.expires_at} — re-verify before acting on it.` } : {},
        m.contested ? { warning: `contested: last changed by ${m.updated_by || "another agent"} (v${m.version}); a different value was replaced. See revisions.` } : {});
    }
    case "memory.search": {
      // Search this workspace AND the shared org store, then rank them together — so an
      // agent in one repo surfaces what another repo already learned.
      const scopes = params.scope === "workspace" ? ["workspace"] : params.scope === "shared" ? ["shared"] : ["workspace", "shared"];
      const wantSemantic = !!prov && !!params.q && params.semantic !== false;
      if (wantSemantic) {
        try {
          const e = await embeddings.embed(prov, params.q);
          const hits = [
            ...(scopes.includes("workspace") ? withScope(mem.semanticSearch(e.vectors[0], e.model, params), "workspace") : []),
            ...(scopes.includes("shared") ? withScope(shared.semanticSearch(e.vectors[0], e.model, params), "shared") : []),
          ].sort((a, b) => b.score - a.score).slice(0, limit);
          return { count: hits.length, memory: hits, search: "semantic", model: e.model, cost_micros: e.cost_micros, scopes };
        } catch { /* provider down → fall through to lexical */ }
      }
      const hits = [
        ...(scopes.includes("workspace") ? withScope(mem.search(params), "workspace") : []),
        ...(scopes.includes("shared") ? withScope(shared.search(params), "shared") : []),
      ].slice(0, limit);
      return { count: hits.length, memory: hits, search: "lexical", cost_micros: 0, scopes };
    }
    default:
      throw new Error(`unknown memory tool '${tool}'. Try: ${MEMORY_TOOLS.join(", ")}`);
  }
}

// Backfill embeddings for facts that don't have one for the active model (offline writes,
// or a provider configured after the fact). Covers BOTH scopes — shared knowledge is
// useless if it was written before a provider existed and never got vectors.
async function reindex(dir, project) {
  const prov = embeddings.provider(project);
  if (!prov) return { error: "no embeddings provider configured" };
  let reindexed = 0, cost = 0;
  for (const mem of [new Memory(dir), new Memory(sharedDir())]) {
    const todo = mem.unembedded(prov.model);
    if (!todo.length) continue;
    const e = await embeddings.embed(prov, todo.map((m) => m.content));
    todo.forEach((m, i) => mem.attachEmbedding(m.id, e.vectors[i], e.model));
    reindexed += todo.length;
    cost += e.cost_micros;
  }
  return { reindexed, model: prov.model, cost_micros: cost };
}

// Sync shared knowledge through the cloud so it spans MACHINES, not just repos on one box.
// Push: every shared fact goes up tagged `shared`. Pull: shared-tagged facts from every
// workspace in the org come back down. Keyed upsert means re-syncing converges instead of
// duplicating, and a fact that changed elsewhere lands as `contested` — not silently.
async function syncShared(project, cloud) {
  const link = cloud.cloudLink(project);
  if (!link) return { error: "not linked — run `foundry login` then `foundry push`" };
  const shared = new Memory(sharedDir());
  let pushed = 0, pulled = 0, contested = 0;

  for (const m of shared.list()) {
    const r = await cloud.mirrorMemory(link, {
      key: m.key, content: m.content, agent: m.updated_by || m.creator_agent,
      tags: [...new Set([...(m.tags || []), "shared"])],
    });
    if (r && r.synced) pushed++;
  }

  for (const remote of await cloud.orgMemory(link)) {
    if (!(remote.tags || []).includes("shared") || !remote.key) continue;
    const mine = shared.get(remote.key);
    if (mine && mine.content === remote.content) continue; // already converged
    const r = shared.set({
      key: remote.key, content: remote.content, agent: remote.creator_agent || remote.updated_by || "cloud",
      tags: remote.tags,
    });
    pulled++;
    if (r.conflict) contested++;
  }
  return { pushed, pulled, contested, workspace: link.wsId };
}

module.exports = { Memory, runMemoryTool, reindex, syncShared, sharedDir, MEMORY_TOOLS };
