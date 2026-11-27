// Úplný log czek-ai: všechno, co se v appce děje, bez zkracování (uživatel 14. 11.: „logovala doslova všechno,
// všechny akce, myšlení modelu, omniroute věci, errory, fails, důvody proč, podrobný popis všeho bez ztráty
// jediné informace“). Jeden soubor na den: <userData>/logs/YYYY-MM-DD.jsonl, jeden řádek = jeden záznam
// { t, src, kind, msg, data }: msg = čitelný popis česky, data = úplná surová data (nic se neořezává).
// Jediná výjimka: hodnoty, které vypadají jako API klíč (a klíče uložené v appce), se zamaskují – log se
// může dostat do diagnostiky nebo k učiteli a klíče nesmí ven nikdy.
// Zdroje: události OpenCode (zprávy, myšlení modelu, nástroje s celým vstupem/výstupem, kroky s tokeny,
// stav relace, chyby), výstup serveru OpenCode, log procesu OmniRoute + jeho záznamy volání (který model,
// stav, chyba, záloha), rozhodnutí czek-guard, akce v appce (IPC), konzole oken, pády.
'use strict';
const fs = require('fs');
const path = require('path');

const KEY_RES = [
  /sk-or-v1-[A-Za-z0-9]{20,}/g, /sk-ant-[A-Za-z0-9_-]{20,}/g, /sk-[A-Za-z0-9_-]{20,}/g, /nvapi-[A-Za-z0-9_-]{20,}/g,
  /gsk_[A-Za-z0-9]{20,}/g, /AIza[A-Za-z0-9_-]{30,}/g, /hf_[A-Za-z0-9]{20,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g, /xai-[A-Za-z0-9]{20,}/g, /csk-[A-Za-z0-9]{20,}/g,
  // přihlašovací údaje v URL (ftp://uživatel:heslo@…) → „ftp://***“ (27. 11. heslo k FTP z příkazu agenta)
  /[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:[^\s@/"'<>]+@/gi,
];

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Šum v konzoli okna: první výskyt se zapíše, další se jen počítají do souhrnu 'event-repeats'.
const CONSOLE_NOISE = {
  'ResizeObserver loop': /ResizeObserver loop completed with undelivered notifications/,
  'powerPreference ignored': /powerPreference option is currently ignored/,
};
const consoleSeen = new Set();
const consoleCount = new Map(); // klíč → počet potlačených opakování od posledního souhrnu
/** 'first' = zapiš; 'repeat' = jen počítej (nezapisuj); null = není šum. Funguje i bez zapnutého FullLog. */
function collapseConsole(message) {
  const s = String(message ?? '');
  for (const [k, re] of Object.entries(CONSOLE_NOISE)) {
    if (!re.test(s)) continue;
    if (!consoleSeen.has(k)) { consoleSeen.add(k); return 'first'; }
    consoleCount.set(k, (consoleCount.get(k) || 0) + 1);
    return 'repeat';
  }
  return null;
}

const REPEAT_EVERY_MS = 5 * 60 * 1000;

class FullLog {
  /**
   * @param {{dir: string, secrets?: () => string[], retentionDays?: number}} o
   */
  constructor(o) {
    this.dir = o.dir;
    this.secrets = o.secrets || (() => []);
    this.retentionDays = o.retentionDays ?? 30;
    this.parts = new Map(); // id dílu → poslední zapsaný stav (aby se konečný stav zapsal jednou)
    this.msgs = new Map(); // id zprávy → { role, model, done }
    this.tails = [];
    this.secretRe = null;
    this.secretAt = 0;
    this.pluginsSeen = new Set(); // dir|id pluginu, který už je v logu
    this.rep = new Map(); // typ události → { n, dirs? } od posledního souhrnu
    this.repSince = Date.now();
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
    this.repTimer = setInterval(() => this.flushRepeats(), REPEAT_EVERY_MS);
    this.repTimer.unref?.();
  }

  /** Počítá událost místo zápisu řádku. sub = volitelný rozpad (např. adresář u 'sync'). */
  count(key, sub) {
    const e = this.rep.get(key) || { n: 0 };
    e.n++;
    if (sub !== undefined) { e.sub = e.sub || {}; e.sub[sub] = (e.sub[sub] || 0) + 1; }
    this.rep.set(key, e);
  }

  /** Zapíše jeden souhrnný řádek kind 'event-repeats' (jen když je co psát) a vynuluje počty. */
  flushRepeats() {
    const now = Date.now();
    const counts = {};
    const detail = {};
    for (const [k, e] of this.rep) { counts[k] = e.n; if (e.sub) detail[k] = e.sub; }
    for (const [k, n] of consoleCount) counts['konzole: ' + k] = n;
    this.rep.clear();
    consoleCount.clear();
    if (!Object.keys(counts).length) { this.repSince = now; return; }
    const parts = Object.entries(counts).map(([k, n]) => `${k} ${n}×`).join(', ');
    this.write('app', 'event-repeats', `Za ${Math.round((now - this.repSince) / 1000)} s nezapsáno jednotlivě (jen počty): ${parts}`,
      { od: new Date(this.repSince).toISOString(), do: new Date(now).toISOString(), counts, detail: Object.keys(detail).length ? detail : undefined });
    this.repSince = now;
  }

  prune() {
    try {
      const cutoff = day(Date.now() - this.retentionDays * 86400000);
      for (const f of fs.readdirSync(this.dir)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) fs.rmSync(path.join(this.dir, f), { force: true });
    } catch {}
  }

  mask(text) {
    let s = text;
    for (const re of KEY_RES) s = s.replace(re, (m) => m.slice(0, 6) + '***');
    if (Date.now() - this.secretAt > 60000) {
      this.secretAt = Date.now();
      const list = (this.secrets() || []).filter((x) => typeof x === 'string' && x.length >= 8);
      this.secretRe = list.length ? new RegExp(list.map(esc).join('|'), 'g') : null;
    }
    if (this.secretRe) s = s.replace(this.secretRe, '***klíč***');
    return s;
  }

  file(t = Date.now()) { return path.join(this.dir, day(t) + '.jsonl'); }

  write(src, kind, msg, data) {
    try {
      const t = Date.now();
      const rec = { t: new Date(t).toISOString(), src, kind, msg: msg == null ? '' : String(msg) };
      if (data !== undefined) rec.data = data;
      let line;
      try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ ...rec, data: String(data) }); }
      fs.appendFileSync(this.file(t), this.mask(line) + '\n');
    } catch {}
  }

  /** Událost z /global/event OpenCode ({ directory, payload: { type, properties } }). */
  ocEvent(ev) {
    const p = ev?.payload;
    if (!p?.type) return;
    const pr = p.properties || {};
    const dir = ev.directory && ev.directory !== 'global' ? ev.directory : undefined;
    const w = (kind, msg, data) => this.write('opencode', kind, msg, dir ? { dir, ...data } : data);
    switch (p.type) {
      case 'message.part.delta':
        return; // průběžné kousky textu – celý text se zapíše v konečném stavu dílu
      case 'server.heartbeat':
        this.count('server.heartbeat'); // každých 10 s, data {} – jen počet
        return;
      case 'sync':
        this.count('sync', dir || 'global'); // data jen { dir }, stejný adresář je i v ostatních událostech
        return;
      case 'session.diff':
        if (!Array.isArray(pr.diff) || !pr.diff.length) { this.count('session.diff prázdný'); return; }
        w('event', `Událost OpenCode: ${p.type}`, pr);
        return;
      case 'plugin.added': {
        const key = `${dir || ''}|${pr.id}`;
        if (this.pluginsSeen.has(key)) { this.count('plugin.added opakovaně'); return; }
        this.pluginsSeen.add(key);
        if (this.pluginsSeen.size > 5000) this.pluginsSeen.delete(this.pluginsSeen.values().next().value);
        w('event', `Událost OpenCode: ${p.type}`, pr);
        return;
      }
      case 'message.updated': {
        const m = pr.info || {};
        const prev = this.msgs.get(m.id) || {};
        const model = m.providerID ? `${m.providerID}/${m.modelID}` : prev.model;
        const done = !!(m.time?.completed || m.error);
        if (!prev.role) w('message', `${m.role === 'user' ? 'Zpráva uživatele' : 'Odpověď modelu ' + (model || '')} začala (relace ${m.sessionID}, agent ${m.agent || m.mode || '?'})`, { info: m });
        if (done && !prev.done) {
          const tk = m.tokens || {};
          const why = m.error ? `CHYBA ${m.error.name}: ${m.error.data?.message || JSON.stringify(m.error.data || {})}` : `konec: ${m.finish || '?'}`;
          w(m.error ? 'message-error' : 'message-done', `Odpověď ${model} hotová za ${m.time?.completed ? m.time.completed - m.time.created : '?'} ms – ${why}; tokeny vstup ${tk.input ?? '?'}, cache ${tk.cache?.read ?? 0}, výstup ${tk.output ?? '?'}, myšlení ${tk.reasoning ?? 0}${m.cost ? `, cena ${m.cost}` : ''}`, { info: m });
        }
        this.msgs.set(m.id, { role: m.role || prev.role, model, done: prev.done || done });
        if (this.msgs.size > 5000) this.msgs.delete(this.msgs.keys().next().value);
        return;
      }
      case 'message.part.updated': {
        const part = pr.part || {};
        const role = this.msgs.get(part.messageID)?.role;
        const model = this.msgs.get(part.messageID)?.model || '';
        let state = null;
        let kind = 'part';
        let msg = '';
        if (part.type === 'tool') {
          const s = part.state || {};
          state = 'tool:' + s.status;
          kind = 'tool-' + s.status;
          const what = `${part.tool} ${s.title || s.input?.filePath || s.input?.command || s.input?.pattern || ''}`.trim();
          if (s.status === 'pending') msg = `Model ${model} volá nástroj ${part.tool}`;
          else if (s.status === 'running') msg = `Nástroj běží: ${what}`;
          else if (s.status === 'completed') msg = `Nástroj hotový: ${what} (${s.time?.end && s.time?.start ? s.time.end - s.time.start : '?'} ms)`;
          else if (s.status === 'error') msg = `Nástroj SELHAL: ${what} – důvod: ${s.error}`;
        } else if (part.type === 'reasoning') {
          if (!part.time?.end) return; // ještě se píše
          state = 'done';
          kind = 'thinking';
          msg = `Myšlení modelu ${model}: ${part.text || ''}`;
        } else if (part.type === 'text') {
          if (role !== 'user' && !part.time?.end) return;
          state = 'done';
          kind = role === 'user' ? 'user-text' : 'model-text';
          msg = role === 'user' ? `Uživatel napsal: ${part.text || ''}` : `Model ${model} odpověděl: ${part.text || ''}`;
        } else if (part.type === 'step-start') {
          state = 'done'; kind = 'step-start'; msg = `Krok modelu ${model} začal`;
        } else if (part.type === 'step-finish') {
          state = 'done'; kind = 'step-finish';
          const tk = part.tokens || {};
          msg = `Krok modelu ${model} skončil – důvod: ${part.reason || '?'}; tokeny vstup ${tk.input ?? '?'}, cache ${tk.cache?.read ?? 0}, výstup ${tk.output ?? '?'}, myšlení ${tk.reasoning ?? 0}`;
        } else {
          state = JSON.stringify(part).length + ':' + (part.time?.end || '');
          kind = 'part-' + part.type;
          msg = `Díl zprávy typu ${part.type}`;
        }
        if (this.parts.get(part.id) === state) return;
        this.parts.set(part.id, state);
        if (this.parts.size > 50000) this.parts.delete(this.parts.keys().next().value);
        w(kind, msg, { part });
        return;
      }
      case 'session.status': {
        const st = pr.status || {};
        const msg = st.type === 'retry' ? `Relace ${pr.sessionID}: opakuji dotaz, pokus ${st.attempt}, další za ${st.next ? Math.round((st.next - Date.now()) / 1000) + ' s' : '?'} – důvod: ${st.message}` : `Relace ${pr.sessionID}: ${st.type}`;
        w('session-status', msg, pr);
        return;
      }
      case 'session.error':
        w('session-error', `CHYBA relace ${pr.sessionID}: ${pr.error?.name || ''} ${pr.error?.data?.message || JSON.stringify(pr.error?.data || pr.error || {})}`, pr);
        return;
      case 'session.compacted':
        w('compacted', `Relace ${pr.sessionID}: kontext zkrácen (compaction)`, pr);
        return;
      default:
        w('event', `Událost OpenCode: ${p.type}`, pr);
    }
  }

  /** Sleduje jiný log soubor a nové řádky přepisuje sem (src). Vrací funkci pro zastavení. */
  follow(file, src, kind = 'line', describe = (l) => l) {
    let pos = 0;
    try { pos = fs.statSync(file).size; } catch {}
    let rest = '';
    const tick = () => {
      try {
        const st = fs.statSync(file);
        if (st.size < pos) pos = 0; // soubor přejmenovaný / nový
        if (st.size === pos) return;
        const fd = fs.openSync(file, 'r');
        const len = Math.min(st.size - pos, 8 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        fs.closeSync(fd);
        pos += len;
        const lines = (rest + buf.toString('utf8')).split(/\r?\n/);
        rest = lines.pop();
        for (const l of lines) if (l.trim()) {
          let data;
          try { data = JSON.parse(l); } catch { data = undefined; }
          this.write(src, kind, describe(l, data), data);
        }
      } catch {}
    };
    const timer = setInterval(tick, 2000);
    this.tails.push(timer);
    return () => clearInterval(timer);
  }

  stop() {
    for (const t of this.tails) clearInterval(t);
    this.tails = [];
    clearInterval(this.repTimer);
    this.flushRepeats();
  }
}

module.exports = { FullLog, KEY_RES, day, collapseConsole };
