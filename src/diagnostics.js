// Diagnostika Zdarmy: záznam každého požadavku proxy, statistiky modelů, rozbor konverzací OpenCode
// (kroky, tokeny, chyby nástrojů, smyčky, kompakce), konce logů a velikosti dat. Používá ji stránka
// Nastavení → Diagnostika a export (tlačítko „Uložit diagnostiku“).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TRACE_BYTES = 8 * 1024 * 1024;

/** Zapisovač záznamu požadavků (JSONL, při 8 MB se starý přejmenuje na .1). */
function traceWriter(dir) {
  const file = path.join(dir, 'requests.jsonl');
  return (rec) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > MAX_TRACE_BYTES) fs.renameSync(file, file + '.1'); } catch {}
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch {}
  };
}

/** Posledních `limit` záznamů (nejnovější na konci). Čte jen konec souboru. */
function readTrace(dir, limit = 300) {
  const file = path.join(dir, 'requests.jsonl');
  let text = '';
  try {
    const st = fs.statSync(file);
    const want = Math.min(st.size, 2 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, st.size - want);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return []; }
  const lines = text.split('\n').filter(Boolean);
  if (text.length >= 2 * 1024 * 1024) lines.shift(); // první řádek může být useknutý
  const out = [];
  for (const l of lines.slice(-limit)) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };

/** Statistiky po modelech ze záznamu (za `windowMs`). */
function modelStats(records, now = Date.now(), windowMs = 24 * 3600 * 1000) {
  const per = new Map();
  for (const r of records) {
    if (now - (r.at || 0) > windowMs) continue;
    const okAttempt = (r.attempts || []).find((a) => a.ok);
    const key = r.model || okAttempt?.model || r.combo || r.requested || '?';
    const s = per.get(key) || { model: key, requests: 0, ok: 0, failed: 0, ms: [], tokIn: 0, tokOut: 0, tools: 0, badArgs: 0, fixedArgs: 0, errors: {}, tiers: {} };
    s.requests++;
    if (r.ok) { s.ok++; s.ms.push(r.ms || 0); } else { s.failed++; const e = String(r.error || 'chyba').slice(0, 80); s.errors[e] = (s.errors[e] || 0) + 1; }
    for (const a of r.attempts || []) {
      if (!a.ok) continue;
      s.tokIn += a.inTok || 0; s.tokOut += a.outTok || 0; s.tools += a.toolCalls || 0; s.badArgs += a.badArgs || 0; s.fixedArgs += a.fixedArgs || 0;
    }
    if (r.requested) s.tiers[r.requested] = (s.tiers[r.requested] || 0) + 1;
    per.set(key, s);
  }
  return [...per.values()].map((s) => ({ ...s, medianMs: median(s.ms), ms: undefined })).sort((a, b) => b.requests - a.requests);
}

/** Konec textového souboru (posledních n řádků). */
function tailFile(file, n = 120, maxBytes = 256 * 1024) {
  try {
    const st = fs.statSync(file);
    const want = Math.min(st.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, st.size - want);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n);
  } catch { return []; }
}

/** Chyby a varování z logu OmniRoute (JSON řádky pino: level ≥ 40), bez obsahu požadavků. */
function omniErrors(file, n = 60) {
  const out = [];
  for (const l of tailFile(file, 2000, 1024 * 1024)) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if ((o.level || 0) < 40) continue;
    if (/checkpoint|Evict(ing|ed) idle limiter/i.test(String(o.msg || ''))) continue; // úklid databáze a limiterů, ne chyba
    out.push({ at: o.time || o.timestamp || null, level: o.level >= 50 ? 'error' : 'warn', tag: o.tag || o.component || o.module || '', msg: String(o.msg || o.message || '').slice(0, 300), status: o.status || null });
  }
  return out.slice(-n);
}

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let s = 0;
    for (const f of fs.readdirSync(p)) s += sizeOf(path.join(p, f));
    return s;
  } catch { return 0; }
}

/** Kde má OpenCode data (opencode.db). */
function opencodeDbPath() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}
const J = (s) => { try { return JSON.parse(s); } catch { return {}; } };

/** Přehled konverzací OpenCode (nejnovější nahoře). */
function sessions(dbFile = opencodeDbPath(), limit = 50) {
  if (!fs.existsSync(dbFile)) return { error: 'opencode.db nenalezena', list: [] };
  let db;
  try {
    db = openDb(dbFile);
    const rows = db.prepare('select id, title, directory, parent_id, time_created, time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, model from session order by time_updated desc limit ?').all(limit);
    const cnt = db.prepare("select count(*) n, sum(case when json_extract(data,'$.role')='user' then 1 else 0 end) u, sum(case when json_extract(data,'$.error') is not null then 1 else 0 end) e from message where session_id=?");
    const tools = db.prepare("select count(*) n, sum(case when json_extract(data,'$.state.status')='error' then 1 else 0 end) e from part where session_id=? and json_extract(data,'$.type')='tool'");
    const comp = db.prepare("select count(*) n from part where session_id=? and json_extract(data,'$.type')='compaction'");
    const list = rows.map((s) => {
      const c = cnt.get(s.id); const t = tools.get(s.id);
      return {
        id: s.id, title: s.title, directory: s.directory, parent: s.parent_id, created: s.time_created, updated: s.time_updated,
        model: J(s.model)?.id || '', tokensIn: s.tokens_input, tokensOut: s.tokens_output, cacheRead: s.tokens_cache_read,
        messages: c.n, userMessages: c.u, errors: c.e, toolCalls: t.n, toolErrors: t.e, compactions: comp.get(s.id).n,
      };
    });
    return { file: dbFile, list };
  } catch (e) { return { error: e.message, list: [] }; } finally { try { db?.close(); } catch {} }
}

/**
 * Součty pro panel Kontext: relace, projekt (složka), všechno a dnešek – volání modelu (= odpovědi asistenta)
 * a tokeny. Z databáze OpenCode (jen čtení); dotazy trvají jednotky ms i na 600 MB databázi.
 * Složka je v databázi s lomítky („C:/Users/x“), v API se zpětnými → porovnává se normalizovaně.
 */
function usageTotals({ sessionId, dir, dbFile = opencodeDbPath(), now = Date.now() } = {}) {
  if (!fs.existsSync(dbFile)) return { error: 'opencode.db nenalezena' };
  const norm = (d) => String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const tok = (r) => {
    const t = { input: r?.i || 0, output: r?.o || 0, reasoning: r?.r || 0, cacheRead: r?.c || 0, cacheWrite: r?.w || 0 };
    t.total = t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
    return t;
  };
  let db;
  try {
    db = openDb(dbFile);
    const SUM = 'sum(tokens_input) i, sum(tokens_output) o, sum(tokens_reasoning) r, sum(tokens_cache_read) c, sum(tokens_cache_write) w, sum(cost) cost';
    const calls = db.prepare("select count(*) n from message where session_id=? and json_extract(data,'$.role')='assistant'");
    const out = {};
    if (sessionId) {
      const s = db.prepare(`select title, directory, time_created, ${SUM} from session where id=?`).get(sessionId);
      if (s) {
        const u = db.prepare("select count(*) n from message where session_id=? and json_extract(data,'$.role')='user'").get(sessionId).n;
        out.session = { id: sessionId, title: s.title, since: s.time_created, calls: calls.get(sessionId).n, userMessages: u, tokens: tok(s), cost: s.cost || 0 };
      }
    }
    const all = db.prepare(`select id, directory, time_created from session where parent_id is null or parent_id=''`).all();
    if (dir) {
      const d = norm(dir);
      const ids = all.filter((s) => norm(s.directory) === d).map((s) => s.id);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const t = db.prepare(`select ${SUM}, min(time_created) since from session where id in (${ph}) or parent_id in (${ph})`).get(...ids, ...ids);
        const n = db.prepare(`select count(*) n from message where json_extract(data,'$.role')='assistant' and session_id in (select id from session where id in (${ph}) or parent_id in (${ph}))`).get(...ids, ...ids).n;
        out.project = { dir, sessions: ids.length, since: t.since, calls: n, tokens: tok(t) };
      }
    }
    const ta = db.prepare(`select ${SUM} from session`).get();
    out.all = {
      sessions: all.length,
      projects: new Set(all.map((s) => norm(s.directory))).size,
      calls: db.prepare("select count(*) n from message where json_extract(data,'$.role')='assistant'").get().n,
      tokens: tok(ta),
    };
    const mid = new Date(now); mid.setHours(0, 0, 0, 0);
    const td = db.prepare("select count(*) n, sum(json_extract(data,'$.tokens.input')) i, sum(json_extract(data,'$.tokens.output')) o, sum(json_extract(data,'$.tokens.reasoning')) r, sum(json_extract(data,'$.tokens.cache.read')) c, sum(json_extract(data,'$.tokens.cache.write')) w from message where time_created>=? and json_extract(data,'$.role')='assistant'").get(mid.getTime());
    out.today = { calls: td.n, tokens: tok(td) };
    return out;
  } catch (e) { return { error: e.message }; } finally { try { db?.close(); } catch {} }
}

/** Rozbor jedné konverzace: časová osa kroků, nástroje, chyby, smyčky. */
function sessionDetail(id, dbFile = opencodeDbPath()) {
  let db;
  try {
    db = openDb(dbFile);
    const s = db.prepare('select * from session where id=?').get(id);
    if (!s) return { error: 'konverzace nenalezena' };
    const msgs = db.prepare('select id, time_created, data from message where session_id=? order by time_created').all(id);
    const parts = db.prepare('select message_id, data from part where session_id=? order by time_created').all(id).map((p) => ({ mid: p.message_id, d: J(p.data) }));
    const byMsg = new Map();
    for (const p of parts) { if (!byMsg.has(p.mid)) byMsg.set(p.mid, []); byMsg.get(p.mid).push(p.d); }
    const steps = [];
    const toolCount = {}; const toolErr = {}; const errSamples = {}; const sig = {}; const models = {}; const errors = {};
    for (const m of msgs) {
      const d = J(m.data);
      const ps = byMsg.get(m.id) || [];
      if (d.role === 'user') {
        steps.push({ at: m.time_created, kind: 'user', text: ps.filter((x) => x.type === 'text').map((x) => x.text).join(' ').replace(/\s+/g, ' ').slice(0, 300) });
        continue;
      }
      const k = `${d.providerID}/${d.modelID}`;
      models[k] = (models[k] || 0) + 1;
      if (d.error) { const e = `${d.error.name}: ${String(d.error.data?.message || '').slice(0, 160)}`; errors[e] = (errors[e] || 0) + 1; }
      const tools = [];
      for (const p of ps) {
        if (p.type !== 'tool') continue;
        toolCount[p.tool] = (toolCount[p.tool] || 0) + 1;
        const bad = p.state?.status === 'error';
        if (bad) { toolErr[p.tool] = (toolErr[p.tool] || 0) + 1; const e = `${p.tool}: ${String(p.state?.error || '').split('\n')[0].slice(0, 160)}`; errSamples[e] = (errSamples[e] || 0) + 1; }
        const input = JSON.stringify(p.state?.input || {});
        const key = `${p.tool} ${input.slice(0, 220)}`;
        sig[key] = (sig[key] || 0) + 1;
        tools.push({ tool: p.tool, error: bad ? String(p.state?.error || '').split('\n')[0].slice(0, 200) : null, input: input.slice(0, 200) });
      }
      steps.push({
        at: m.time_created, kind: 'assistant', model: k, ms: d.time?.completed ? d.time.completed - d.time.created : null,
        tokIn: d.tokens?.input || 0, cache: d.tokens?.cache?.read || 0, tokOut: d.tokens?.output || 0, reasoning: d.tokens?.reasoning || 0,
        finish: d.finish || null, error: d.error ? `${d.error.name}: ${String(d.error.data?.message || '').slice(0, 200)}` : null,
        compaction: ps.some((x) => x.type === 'compaction'), summary: !!d.summary,
        text: ps.filter((x) => x.type === 'text').map((x) => x.text).join(' ').replace(/\s+/g, ' ').slice(0, 240),
        thinking: ps.filter((x) => x.type === 'reasoning').reduce((n, x) => n + (x.text || '').length, 0),
        tools,
      });
    }
    const loops = Object.entries(sig).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => ({ count: n, call: k }));
    const durations = steps.filter((x) => x.kind === 'assistant' && x.ms != null).map((x) => x.ms);
    return {
      id, title: s.title, directory: s.directory,
      summary: {
        steps: steps.filter((x) => x.kind === 'assistant').length, userMessages: steps.filter((x) => x.kind === 'user').length,
        tokensIn: s.tokens_input, tokensOut: s.tokens_output, cacheRead: s.tokens_cache_read, medianStepMs: median(durations),
        compactions: parts.filter((p) => p.d.type === 'compaction').length, models, errors, toolCount, toolErr,
        toolErrorSamples: Object.entries(errSamples).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([e, n]) => ({ count: n, error: e })),
        loops,
      },
      steps: steps.slice(-400),
    };
  } catch (e) { return { error: e.message }; } finally { try { db?.close(); } catch {} }
}

/** Upozornění odvozená z dat (co je špatně a co s tím). */
function findings({ stats = [], detail = null, sessionsList = [], sizes = {}, health = {} }) {
  const out = [];
  for (const s of stats) {
    if (s.requests >= 3 && s.failed / s.requests >= 0.5) out.push({ level: 'bad', key: 'diag.fModelFails', vars: { model: s.model, n: s.failed, total: s.requests } });
    if (s.medianMs != null && s.medianMs > 40000) out.push({ level: 'warn', key: 'diag.fModelSlow', vars: { model: s.model, s: Math.round(s.medianMs / 1000) } });
    if (s.fixedArgs > 0) out.push({ level: 'info', key: 'diag.fFixedArgs', vars: { model: s.model, n: s.fixedArgs } });
  }
  for (const se of sessionsList.slice(0, 5)) {
    if ((se.tokensIn || 0) > 2e6) out.push({ level: 'warn', key: 'diag.fHugeSession', vars: { title: se.title, n: Math.round(se.tokensIn / 1e6 * 10) / 10 } });
    if (se.directory && /[\\/]Claude code$/i.test(se.directory)) out.push({ level: 'warn', key: 'diag.fParentDir', vars: { title: se.title, dir: se.directory } });
  }
  if (detail?.summary?.loops?.length) out.push({ level: 'warn', key: 'diag.fLoops', vars: { n: detail.summary.loops.length, top: detail.summary.loops[0].count } });
  if ((sizes.opencodeDb || 0) > 300 * 1024 * 1024) out.push({ level: 'info', key: 'diag.fBigDb', vars: { mb: Math.round(sizes.opencodeDb / 1048576) } });
  if (health.proxy && !health.proxy.running) out.push({ level: 'bad', key: 'diag.fProxyDown', vars: {} });
  if (health.omniroute && health.omniroute.enabled && !health.omniroute.ready) out.push({ level: 'warn', key: 'diag.fOmniDown', vars: { err: health.omniroute.error || '' } });
  return out;
}

// ------------------------------------------------------------ živý záznam a plné zachycení (pro rozbor zvenku)

/** Zapisovač JSONL s rotací (soubor → soubor.1 při překročení maxBytes). */
function jsonlWriter(file, maxBytes) {
  return (rec) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.1'); } catch {}
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');
    } catch {}
  };
}
/** Posledních n záznamů JSONL souboru. */
function readJsonl(file, n = 100, maxBytes = 4 * 1024 * 1024) {
  const out = [];
  for (const l of tailFile(file, n, maxBytes)) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
const cut = (s, n) => { const x = typeof s === 'string' ? s : JSON.stringify(s ?? ''); return x.length > n ? x.slice(0, n) + `…(+${x.length - n})` : x; };

/**
 * Události OpenCode (/global/event) → stručný živý záznam: kroky agenta, volání nástrojů s výsledkem
 * a chybou, stav relace (busy/idle/retry), chyby, kompakce, zprávy uživatele.
 */
function opencodeEventSummarizer(write) {
  const roles = new Map(); // id zprávy → role
  const doneParts = new Set(); // díly, které už se zapsaly (konečný stav)
  return (ev) => {
    const p = ev?.payload;
    if (!p?.type) return;
    const pr = p.properties || {};
    const dir = ev.directory && ev.directory !== 'global' ? ev.directory : undefined;
    switch (p.type) {
      case 'session.status': {
        const st = pr.status || {};
        write({ src: 'oc', kind: 'status', session: pr.sessionID, status: st.type, attempt: st.attempt, message: st.message ? cut(st.message, 300) : undefined, dir });
        break;
      }
      case 'session.error':
        write({ src: 'oc', kind: 'session-error', session: pr.sessionID, error: cut(pr.error, 600), dir });
        break;
      case 'session.compacted':
        write({ src: 'oc', kind: 'compacted', session: pr.sessionID, dir });
        break;
      case 'message.updated': {
        const m = pr.info || {};
        if (m.id && m.role) roles.set(m.id, m.role);
        if (m.role === 'assistant' && (m.time?.completed || m.error)) {
          const key = 'm' + m.id;
          if (doneParts.has(key)) break;
          doneParts.add(key);
          write({ src: 'oc', kind: 'step', session: m.sessionID, model: `${m.providerID}/${m.modelID}`, ms: m.time?.completed ? m.time.completed - m.time.created : null, tokIn: m.tokens?.input, cache: m.tokens?.cache?.read, tokOut: m.tokens?.output, reasoning: m.tokens?.reasoning, finish: m.finish, error: m.error ? cut(m.error, 600) : undefined, summary: m.summary || undefined, dir });
        }
        break;
      }
      case 'message.part.updated': {
        const part = pr.part || {};
        if (part.type === 'tool') {
          const s = part.state || {};
          if (s.status !== 'completed' && s.status !== 'error') break;
          if (doneParts.has(part.id)) break;
          doneParts.add(part.id);
          write({ src: 'oc', kind: 'tool', session: part.sessionID, tool: part.tool, status: s.status, input: cut(s.input, 600), output: s.status === 'completed' ? cut(s.output, 800) : undefined, error: s.error ? cut(s.error, 800) : undefined, ms: s.time?.end && s.time?.start ? s.time.end - s.time.start : undefined, dir });
        } else if (part.type === 'text' && roles.get(part.messageID) === 'user' && !doneParts.has(part.id)) {
          doneParts.add(part.id);
          write({ src: 'oc', kind: 'user', session: part.sessionID, text: cut(part.text, 1500), dir });
        } else if (part.type === 'text' && roles.get(part.messageID) === 'assistant' && part.time?.end && !doneParts.has(part.id)) {
          doneParts.add(part.id);
          write({ src: 'oc', kind: 'say', session: part.sessionID, text: cut(part.text, 1500), dir });
        } else if (part.type === 'compaction' && !doneParts.has(part.id)) {
          doneParts.add(part.id);
          write({ src: 'oc', kind: 'compaction', session: part.sessionID, dir });
        }
        break;
      }
      case 'permission.updated': case 'permission.asked':
        write({ src: 'oc', kind: 'permission', session: pr.sessionID, info: cut(pr, 400), dir });
        break;
      default: break;
    }
    if (doneParts.size > 20000) doneParts.clear();
  };
}

module.exports = { jsonlWriter, readJsonl, opencodeEventSummarizer, cut, traceWriter, readTrace, modelStats, tailFile, omniErrors, sizeOf, opencodeDbPath, sessions, sessionDetail, usageTotals, findings, median };
