// Monitor: jestli modely opravdu fungují a jestli je v appce všechno v pořádku (uživatel 20. 11.: „chci nějaký způsob
// monitoringu, zda modely reálně fungují a zda je vše v pořádku … kvůli debuggingu appky, chceme aby modely měly co
// nejefektivnější prostředí“). Skládá jeden snímek z: součástí appky (OmniRoute, server OpenCode, proxy závodu, úplný
// log a záznam volání, klíče, disk), záznamů volání OmniRoute (každý pokus o model, i neúspěšný), úplného záznamu
// volání (src/callLog.js: čas do první odpovědi, tokeny/s, výsledek), stavu závodu (src/race.js), stavu modelů
// v OmniRoute (mrtvé / nespolehlivé / pomalé / limit), událostí relací OpenCode a rozhodnutí czek-guard.
// Upozornění mají kód + parametry (překládá okno, src/i18n.js 'mon.a.<kód>'), do úplného logu jdou česky.
'use strict';
const fs = require('fs');
const path = require('path');

const MIN = 60000;
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const aborted499 = (r) => Number(r.status) === 499 && (Number(r.duration) || 0) < 30000; // poražený v závodě / zrušeno klientem
const okStatus = (s) => Number(s) >= 200 && Number(s) < 300;
const isCombo = (m) => /^zdarma-|^auto\//.test(String(m || ''));
const pad2 = (n) => String(n).padStart(2, '0');
/** Čas pro upozornění (místní): „14:05“ dnes, jinak „31. 12. 23:00“, jiný rok i s rokem. */
const when = (ts, now = Date.now()) => {
  const d = new Date(ts); const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return hm;
  return `${d.getDate()}. ${d.getMonth() + 1}.${d.getFullYear() !== n.getFullYear() ? ' ' + d.getFullYear() : ''} ${hm}`;
};

// Události czek-guard, které stojí za zobrazení (ostatní – 'note', 'shrink', 'autocheck' – jsou běžný provoz)
const GUARD_KINDS = new Set(['block', 'continue', 'continue-skip', 'retry-abort', 'overflow', 'compact', 'compact-skip', 'background', 'timeout', 'tool-fail', 'autocheck-error', 'continue-error', 'start']);

class Monitor {
  constructor(o = {}) {
    this.logDir = o.logDir || null;
    this.omniRows = new Map(); // id → řádek volání OmniRoute (poslední 2 h)
    this.sessions = new Map(); // id relace → { id, dir, status, attempt, retryMsg, since, steps, lastStepAt, model, tokens, errors, compactions }
    this.guard = []; // posledních 100 zajímavých událostí guardu
    this.guardPos = 0;
    this.alertState = new Map(); // klíč upozornění → od kdy (do logu jen změny)
  }

  /** Řádky z /api/usage/call-logs (OmniRoute). */
  addOmniRows(rows, now = Date.now()) {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.timestamp || r.model === 'model-sync' || /connection-test|model-sync/.test(String(r.requestedModel || r.requested_model || ''))) continue;
      if (r.path && !/chat\/completions|\/messages|\/responses/.test(String(r.path))) continue;
      const id = r.id ?? `${r.timestamp}|${r.provider}|${r.model}|${r.status}`;
      this.omniRows.set(id, { id, at: Date.parse(r.timestamp), provider: r.provider, model: r.model, requested: r.requestedModel || r.requested_model || null, status: Number(r.status) || 0, duration: Number(r.duration) || 0, error: String(r.error || r.error_summary || '').slice(0, 300) });
    }
    for (const [id, r] of this.omniRows) if (!(now - r.at <= 120 * MIN)) this.omniRows.delete(id);
  }

  /** Událost z /global/event OpenCode. */
  onOcEvent(ev, now = Date.now()) {
    const p = ev?.payload;
    if (!p?.type) return;
    const pr = p.properties || {};
    const sid = pr.sessionID || pr.info?.sessionID || pr.part?.sessionID;
    if (!sid) return;
    const s = this.sessions.get(sid) || { id: sid, dir: null, status: 'idle', attempt: 0, retryMsg: '', since: now, steps: 0, lastStepAt: null, model: null, tokensIn: 0, tokensOut: 0, errors: [], compactions: 0, lastAt: now };
    if (ev.directory && ev.directory !== 'global') s.dir = ev.directory;
    s.lastAt = now;
    if (p.type === 'session.status') {
      const st = pr.status || {};
      if (st.type !== s.status) s.since = now;
      s.status = st.type || 'idle';
      s.attempt = st.attempt || 0;
      s.retryMsg = st.type === 'retry' ? String(st.message || '').slice(0, 300) : '';
    } else if (p.type === 'message.updated' && pr.info?.role === 'assistant') {
      const m = pr.info;
      if (m.providerID) s.model = `${m.providerID}/${m.modelID}`;
      if (m.error && !s.errors.some((e) => e.msg === m.id)) s.errors.push({ at: now, msg: m.id, name: m.error.name, text: String(m.error.data?.message || '').slice(0, 300) });
    } else if (p.type === 'message.part.updated' && pr.part?.type === 'step-finish') {
      if (!s.stepIds) s.stepIds = new Set();
      if (!s.stepIds.has(pr.part.id)) { s.stepIds.add(pr.part.id); s.steps++; s.lastStepAt = now; s.tokensIn += pr.part.tokens?.input || 0; s.tokensOut += pr.part.tokens?.output || 0; if (s.stepIds.size > 2000) s.stepIds = new Set(); }
    } else if (p.type === 'session.error') {
      s.errors.push({ at: now, name: pr.error?.name || 'chyba', text: String(pr.error?.data?.message || '').slice(0, 300) });
    } else if (p.type === 'session.compacted') s.compactions++;
    if (s.errors.length > 20) s.errors.splice(0, s.errors.length - 20);
    this.sessions.set(sid, s);
    if (this.sessions.size > 30) {
      const old = [...this.sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      this.sessions.delete(old.id);
    }
  }

  /** Nové řádky guard.jsonl (czek-guard v OpenCode, src/guard/index.mjs). */
  readGuard() {
    const dir = typeof this.logDir === 'function' ? this.logDir() : this.logDir;
    if (!dir) return;
    const f = path.join(dir, 'guard.jsonl');
    try {
      const st = fs.statSync(f);
      if (st.size < this.guardPos) this.guardPos = 0;
      if (st.size === this.guardPos) return;
      const len = Math.min(st.size - this.guardPos, 4 * 1024 * 1024);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      this.guardPos = st.size;
      for (const l of buf.toString('utf8').split('\n')) {
        if (!l.trim()) continue;
        try {
          const e = JSON.parse(l);
          if (!GUARD_KINDS.has(e.kind)) continue;
          this.guard.push({ at: Date.parse(e.t || e.time || '') || Date.now(), kind: e.kind, msg: String(e.msg || '').slice(0, 400), why: e.why || e.data?.why || null, session: e.session || e.data?.session || null });
        } catch {}
      }
      if (this.guard.length > 100) this.guard.splice(0, this.guard.length - 100);
    } catch {}
  }

  /**
   * @param {object} x vstupy z hlavního procesu (main.js monitorInput): součásti, omni (instance), race, calls (souhrny),
   *   keyHealth, diskFree, opencode
   */
  snapshot(x, now = Date.now()) {
    this.readGuard();
    const models = buildModels(x, this.omniRows, now);
    const calls = (x.calls || []).slice(-60).reverse();
    const sessions = [...this.sessions.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 8).map(({ stepIds, ...s }) => s);
    const guard = this.guard.slice(-30).reverse();
    const components = buildComponents(x, now);
    const alerts = buildAlerts({ x, models, calls, sessions, guard, components, rows: [...this.omniRows.values()] }, now);
    return { at: now, version: x.version || null, ok: !alerts.some((a) => a.level === 'error'), components, alerts, active: x.race?.active || [], models, calls, sessions, guard };
  }

  /** Změny upozornění od minula (nová / skončená) – pro úplný log. */
  alertChanges(alerts, now = Date.now()) {
    const keys = new Set(alerts.map((a) => a.key));
    const added = alerts.filter((a) => !this.alertState.has(a.key));
    const ended = [...this.alertState.keys()].filter((k) => !keys.has(k));
    for (const a of added) this.alertState.set(a.key, now);
    for (const k of ended) this.alertState.delete(k);
    return { added, ended };
  }
}

/** Mapa modelu z combo (ref, jak ho OmniRoute dostává) → { provider, id } a stav podle OmniRoute. */
function refMeta(omni) {
  const map = new Map();
  for (const base of omni?.baseLists?.values?.() || []) for (const x of base) if (x?.ref && !map.has(x.ref)) map.set(x.ref, { provider: x.provider, id: x.id });
  return map;
}

function buildModels(x, omniRows, now) {
  const omni = x.omniEngine || null;
  const meta = refMeta(omni);
  const nodeToProv = omni?.nodeToProvider || new Map();
  const has = (set, k) => !!(set && set.has && set.has(k));
  const rows = new Map(); // ref → agregát
  const row = (ref) => {
    if (!rows.has(ref)) rows.set(ref, { model: ref, calls: 0, ok: 0, fail: 0, aborted: 0, durOk: [], lastErr: null, lastAt: 0, ttft: [], tps: [], wins: 0, states: [] });
    return rows.get(ref);
  };
  for (const r of omniRows.values()) {
    if (now - r.at > 60 * MIN) continue;
    const ref = r.requested && !isCombo(r.requested) ? r.requested : `${nodeToProv.get(r.provider) || r.provider}/${r.model}`;
    if (r.status === 0) continue; // rozpracované (OmniRoute ho později přepíše skutečným stavem)
    const m = row(ref);
    m.lastAt = Math.max(m.lastAt, r.at);
    m.calls++;
    if (okStatus(r.status)) { m.ok++; m.durOk.push(r.duration); } else if (aborted499(r)) m.aborted++;
    else { m.fail++; if (!m.lastErr || r.at > m.lastErr.at) m.lastErr = { at: r.at, status: r.status, text: r.error }; }
  }
  for (const c of x.calls || []) {
    if (now - c.t > 60 * MIN || !c.model || isCombo(c.model)) continue;
    const m = row(c.model);
    const tt = c.modelTtftMs ?? c.ttftMs;
    if (tt != null) m.ttft.push(tt);
    if (c.tokPerS != null) m.tps.push(c.tokPerS);
    if (c.race?.winner === c.model) m.wins++;
  }
  for (const [ref, n] of Object.entries(x.race?.stats?.won || {})) row(ref).winsTotal = n;
  const coolMap = x.race?.cool || new Map();
  const lagMap = x.race?.lag || new Map();
  for (const ref of [...coolMap.keys(), ...lagMap.keys()]) row(ref);
  // pauzy modelů v OmniRoute (OmniRoute.syncCooldowns) – i modely bez volání za poslední hodinu
  const paused = omni?.paused instanceof Map ? omni.paused : new Map();
  const keyRef = new Map([...meta].map(([ref, v]) => [`${v.provider}/${v.id}`, ref]));
  const pausedRefKey = new Map([...paused].map(([key, p]) => [p.ref || key, key])); // i model mimo combo (není v meta)
  for (const [key, p] of paused) if (p.until > now) row(keyRef.get(key) || p.ref || key);
  return [...rows.values()].map((m) => {
    const mm = meta.get(m.model);
    const key = mm ? `${mm.provider}/${mm.id}` : pausedRefKey.get(m.model) || m.model;
    const st = [];
    const pz = paused.get(key);
    const pzOn = !!(pz && pz.until > now);
    if (mm && (has(omni?.deadProviders, mm.provider) || has(omni?.deadModels, key))) st.push('dead');
    if (pzOn) st.push('paused');
    if (has(omni?.limited, key)) st.push('limited');
    if (has(omni?.flaky, key)) st.push('flaky');
    if (has(omni?.slow, key)) st.push('slow');
    if ((coolMap.get(m.model) || 0) > now) st.push('cooling');
    if ((lagMap.get(m.model)?.until || 0) > now) st.push('lagging');
    const real = m.ok + m.fail;
    return {
      model: m.model, provider: mm?.provider || String(m.model).split('/')[0], states: st, calls: m.calls, ok: m.ok, fail: m.fail, aborted: m.aborted,
      okPct: real ? Math.round((m.ok / real) * 100) : null, medianMs: median(m.durOk), ttftMs: median(m.ttft), tokPerS: median(m.tps),
      wins: m.wins, winsTotal: m.winsTotal || 0, lastErr: m.lastErr, lastAt: m.lastAt || null,
      coolUntil: (coolMap.get(m.model) || 0) > now ? coolMap.get(m.model) : null,
      // pauza v OmniRoute: do kdy, důvod od OmniRoute, kdy ji czek-ai smaže a model zkusí znovu
      pausedUntil: pzOn ? pz.until : null, pausedReason: pzOn ? pz.reason || null : null, reprobeAt: pzOn ? pz.reprobeAt || null : null,
    };
  }).sort((a, b) => (b.calls - a.calls) || (b.winsTotal - a.winsTotal) || a.model.localeCompare(b.model));
}

function buildComponents(x, now) {
  const c = [];
  const o = x.omni || {};
  c.push({ id: 'omniroute', ok: !!o.ready, state: o.ready ? 'ok' : o.starting ? 'starting' : 'down', detail: o.ready ? { url: o.url, providers: o.providers, combos: o.combos } : { error: o.error || '' } });
  const oc = x.opencode || {};
  c.push({ id: 'opencode', ok: !!oc.running, state: oc.running ? 'ok' : 'down', detail: { url: oc.url || '', restarts: oc.restarts || 0 } });
  const r = x.race || {};
  const raceOn = (r.n || 0) >= 2;
  c.push({ id: 'race', ok: !raceOn || !!r.url, state: !raceOn ? 'off' : r.url ? 'ok' : 'down', detail: { url: r.url || '', n: r.n || 0, races: r.stats?.races || 0, fallbacks: r.stats?.fallbacks || 0, stalls: r.stats?.stalls || 0, firstMs: median(r.stats?.lastMs || []) } });
  c.push({ id: 'fulllog', ok: true, state: x.fullLog?.on ? 'ok' : 'off', detail: { file: x.fullLog?.file || '' } });
  c.push({ id: 'calllog', ok: true, state: x.callLog?.on ? 'ok' : 'off', detail: { bytes: x.callLog?.todayBytes || 0, dir: x.callLog?.dir || '' } });
  const kh = x.keyHealth || { items: [] };
  const badKeys = (kh.items || []).filter((i) => !i.ok);
  c.push({ id: 'keys', ok: !badKeys.length, state: !kh.at ? 'unknown' : badKeys.length ? 'warn' : 'ok', detail: { checked: kh.at || null, total: (kh.items || []).length, bad: badKeys.map((b) => b.provider) } });
  if (x.diskFree != null) c.push({ id: 'disk', ok: x.diskFree > 2 * 1024 ** 3, state: x.diskFree > 2 * 1024 ** 3 ? 'ok' : 'warn', detail: { free: x.diskFree } });
  return c;
}

function buildAlerts({ x, models, calls, sessions, guard, components, rows }, now) {
  const out = [];
  const add = (level, code, params, key) => out.push({ level, code, params, key: key || code + ':' + JSON.stringify(params) });
  for (const c of components) {
    if (c.id === 'omniroute' && c.state === 'down') add('error', 'omniDown', { error: c.detail.error || '' }, 'omniDown');
    if (c.id === 'opencode' && c.state === 'down' && x.opencode?.expected) add('error', 'ocDown', {}, 'ocDown');
    if (c.id === 'race' && c.state === 'down') add('warn', 'raceDown', {}, 'raceDown');
    if (c.id === 'keys' && c.state === 'warn') add('warn', 'badKeys', { list: c.detail.bad.join(', ') }, 'badKeys');
    if (c.id === 'disk' && c.state === 'warn') add('warn', 'disk', { gb: Math.round((c.detail.free / 1024 ** 3) * 10) / 10 }, 'disk');
  }
  // celkově: většina pokusů o model za 10 min selhává
  const recent = rows.filter((r) => now - r.at <= 10 * MIN && r.status !== 0 && !aborted499(r));
  const bad = recent.filter((r) => !okStatus(r.status));
  if (recent.length >= 5 && bad.length / recent.length > 0.5) add('error', 'mostFail', { bad: bad.length, all: recent.length }, 'mostFail');
  // jednotlivé modely: ≥ 3 selhání za 10 min
  const perModel = new Map();
  for (const r of bad) { const k = r.requested && !isCombo(r.requested) ? r.requested : `${r.provider}/${r.model}`; const e = perModel.get(k) || { n: 0, last: r }; e.n++; if (r.at >= e.last.at) e.last = r; perModel.set(k, e); }
  for (const [model, e] of perModel) if (e.n >= 3) add('warn', 'modelFails', { model, n: e.n, status: e.last.status, error: (e.last.error || '').slice(0, 120) }, 'modelFails:' + model);
  // modely v pauze OmniRoute (delší než 10 min): do kdy a kdy je czek-ai zkusí znovu (krátké 429 jsou běžný provoz)
  for (const m of models) {
    if (!m.pausedUntil || m.pausedUntil - now < 10 * MIN) continue;
    add('info', 'omniPaused', { model: m.model, until: when(m.pausedUntil, now), reason: m.pausedReason || '?', retry: m.reprobeAt ? when(m.reprobeAt, now) : when(m.pausedUntil, now) }, 'omniPaused:' + m.model);
  }
  // volání za 15 min: dlouhý krok, chyba, záloha závodu, zmlklý vítěz
  for (const c of calls) {
    if (now - c.t > 15 * MIN) continue;
    if (c.totalMs > 120000) add('warn', 'slowCall', { model: c.model, s: Math.round(c.totalMs / 1000), time: new Date(c.t).toISOString() }, 'slowCall:' + c.id);
    if (c.race?.stalled) add('warn', 'stalled', { model: c.model }, 'stalled:' + c.id);
    else if (c.error && !/zrušeno klientem/.test(c.error)) add('warn', 'callError', { model: c.model, error: c.error.slice(0, 160) }, 'callError:' + c.id);
    if (c.race?.fallback) add('warn', 'fallback', { combo: c.combo }, 'fallback:' + c.id);
  }
  // relace: opakuje dotaz, chyba v posledních 15 min
  for (const s of sessions) {
    if (s.status === 'retry') add('warn', 'retry', { session: s.id, attempt: s.attempt, msg: s.retryMsg.slice(0, 160) }, 'retry:' + s.id);
    const e = s.errors.filter((y) => now - y.at <= 15 * MIN).pop();
    if (e) add('error', 'sessionError', { session: s.id, name: e.name, text: (e.text || '').slice(0, 160) }, 'sessionError:' + s.id + ':' + e.at);
    if (s.status === 'busy' && s.lastStepAt && now - s.lastStepAt > 5 * MIN) add('warn', 'stuck', { session: s.id, min: Math.round((now - s.lastStepAt) / MIN) }, 'stuck:' + s.id);
  }
  // guard za 15 min: zastavil opakování, zablokoval, poslal pokračování
  for (const g of guard) {
    if (now - g.at > 15 * MIN) continue;
    if (g.kind === 'retry-abort' || g.kind === 'block') add('warn', 'guard_' + g.kind.replace('-', ''), { msg: g.msg.slice(0, 200) }, 'guard:' + g.kind + ':' + g.at);
    if (g.kind === 'continue') add('info', 'guardContinue', { msg: g.msg.slice(0, 200) }, 'guard:continue:' + g.at);
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Česky pro úplný log (okno překládá samo podle kódu). */
function alertText(a) {
  const p = a.params || {};
  const T = {
    omniDown: `OmniRoute neběží${p.error ? ': ' + p.error : ''}`, ocDown: 'server OpenCode neběží', raceDown: 'proxy závodu nenaběhla – dotazy jdou přímo na OmniRoute',
    badKeys: `neplatné nebo odmítnuté klíče: ${p.list}`, disk: `málo místa na disku (${p.gb} GB)`, mostFail: `většina pokusů o model selhává (${p.bad} z ${p.all} za 10 min)`,
    modelFails: `${p.model}: ${p.n} selhání za 10 min (poslední ${p.status}${p.error ? ' ' + p.error : ''})`, slowCall: `krok modelu ${p.model} trval ${p.s} s`,
    omniPaused: `${p.model}: OmniRoute ho po limitu poskytovatele drží v pauze do ${p.until} (${p.reason}); czek-ai ho do závodu nedá, znovu zkusí v ${p.retry}`,
    stalled: `vítěz závodu ${p.model} zmlkl uprostřed odpovědi`, callError: `volání ${p.model} skončilo chybou: ${p.error}`, fallback: `všichni závodníci selhali, dotaz šel na celé combo ${p.combo}`,
    retry: `relace ${p.session} opakuje dotaz (pokus ${p.attempt}): ${p.msg}`, sessionError: `chyba relace ${p.session}: ${p.name} ${p.text}`, stuck: `relace ${p.session} pracuje, ale ${p.min} min bez dokončeného kroku`,
    guard_retryabort: `guard zastavil nekonečné opakování: ${p.msg}`, guard_block: `guard zablokoval nástroj: ${p.msg}`, guardContinue: `guard poslal pokračování: ${p.msg}`,
  };
  return T[a.code] || a.code;
}

module.exports = { Monitor, buildModels, buildAlerts, buildComponents, alertText, median, when };
