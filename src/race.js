// Závod modelů: každý krok agenta (dotaz s nástroji na tier zdarma-*) jde současně na několik modelů tieru přes
// OmniRoute; vyhraje první, který začne skutečně odpovídat (text, volání nástroje, uvažování), ostatní se hned zruší.
// Silnější model (výš v pořadí tieru) dostane krátkou přednost (GRACE_MS): když začne do té doby, vyhraje on.
//
// Proč (uživatel 20. 11.: „aby vždy s promptem běželo několik různých modelů najednou, bude to rychlejší a lepší
// výsledek“): OmniRoute zkouší modely combo po jednom – pomalý nebo přetížený model v čele stojí každý krok čekání
// (14.–17. 11.: medián 4–8 s, p90 25–35 s jen do první odpovědi, visení 45 s). Strategie OmniRoute „fusion“ (panel +
// soudce) dotazy s nástroji pošle jen jednomu modelu, pro agenta tedy nic nedělá.
//
// Proxy sedí mezi pluginem OmniRoute v OpenCode a OmniRoute: všechno ostatní (/v1/models, /api/combos, titulky,
// kompakce bez nástrojů) jen přeposílá. Když selžou všichni závodníci, pošle dotaz na celé combo (OmniRoute pak
// zkouší modely po jednom jako dřív).
'use strict';
const http = require('http');
const { assemble } = require('./callLog');
const { hasImages, rewriteImages } = require('./vision');

// Přednost silnějšího modelu: vyhraje-li slabší, čeká se ještě GRACE_MS, jestli nezačne model výš v pořadí.
// 1,2 s bylo málo (bench 20. 11.: Nemotron začíná za 2–3 s, slabší modely za 1 s) → slabší vítězili.
const GRACE_MS = 2500;
const FIRST_OUTPUT_MS = 45000; // stejně jako limit OmniRoute na první odpověď
const RESERVE = 4; // náhradníků za vypadlé
const COOL_LIMIT_MS = 90000; // 429 / vyčerpaný limit
const COOL_ERROR_MS = 60000; // 5xx, chyba streamu
const COOL_HANG_MS = 180000; // nezačal odpovídat do FIRST_OUTPUT_MS
const COOL_TOO_LARGE_MS = 10 * 60000; // 413 – kontext relace pro model moc velký (jen roste; Groq gpt-oss 20. 11. pokaždé)
// 429 „model_cooldown“ od OmniRoute nese reset_seconds (kolik model ještě drží v pauze). Krátká pauza = jen tak dlouho,
// dlouhá = nejvýš COOL_OMNI_MAX_MS: dlouhodobě model z kandidátů vyřadí OmniRoute.syncCooldowns (i s opakovaným
// pokusem po 30 min), paměť závodu jen do první synchronizace.
const COOL_OMNI_MIN_MS = 15000;
const COOL_OMNI_MAX_MS = 10 * 60000;

// Věrnost vítězi: model, který vyhrál předchozí krok TÉŽE konverzace, jde v dalším kroku na první místo (dostane
// přednost GRACE). Závod dál chrání dostupnost, ale konverzaci vede jeden model. 22. 11. (bench-czek bugfix): závod
// střídal ERNIE a Nemotron (14 + 9 vítězství) → 23 kroků a 75 s, ERNIE samotná 7 kroků a 25 s – modely si navzájem
// předělávaly práci. ZDARMA_RACE_STICKY=0 věrnost vypne (A/B).
// Odstupňovaný závod (hedging): krok jde nejdřív JEN vedoucímu modelu (vítěz minulého kroku / první v pořadí);
// další závodníci startují, až když vedoucí do HEDGE ms nezačne odpovídat, nebo hned, když vypadne. Dřív šel každý
// krok na 2 modely najednou a poražený jen pálil free limit: ve třídě na jedné IP (Kilo 200 dotazů/h) to znamenalo
// 2× rychlejší vyčerpání. HEDGE = 1,5× typický čas do první odpovědi vedoucího (p75 z posledních výher), 2–6 s;
// bez historie 3 s. ZDARMA_RACE_HEDGE_MS=0 = starý souběžný závod (A/B), číslo = pevný odstup.
const HEDGE_DEFAULT_MS = 3000;
const HEDGE_MIN_MS = 2000;
const HEDGE_MAX_MS = 6000;
const STICKY_MS = 30 * 60000; // konverzace bez kroku déle → zapomenout
const STICKY_MAX = 300;
/** Klíč konverzace: combo + první zadání uživatele (u OpenCode stejné ve všech krocích relace). */
function convKey(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const first = msgs.find((m) => m && m.role === 'user');
  if (!first) return null;
  const c = typeof first.content === 'string' ? first.content : JSON.stringify(first.content || '');
  return require('crypto').createHash('sha1').update(String(body.model || '') + '\n' + c.slice(0, 20000)).digest('hex');
}

/** reset_seconds z chyby OmniRoute model_cooldown (tělo 429 nebo chyba ve streamu) → ms, jinak null. */
function cooldownResetMs(err) {
  let e = err;
  if (typeof e === 'string') { try { e = JSON.parse(e); } catch { return null; } }
  e = e?.error || e;
  if (!e || e.code !== 'model_cooldown') return null;
  const s = Number(e.reset_seconds);
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}
const LAG_AFTER = 3; // závodů za sebou, kdy výš postavený model mlčel a vyhrál slabší
const LAG_MS = 10 * 60000;
// Vítěz už posílá klientovi; když pak STALL_MS nepošle žádná data, spojení se ukončí chybou (OpenCode krok
// zopakuje) a model dostane pauzu. Bench 20. 11.: Mistral Large 4 začal za 2,5 s a pak 6,5 min nic → přerušení.
const STALL_MS = 90000;

/** Má delta v řádku SSE skutečný obsah (ne jen roli / prázdný text)? */
function meaningful(chunk) {
  const ch = chunk?.choices?.[0];
  if (!ch) return false;
  const d = ch.delta || ch.message || {};
  if (Array.isArray(d.tool_calls) && d.tool_calls.length) return true;
  for (const k of ['content', 'reasoning_content', 'reasoning']) if (typeof d[k] === 'string' && d[k].trim()) return true;
  return false;
}

/** Rozdělí buffer SSE na celé události (\n\n), vrátí { events, rest }. */
function splitEvents(buf) {
  const events = [];
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) { events.push(buf.slice(0, i + 2)); buf = buf.slice(i + 2); }
  return { events, rest: buf };
}

function parseData(ev) {
  const lines = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  if (!lines.length) return null;
  const s = lines.join('\n');
  if (s === '[DONE]') return { done: true };
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * @param {object} o
 * @param {() => string|null} o.target URL OmniRoute (http://127.0.0.1:port)
 * @param {(model: string, total: number, racers: number) => string[]} o.candidates modely závodu pro combo: prvních
 *   racers závodí, další jsou náhradníci (prázdné = nezávodit)
 * @param {() => number} o.n počet závodníků (0/1 = vypnuto)
 * @param {(msg: string, data?: object) => void} [o.log]
 * @param {(dataUrls: string[], prompt: string) => Promise<{text: string, model: string}>} [o.vision] popis obrázků modelem s viděním (src/vision.js, nástroj look)
 * @param {() => string} [o.imageDir] kam uložit obrázek, když pracovní složka není známá
 * @param {(rec: object) => void} [o.onCall] hotové volání celé (dotaz, odpověď, časy, závod) – úplný záznam, src/callLog.js
 */
/** Hlavičky klienta pro dotaz na OmniRoute: bez hop-by-hop a délky (tělo se posílá znovu, jinak dlouhé). */
function upHeaders(req, host, extra) {
  const h = { ...req.headers, host };
  for (const k of ['content-length', 'transfer-encoding', 'connection', 'keep-alive']) delete h[k];
  return { ...h, ...extra };
}

// Celé combo selhalo na limitech (všechny modely tieru „cooling down“, 429, 402): místo anglické hlášky OmniRoute
// česky, co se stalo a co dělat. 22. 11. po dni měření: OpenCode ukazoval „All credentials for model zdarma-max are
// cooling down“ – student neví, že stačí počkat nebo si přidat vlastní free klíče (limity bez klíče sdílí celá třída).
const QUOTA_RE = /cooling down|rate.?limit|quota|too many requests|credits?|insufficient|exhausted|sign up/i;
function friendlyNoQuota(status, raw, combo, keyed, t) {
  let msg = raw;
  try { const j = JSON.parse(raw); msg = j?.error?.message || j?.message || raw; } catch {}
  msg = String(msg || '').replace(/\s+/g, ' ').trim();
  if (!(status === 402 || status === 429 || (status >= 500 && QUOTA_RE.test(msg)) || QUOTA_RE.test(msg))) return null;
  let wait = null;
  try { const s = Number(JSON.parse(raw)?.error?.reset_seconds); if (s > 0) wait = Math.ceil(s / 60); } catch {}
  const text = t(keyed > 0 ? 'race.noQuota' : 'race.noQuotaNoKeys', { combo: combo || 'tier', wait: wait ? t('race.noQuotaWait', { min: wait }) : '', orig: msg.slice(0, 160) });
  return JSON.stringify({ error: { message: text, type: 'czek_no_free_quota', code: status, original: msg.slice(0, 300) } });
}

function createRaceProxy(o) {
  const tr18 = o.t || ((k, v) => require('./i18n').t(k, v));
  const log = o.log || (() => {});
  const GRACE = o.graceMs ?? GRACE_MS; // testy zkracují
  const FIRST = o.firstOutputMs ?? FIRST_OUTPUT_MS;
  const STALL = o.stallMs ?? STALL_MS;
  const stats = { races: 0, won: {}, fallbacks: 0, stalls: 0, lastMs: [], last: null, sticky: 0, calls: 0, hedged: 0 };
  const HEDGE_ENV = process.env.ZDARMA_RACE_HEDGE_MS;
  const ttftHist = new Map(); // model → posledních 10 časů do první odpovědi (ms) z výher
  const hedgeFor = (model) => {
    if (o.hedgeMs != null) return o.hedgeMs;
    if (HEDGE_ENV != null && HEDGE_ENV !== '') return Number(HEDGE_ENV);
    const h = (ttftHist.get(model) || []).slice().sort((a, b) => a - b);
    if (h.length < 3) return HEDGE_DEFAULT_MS;
    return Math.max(HEDGE_MIN_MS, Math.min(HEDGE_MAX_MS, Math.round(h[Math.floor(h.length * 0.75)] * 1.5)));
  };
  const STICKY = o.sticky ?? process.env.ZDARMA_RACE_STICKY !== '0';
  const sticky = new Map(); // klíč konverzace → { model, at }
  // Právě běžící dotazy na modely (monitor): id → { id, t, combo, kind, runners: [{ model, rank, state }], winner }
  const active = new Map();
  let seq = 0;
  const newTrace = (req, body, tools) => {
    const { messages, tools: tl, ...params } = body;
    const headers = { ...req.headers };
    for (const k of ['authorization', 'cookie', 'x-api-key', 'api-key']) delete headers[k];
    const tr = { id: Date.now().toString(36) + '-' + (++seq).toString(36), t: Date.now(), path: req.url, kind: tools ? 'agent' : 'bez nástrojů',
      combo: String(body.model || ''), params, headers, messages: Array.isArray(messages) ? messages : [], tools: Array.isArray(tl) ? tl : [] };
    active.set(tr.id, { id: tr.id, t: tr.t, combo: tr.combo, kind: tr.kind, runners: [], winner: null });
    return tr;
  };
  const finishTrace = (tr, extra) => {
    if (!tr || tr.done) return;
    tr.done = true;
    Object.assign(tr, extra);
    tr.totalMs = Date.now() - tr.t;
    active.delete(tr.id);
    if (o.onCall) { try { const { done, ...rec } = tr; o.onCall(rec); } catch {} }
  };
  const setRunner = (tr, model, rank, state) => {
    const a = tr && active.get(tr.id);
    if (!a) return;
    const x = a.runners.find((y) => y.model === model);
    if (x) x.state = state; else a.runners.push({ model, rank, state, since: Date.now() });
  };

  /** Přeposlání na OmniRoute; u chat dotazu (trace) se odpověď zároveň skládá do úplného záznamu. */
  const forward = (req, res, body, tr = null, chat = false) => {
    const t = o.target();
    if (!t) {
      res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"message":"OmniRoute neběží"}}');
      finishTrace(tr, { error: 'OmniRoute neběží', upstream: { status: 502 } });
      return;
    }
    const u = new URL(req.url, t);
    const headers = body != null ? upHeaders(req, u.host, { 'content-length': Buffer.byteLength(body), ...(tr ? { 'accept-encoding': 'identity' } : {}) }) : { ...req.headers, host: u.host };
    if (tr) setRunner(tr, tr.combo, 0, 'čeká');
    const up = http.request(u, { method: req.method, headers }, (r) => {
      // dotaz agenta, na který combo odpovědělo chybou limitu → srozumitelná hláška (status zůstává)
      if ((tr || chat) && r.statusCode >= 400 && !/event-stream/.test(String(r.headers['content-type'] || '')) && !/gzip|br|deflate/i.test(String(r.headers['content-encoding'] || ''))) {
        let raw = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { if (raw.length < 65536) raw += c; });
        r.on('end', () => {
          const combo = tr?.combo || (() => { try { return JSON.parse(body || '{}').model; } catch { return ''; } })();
          const nice = friendlyNoQuota(r.statusCode, raw, combo, o.keyedCount ? o.keyedCount() : 1, tr18);
          const out = nice || raw;
          try { res.writeHead(r.statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) }); res.end(out); } catch {}
          if (nice) log('závod: combo bez volného limitu → hláška s průvodcem klíči', { combo, status: r.statusCode });
          finishTrace(tr, { error: 'HTTP ' + r.statusCode + ' ' + raw.slice(0, 300), upstream: { status: r.statusCode } });
        });
        r.on('error', (e) => finishTrace(tr, { error: 'přerušeno: ' + e.message, upstream: { status: r.statusCode } }));
        return;
      }
      res.writeHead(r.statusCode, r.headers);
      // komprimovanou odpověď (přes accept-encoding: identity by neměla přijít) jen poslat dál beze změny
      if (!tr || /gzip|br|deflate/i.test(String(r.headers['content-encoding'] || ''))) {
        r.pipe(res);
        if (tr) r.on('end', () => finishTrace(tr, { error: 'odpověď komprimovaná (' + r.headers['content-encoding'] + ') – nezaznamenána', upstream: { status: r.statusCode } }));
        return;
      }
      // odbočka: stream (SSE) se parsuje po událostech, jiná odpověď se složí na konci (max 5 MB)
      const sse = /event-stream/.test(String(r.headers['content-type'] || ''));
      const objs = []; let buf = ''; let raw = ''; let first = null;
      r.setEncoding('utf8');
      r.on('data', (c) => {
        try { res.write(c); } catch {}
        if (sse) {
          buf += c;
          const sp = splitEvents(buf); buf = sp.rest;
          for (const ev of sp.events) { const j = parseData(ev); if (j) { objs.push(j); if (!first && !j.done && meaningful(j)) { first = Date.now(); setRunner(tr, tr.combo, 0, 'odpovídá'); } } }
        } else if (raw.length < 5 * 1024 * 1024) raw += c;
      });
      r.on('end', () => {
        try { res.end(); } catch {}
        if (!sse) { try { objs.push(JSON.parse(raw)); } catch { if (raw) objs.push({ error: { message: raw.slice(0, 2000) } }); } }
        const resp = assemble(objs);
        finishTrace(tr, { response: resp, ttftMs: first ? first - tr.t : null,
          upstream: { status: r.statusCode, model: r.headers['x-omniroute-model'] || resp.model || null, provider: r.headers['x-omniroute-provider'] || null },
          ...(r.statusCode >= 400 ? { error: 'HTTP ' + r.statusCode + ' ' + String(resp.error?.message || raw).slice(0, 300) } : {}) });
      });
      r.on('error', (e) => finishTrace(tr, { error: 'přerušeno: ' + e.message, response: assemble(objs), upstream: { status: r.statusCode } }));
    });
    up.on('error', (e) => {
      try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'OmniRoute: ' + e.message } })); } catch {}
      finishTrace(tr, { error: 'OmniRoute: ' + e.message, upstream: { status: 502 } });
    });
    res.on('close', () => { if (!res.writableEnded) { up.destroy(); finishTrace(tr, { error: 'zrušeno klientem (OpenCode)' }); } });
    if (body != null) up.end(body); else req.pipe(up);
  };

  /** Jeden závodník: stream z OmniRoute s daným modelem. Volá cb.onOutput / cb.onFail. */
  const runner = (req, body, model, rank, cb) => {
    const t = o.target();
    const u = new URL(req.url, t);
    const data = Buffer.from(JSON.stringify({ ...body, model }));
    // identity: stream se tu čte jako text (gzip od OmniRoute by čtení rozbil) a klientovi jde nekomprimovaný
    const headers = upHeaders(req, u.host, { 'content-length': data.length, accept: 'text/event-stream', 'accept-encoding': 'identity' });
    let buf = ''; const events = []; let got = false; let ended = false; let resp = null;
    const r = { model, rank, events, res: null, abort: () => {}, started: false, failed: false, tStart: Date.now(), tFirst: null, tEnd: null, status: null, why: null, aborted: false };
    const timer = setTimeout(() => { if (!got) { fail('bez odpovědi do ' + FIRST / 1000 + ' s'); } }, FIRST);
    const fail = (why) => { if (r.failed || got) return; r.failed = true; r.why = why; r.tEnd = Date.now(); clearTimeout(timer); try { up.destroy(); } catch {} cb.onFail(r, why); };
    const up = http.request(u, { method: 'POST', headers }, (rs) => {
      resp = rs; r.res = rs; r.status = rs.statusCode;
      if (rs.statusCode >= 400) { let e = ''; rs.on('data', (c) => { e += c; }); rs.on('end', () => { r.resetMs = cooldownResetMs(e); fail(`HTTP ${rs.statusCode} ${e.slice(0, 160)}`); }); return; }
      rs.setEncoding('utf8');
      rs.on('data', (c) => {
        if (r.failed) return;
        buf += c;
        const sp = splitEvents(buf); buf = sp.rest;
        for (const ev of sp.events) {
          events.push(ev);
          const j = parseData(ev);
          if (j && j.error && !got) { r.resetMs = cooldownResetMs(j); fail('chyba ve streamu: ' + JSON.stringify(j.error).slice(0, 160)); return; }
          if (!got && j && !j.done && meaningful(j)) { got = true; r.tFirst = Date.now(); clearTimeout(timer); cb.onOutput(r); }
          if (r.onEvent) r.onEvent(ev);
        }
      });
      rs.on('end', () => { ended = true; r.tEnd = Date.now(); if (!got) fail('stream skončil bez obsahu'); else if (r.onEnd) r.onEnd(); });
      rs.on('error', () => {}); // následuje 'close'
      // spojení spadlo bez konce streamu: před první odpovědí = vypadl; po ní už nesmí vyhrát (useknutá odpověď)
      rs.on('close', () => {
        if (ended || r.failed) return;
        ended = true; r.errored = true;
        if (!got) fail('spojení přerušeno'); else if (r.onEnd) r.onEnd(); else cb.onBroken(r);
      });
    });
    up.on('error', (e) => fail(e.message));
    up.end(data);
    r.abort = () => { if (!r.failed && !ended) { r.aborted = true; r.tEnd = Date.now(); } clearTimeout(timer); r.failed = true; try { up.destroy(); } catch {} try { resp?.destroy(); } catch {} };
    r.isEnded = () => ended;
    return r;
  };

  // Náhradníci: když závodník vypadne dřív, než kdokoli začal odpovídat, hned nastoupí další model z pořadí (ne až
  // po všech, kdy se čekalo na nejpomalejší selhání a pak na combo). Bench 20. 11.: první krok relace – 2 modely hned
  // 429 / chyba streamu, třetí visel 45 s, pak combo dalších 52 s; Nemotron dál v pořadí odpovídal do 2 s.
  // Krátká paměť selhání: model, který v závodě vypadl, se chvíli nezkouší (beam-free „cooling down“ 3× za 20 s,
  // než ho odsunul přepočet pořadí).
  const cool = new Map(); // model → do kdy vynechat
  const cooling = (m) => (cool.get(m) || 0) > Date.now();
  // Mlčící: model výš v pořadí, který při výhře slabšího (i po GRACE) ještě nezačal odpovídat. Nevypadne, jen se
  // zruší (krátké 499 statistiky OmniRoute schválně nepočítají), takže by v čele zůstal napořád. Bench 20. 11.:
  // Kimi K3.1 Pro první v každém závodě, ani jednou nezačal → každý krok +1,2 s čekání a dotaz navíc. Po LAG_AFTER
  // takových závodech za sebou jde na LAG_MS mezi náhradníky (dál se může dosadit za vypadlé).
  const lag = new Map(); // model → { n, until }
  const lagging = (m) => (lag.get(m)?.until || 0) > Date.now();
  const coolFor = (why, resetMs) => (resetMs ? Math.min(COOL_OMNI_MAX_MS, Math.max(COOL_OMNI_MIN_MS, resetMs))
    : /^HTTP 413|too large|context.length|maximum context/i.test(why) ? COOL_TOO_LARGE_MS
    : /^HTTP 429|rate.?limit|cooling down|cooldown|quota/i.test(why) ? COOL_LIMIT_MS : /^bez odpovědi/.test(why) ? COOL_HANG_MS : COOL_ERROR_MS);

  const race = (req, res, body, pool, n, tr = null, conv = null) => {
    const t0 = tr ? tr.t : Date.now();
    const runners = [];
    const reserve = pool.slice(n);
    const tried = pool.slice(0, n);
    let committed = null; let graceTimer = null; let finished = false;
    const emitted = new Set();
    let pending = []; let hedgeTimer = null; // odstupňovaný start: [model, pořadí] čekající na HEDGE
    const launch = (m, i) => { runners.push(runner(req, body, m, i, cb)); setRunner(tr, m, i, 'čeká'); stats.calls++; };
    const launchPending = () => {
      clearTimeout(hedgeTimer); hedgeTimer = null;
      const p = pending; pending = [];
      if (p.length && !committed && !finished) { stats.hedged++; p.forEach(([m, i]) => launch(m, i)); }
    };
    const fallback = () => {
      stats.fallbacks++;
      log(`závod: všech ${tried.length} modelů selhalo → dotaz na celé combo ${body.model}`, { combo: body.model, tried });
      committed = { fallback: true }; clearTimeout(graceTimer);
      if (tr) { tr.race = raceInfo(null, { fallback: true }); tr.runners = runnersInfo(null); }
      forward(req, res, JSON.stringify(body), tr, true);
    };
    // průběh závodu do úplného záznamu: kdo běžel, kdy začal / skončil, proč vypadl, co stihl napsat poražený
    const raceInfo = (w, extra = {}) => ({ n, pool, tried: [...tried], winner: w?.model || null, rank: w ? w.rank : null, ...extra });
    const runnersInfo = (w) => runners.map((r) => {
      const part = r === w ? null : assemble(r.events.map(parseData).filter(Boolean));
      return { model: r.model, rank: r.rank, startMs: r.tStart - t0, ttftMs: r.tFirst ? r.tFirst - t0 : null, endMs: r.tEnd ? r.tEnd - t0 : null,
        status: r.status, why: r.why, aborted: r.aborted, won: r === w,
        ...(part && (part.text || part.reasoning || part.toolCalls.length) ? { partial: { text: part.text.slice(0, 1500), reasoning: part.reasoning.slice(0, 1500), toolCalls: part.toolCalls.map((x) => x.name) } } : {}) };
    });
    const done = (w, extra) => {
      if (!tr) return;
      tr.race = raceInfo(w, extra.race || {});
      const resp = w ? assemble(w.events.map(parseData).filter(Boolean)) : null;
      finishTrace(tr, { runners: runnersInfo(w), response: resp, ttftMs: w?.tFirst ? w.tFirst - t0 : null, upstream: w ? { status: w.status, model: w.model } : null, ...(extra.error ? { error: extra.error } : {}) });
    };
    const commit = (w) => {
      if (committed || finished) return;
      committed = w; clearTimeout(graceTimer); clearTimeout(hedgeTimer); pending = [];
      cool.delete(w.model); lag.delete(w.model);
      if (w.tFirst) { const h = ttftHist.get(w.model) || []; h.push(w.tFirst - w.tStart); if (h.length > 10) h.shift(); ttftHist.set(w.model, h); }
      if (conv && STICKY) {
        sticky.delete(conv); sticky.set(conv, { model: w.model, at: Date.now() });
        if (sticky.size > STICKY_MAX) sticky.delete(sticky.keys().next().value);
      }
      for (const r of runners) {
        if (r === w || r.rank > w.rank || r.failed || emitted.has(r)) continue;
        const l = lag.get(r.model) || { n: 0, until: 0 };
        l.n++;
        if (l.n >= LAG_AFTER) { l.n = 0; l.until = Date.now() + LAG_MS; log(`závod: ${r.model} ${LAG_AFTER}× za sebou nezačal včas → ${LAG_MS / 60000} min mezi náhradníky`, { model: r.model }); }
        lag.set(r.model, l);
      }
      for (const r of runners) if (r !== w) { r.abort(); setRunner(tr, r.model, r.rank, 'zrušen'); }
      setRunner(tr, w.model, w.rank, 'vyhrál'); { const a = tr && active.get(tr.id); if (a) a.winner = w.model; }
      stats.races++; stats.won[w.model] = (stats.won[w.model] || 0) + 1;
      const ms = Date.now() - t0;
      stats.lastMs.push(ms); if (stats.lastMs.length > 50) stats.lastMs.shift();
      stats.last = { combo: body.model, winner: w.model, rank: w.rank, ms, at: Date.now(), candidates: [...tried] };
      log(`závod ${tried.length} modelů: vyhrál ${w.model} (${w.rank + 1}. v pořadí) za ${ms} ms, spuštěno ${runners.length}`, { winner: w.model, rank: w.rank, ms, candidates: [...tried], runners: runners.length });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-czek-race-winner': w.model });
      for (const ev of w.events) res.write(ev);
      let stall = null;
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          if (finished) return;
          finished = true; stats.stalls++;
          cool.set(w.model, Date.now() + COOL_HANG_MS);
          log(`závod: vítěz ${w.model} ${STALL / 1000} s neposlal data → ukončeno chybou, model na pauze`, { model: w.model });
          w.abort();
          const err = { error: { message: `czek-ai: model ${w.model} přestal odpovídat (${STALL / 1000} s bez dat)`, type: 'stream_stalled', code: 'stream_stalled' } };
          try { res.end('data: ' + JSON.stringify(err) + '\n\n'); } catch {}
          done(w, { race: { stalled: true }, error: err.error.message });
        }, STALL);
      };
      arm();
      w.onEvent = (ev) => { if (/^data:/m.test(ev)) arm(); try { res.write(ev); } catch {} };
      w.onEnd = () => { clearTimeout(stall); if (finished) return; finished = true; try { res.end(); } catch {} done(w, {}); };
      if (w.isEnded()) w.onEnd();
    };
    const best = () => runners.filter((r) => emitted.has(r) && !r.errored).sort((a, b) => a.rank - b.rank)[0];
    // Po každé změně (někdo začal odpovídat / vypadl / spadl): nejlepší odpovídající vyhraje hned, když žádný výš
    // postavený už nemůže začít; jinak dostanou výš postavení GRACE ms. Nikdo neodpovídá a nikdo nečeká → combo.
    const decide = () => {
      if (committed || finished) return;
      const b = best();
      const waiting = runners.filter((x) => !x.failed && !emitted.has(x));
      if (b) {
        if (!waiting.some((x) => x.rank < b.rank)) return commit(b);
        if (!graceTimer) graceTimer = setTimeout(() => { graceTimer = null; const b2 = best(); if (b2) commit(b2); else decide(); }, GRACE);
        return;
      }
      if (!waiting.length) { if (pending.length) launchPending(); else fallback(); }
    };
    const cb = {
      onOutput: (r) => { emitted.add(r); setRunner(tr, r.model, r.rank, 'odpovídá'); decide(); },
      onFail: (r, why) => {
        cool.set(r.model, Date.now() + coolFor(why, r.resetMs));
        setRunner(tr, r.model, r.rank, 'vypadl: ' + String(why).slice(0, 80));
        log(`závod: ${r.model} vypadl (${why})`, { model: r.model, why });
        // vedoucí vypadl dřív, než přišel čas na další závodníky → startují hned (nečekat na HEDGE)
        if (!committed && !finished && !emitted.size && pending.length) launchPending();
        if (!committed && !finished && !emitted.size && reserve.length) {
          const m = reserve.shift(); tried.push(m);
          log(`závod: místo ${r.model} nastupuje ${m}`, { model: m, replaces: r.model });
          launch(m, pool.indexOf(m));
        }
        decide();
      },
      onBroken: (r) => { cool.set(r.model, Date.now() + COOL_ERROR_MS); log(`závod: ${r.model} přerušil odpověď`, { model: r.model }); decide(); },
    };
    const hedge = n >= 2 ? hedgeFor(pool[0]) : 0;
    if (hedge > 0) {
      launch(pool[0], 0);
      pending = pool.slice(1, n).map((m, j) => [m, j + 1]);
      hedgeTimer = setTimeout(launchPending, hedge);
    } else pool.slice(0, n).forEach((m, i) => launch(m, i));
    res.on('close', () => {
      clearTimeout(hedgeTimer); pending = [];
      if (finished || committed?.fallback) return;
      for (const r of runners) r.abort();
      finished = true;
      done(committed && !committed.fallback ? committed : null, { error: 'zrušeno klientem (OpenCode)' });
    });
  };

  const imageCache = new Map(); // otisk obrázku → text, který ho ve zprávách nahradí
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    // vidění pro nástroj look (czek-guard): { images: [data URL], prompt } → { text, model }
    if (req.method === 'POST' && req.url.startsWith('/czek/vision')) {
      const ps = []; req.on('data', (c) => ps.push(c));
      req.on('end', async () => {
        if (!o.vision) return json(res, 501, { error: 'vidění není k dispozici' });
        try {
          const b = JSON.parse(Buffer.concat(ps).toString('utf8') || '{}');
          const imgs = (Array.isArray(b.images) ? b.images : []).filter((x) => typeof x === 'string' && x.startsWith('data:image/'));
          if (!imgs.length) return json(res, 400, { error: 'chybí obrázek (data:image/…)' });
          const r = await o.vision(imgs, String(b.prompt || 'Describe this image precisely.'));
          log('vidění: popsal ' + r.model, { model: r.model, chars: (r.text || '').length });
          json(res, 200, r);
        } catch (e) { json(res, 502, { error: e.message }); }
      });
      return;
    }
    const isChat = req.method === 'POST' && /\/chat\/completions(\?|$)/.test(req.url);
    if (!isChat) return forward(req, res, null);
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      let raw = Buffer.concat(parts).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      // obrázky ve zprávách → soubor v projektu + popis od modelu s viděním (src/vision.js); modely tieru je nečtou
      if (body && o.vision && hasImages(body.messages)) {
        try {
          const k = await rewriteImages(body, { describe: o.vision, fallbackDir: o.imageDir || (() => require('os').tmpdir()), cache: imageCache, log: (m, d) => log('vidění: ' + m, d) });
          if (k) raw = JSON.stringify(body);
        } catch (e) { log('vidění: obrázky nejde zpracovat: ' + e.message); }
      }
      const n = Number(o.n()) || 0;
      // závodí jen krok agenta: stream + nástroje + tier/combo, pro který máme víc kandidátů
      const tools = body && Array.isArray(body.tools) && body.tools.length && body.tool_choice !== 'none';
      // kandidáti v pořadí combo bez nedávno vypadlých; prvních n závodí, další jsou náhradníci
      const cand = body && body.stream && tools && n >= 2 ? (o.candidates(String(body.model || ''), n + RESERVE, n) || []) : [];
      // cand.racers (OmniRoute.raceCandidates) = kolik prvních smí závodit (spolehliví); další jen náhradníci
      const k = Number.isInteger(cand.racers) ? cand.racers : cand.length;
      const racersOk = cand.slice(0, k).filter((m) => !cooling(m));
      const front = racersOk.filter((m) => !lagging(m));
      const reserveOk = [...racersOk.filter(lagging), ...cand.slice(k).filter((m) => !cooling(m))]; // mlčící až za ostatní
      let pool = [...front, ...reserveOk.filter((m) => !lagging(m)), ...reserveOk.filter(lagging)];
      // věrnost vítězi předchozího kroku téže konverzace: na první místo (jen když je mezi závodníky, nevypadl a nemlčí)
      const conv = STICKY && cand.length ? convKey(body) : null;
      const st = conv && sticky.get(conv);
      if (st && Date.now() - st.at > STICKY_MS) sticky.delete(conv);
      else if (st && front.includes(st.model) && front.indexOf(st.model) > 0) {
        pool = [st.model, ...pool.filter((m) => m !== st.model)];
        stats.sticky++;
      }
      const nRace = front.length ? Math.min(n, front.length) : Math.min(n, pool.length);
      const tr = o.onCall && body && typeof body === 'object' ? newTrace(req, body, !!tools) : null;
      if (pool.length < 2 || !o.target()) return forward(req, res, raw, tr, !!(body && Array.isArray(body.messages)));
      race(req, res, body, pool, nRace, tr, conv);
    });
  });
  return {
    server,
    stats,
    /** Právě běžící dotazy (pro monitor): [{ id, combo, kind, ms, runners, winner }] */
    active: () => [...active.values()].map((a) => ({ ...a, ms: Date.now() - a.t, runners: a.runners.map((r) => ({ ...r, ms: Date.now() - r.since })) })),
    cool,
    lag,
    // stálý port (adresa je v konfiguraci OpenCode – jiná adresa = změna konfigurace); obsazený → libovolný volný
    listen: (port = 0) => new Promise((resolve, reject) => {
      const done = () => resolve(`http://127.0.0.1:${server.address().port}`);
      server.once('error', (e) => {
        if (port && e.code === 'EADDRINUSE') { server.listen(0, '127.0.0.1', done); return; }
        reject(e);
      });
      server.listen(port, '127.0.0.1', done);
    }),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

module.exports = { friendlyNoQuota, createRaceProxy, meaningful, cooldownResetMs, GRACE_MS };
