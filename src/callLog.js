// Úplný záznam volání modelů: každý dotaz, který OpenCode pošle modelu (přes proxy závodu, src/race.js), celý –
// systémový prompt, všechny zprávy, definice nástrojů, parametry – a celá odpověď (text, uvažování, volání nástrojů,
// důvod konce, tokeny), časy (první odpověď, celkem, tokeny/s) a průběh závodu (kdo běžel, kdo vypadl a proč,
// co stihli poražení napsat). Uživatel 20. 11.: „chci aby šlo logovat 100 % jejich dělání … kvůli debuggingu appky“.
//
// Soubory v <userData>/logs/calls/: YYYY-MM-DD.jsonl (řádek = jedno volání, zprávy jen jako otisky),
// YYYY-MM-DD.msgs.jsonl ({ h, m } – každá zpráva jednou za den), YYYY-MM-DD.tools.jsonl ({ h, tools }).
// Proč otisky: každý krok agenta posílá znovu celou konverzaci (50–90k tokenů); bez nich by den práce měl gigabajty,
// takhle se uloží jen nové zprávy. Klíče se maskují stejně jako v úplném logu (KEY_RES + uložené klíče).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KEY_RES, day } = require('./fullLog');

const hash = (v) => crypto.createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `… (+${s.length - n} znaků)` : s);

/** Data z SSE / JSON odpovědi chat/completions → { text, reasoning, toolCalls, finish, usage, model, error, chunks }. */
function assemble(objs) {
  const out = { text: '', reasoning: '', toolCalls: [], finish: null, usage: null, model: null, error: null, chunks: 0 };
  const tc = new Map();
  for (const j of objs || []) {
    if (!j || j.done) continue;
    out.chunks++;
    if (j.error) { out.error = j.error; continue; }
    if (j.model) out.model = j.model;
    if (j.usage) out.usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) continue;
    const d = ch.delta || ch.message || {};
    if (typeof d.content === 'string') out.text += d.content;
    for (const k of ['reasoning_content', 'reasoning']) if (typeof d[k] === 'string') out.reasoning += d[k];
    for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const i = t.index ?? tc.size;
      const cur = tc.get(i) || { id: '', name: '', arguments: '' };
      if (t.id) cur.id = t.id;
      if (t.function?.name && !cur.name) cur.name = t.function.name;
      if (typeof t.function?.arguments === 'string') cur.arguments += t.function.arguments;
      tc.set(i, cur);
    }
    if (ch.finish_reason) out.finish = ch.finish_reason;
  }
  out.toolCalls = [...tc.values()];
  return out;
}

/** Výstupní tokeny a tokeny/s z odpovědi (usage, jinak odhad ~4 znaky na token). */
function speed(resp, genMs) {
  const out = resp?.usage?.completion_tokens ?? Math.round(((resp?.text || '').length + (resp?.reasoning || '').length + JSON.stringify(resp?.toolCalls || []).length) / 4);
  return { outTokens: out, tokPerS: genMs > 200 && out ? Math.round((out / genMs) * 10000) / 10 : null, estimated: resp?.usage?.completion_tokens == null };
}

class CallLog {
  /**
   * @param {{dir: string, secrets?: () => string[], retentionDays?: number, maxDayBytes?: number, keep?: number}} o
   */
  constructor(o) {
    this.dir = o.dir;
    this.secrets = o.secrets || (() => []);
    this.retentionDays = o.retentionDays ?? 7;
    this.maxDayBytes = o.maxDayBytes ?? 2 * 1024 ** 3;
    this.keep = o.keep ?? 300;
    this.recent = []; // souhrny posledních volání (monitor), nejnovější na konci
    this.day = null;
    this.seenMsg = new Set();
    this.seenTools = new Set();
    this.bytes = 0;
    this.secretRe = null; this.secretAt = 0;
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
    this.loadRecent();
  }

  mask(s) {
    for (const re of KEY_RES) s = s.replace(re, (m) => m.slice(0, 6) + '***');
    if (Date.now() - this.secretAt > 60000) {
      this.secretAt = Date.now();
      const list = (this.secrets() || []).filter((x) => typeof x === 'string' && x.length >= 8);
      this.secretRe = list.length ? new RegExp(list.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
    }
    return this.secretRe ? s.replace(this.secretRe, '***klíč***') : s;
  }

  files(d) { return { calls: path.join(this.dir, d + '.jsonl'), msgs: path.join(this.dir, d + '.msgs.jsonl'), tools: path.join(this.dir, d + '.tools.jsonl') }; }

  prune() {
    try {
      const cutoff = day(Date.now() - this.retentionDays * 86400000);
      for (const f of fs.readdirSync(this.dir)) if (/^\d{4}-\d{2}-\d{2}\./.test(f) && f.slice(0, 10) < cutoff) fs.rmSync(path.join(this.dir, f), { force: true });
    } catch {}
  }

  /** Nový den (nebo první zápis): otisky už zapsaných zpráv z dnešních souborů, ať se po restartu neukládají znovu. */
  openDay(d) {
    if (this.day === d) return;
    this.day = d; this.seenMsg = new Set(); this.seenTools = new Set(); this.bytes = 0;
    const f = this.files(d);
    for (const [file, set] of [[f.msgs, this.seenMsg], [f.tools, this.seenTools]]) {
      try {
        const txt = fs.readFileSync(file, 'utf8');
        this.bytes += txt.length;
        for (const m of txt.matchAll(/^\{"h":"([0-9a-f]{16})"/gm)) set.add(m[1]);
      } catch {}
    }
    try { this.bytes += fs.statSync(f.calls).size; } catch {}
    this.prune();
  }

  append(file, obj) {
    const line = this.mask(JSON.stringify(obj)) + '\n';
    fs.appendFileSync(file, line);
    this.bytes += line.length;
  }

  /** Souhrn volání pro monitor (bez zpráv a celé odpovědi). */
  static summary(rec) {
    const r = rec.response || {};
    const genMs = rec.totalMs != null && rec.ttftMs != null ? rec.totalMs - rec.ttftMs : null;
    const sp = speed(r, genMs);
    return {
      id: rec.id, t: rec.t, kind: rec.kind, combo: rec.combo,
      model: rec.race?.winner || rec.upstream?.model || r.model || rec.combo,
      ttftMs: rec.ttftMs ?? null, totalMs: rec.totalMs ?? null, outTokens: sp.outTokens, tokPerS: sp.tokPerS,
      // první odpověď vítěze od JEHO startu (náhradník mohl nastoupit až po vypadlých) – pro tabulku modelů
      modelTtftMs: (() => { const w = (rec.runners || []).find((x) => x.won); return w && w.ttftMs != null ? w.ttftMs - (w.startMs || 0) : rec.ttftMs ?? null; })(),
      inTokens: r.usage?.prompt_tokens ?? null, finish: r.finish || null,
      tools: (r.toolCalls || []).map((x) => x.name),
      error: rec.error || (r.error ? (r.error.message || JSON.stringify(r.error)).slice(0, 300) : null),
      status: rec.upstream?.status ?? null,
      race: rec.race ? { n: rec.race.tried?.length || 0, winner: rec.race.winner || null, rank: rec.race.rank ?? null, fallback: !!rec.race.fallback, stalled: !!rec.race.stalled,
        failed: (rec.runners || []).filter((x) => x.why).map((x) => ({ model: x.model, why: String(x.why).slice(0, 160) })) } : null,
      msgs: Array.isArray(rec.messages) ? rec.messages.length : 0,
    };
  }

  /** Zapíše jedno hotové volání (záznam z src/race.js). Nikdy nehodí chybu. */
  record(rec) {
    try {
      const t = rec.t || Date.now();
      const d = day(t);
      this.openDay(d);
      const f = this.files(d);
      const capped = this.bytes > this.maxDayBytes;
      const msgs = Array.isArray(rec.messages) ? rec.messages : [];
      const hs = msgs.map((m) => hash(m));
      if (!capped) msgs.forEach((m, i) => { if (!this.seenMsg.has(hs[i])) { this.seenMsg.add(hs[i]); this.append(f.msgs, { h: hs[i], m }); } });
      let th = null;
      if (Array.isArray(rec.tools) && rec.tools.length) {
        th = hash(rec.tools);
        if (!capped && !this.seenTools.has(th)) { this.seenTools.add(th); this.append(f.tools, { h: th, tools: rec.tools }); }
      }
      const { messages, tools, ...rest } = rec;
      const line = { ...rest, t: new Date(t).toISOString(), msgs: hs, tools: th, toolCount: Array.isArray(tools) ? tools.length : 0, ...(capped ? { capped: true } : {}) };
      if (capped) { // nad denním limitem jen metadata, bez textů
        if (line.response) line.response = { ...line.response, text: clip(line.response.text, 500), reasoning: clip(line.response.reasoning, 500) };
      }
      this.append(f.calls, line);
      this.recent.push(CallLog.summary({ ...rec, t }));
      if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    } catch {}
  }

  /** Souhrny z konce dnešního souboru (po restartu appky má monitor hned historii). */
  loadRecent() {
    try {
      const f = this.files(day()).calls;
      const st = fs.statSync(f);
      const len = Math.min(st.size, 8 * 1024 * 1024);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').slice(len < st.size ? 1 : 0).filter(Boolean);
      for (const l of lines.slice(-this.keep)) { try { const r = JSON.parse(l); this.recent.push(CallLog.summary({ ...r, t: Date.parse(r.t), messages: r.msgs })); } catch {} }
    } catch {}
  }

  /** Celé volání podle id: řádek + zprávy a nástroje složené z otisků. null = nenalezeno. */
  read(id) {
    let days = [];
    try { days = [...new Set(fs.readdirSync(this.dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).map((x) => x.slice(0, 10)))].sort().reverse(); } catch {}
    for (const d of days) {
      const f = this.files(d);
      let line = null;
      try {
        const txt = fs.readFileSync(f.calls, 'utf8');
        const i = txt.indexOf(`{"id":${JSON.stringify(id)},`);
        if (i < 0) continue;
        const e = txt.indexOf('\n', i);
        line = JSON.parse(txt.slice(i, e < 0 ? undefined : e));
      } catch { continue; }
      const want = new Set(line.msgs || []);
      const got = new Map();
      try { for (const l of fs.readFileSync(f.msgs, 'utf8').split('\n')) { if (!l) continue; const h = l.slice(6, 22); if (want.has(h)) { try { got.set(h, JSON.parse(l).m); } catch {} } } } catch {}
      let tools = null;
      if (line.tools) try { for (const l of fs.readFileSync(f.tools, 'utf8').split('\n')) if (l.startsWith(`{"h":"${line.tools}"`)) { tools = JSON.parse(l).tools; break; } } catch {}
      return { ...line, messages: (line.msgs || []).map((h) => (got.has(h) ? got.get(h) : { role: '?', content: `(zpráva ${h} nenalezena – den nad limitem nebo smazaný soubor)` })), toolDefs: tools };
    }
    return null;
  }

  /** Velikost dnešních souborů v bajtech. */
  todayBytes() {
    let n = 0;
    const f = this.files(day());
    for (const x of Object.values(f)) { try { n += fs.statSync(x).size; } catch {} }
    return n;
  }
}

module.exports = { CallLog, assemble, speed, hash };
