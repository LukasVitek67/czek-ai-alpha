// Sebehodnotící report z úplného logu czek-ai (<userData>/logs/YYYY-MM-DD.jsonl).
// Čte logy po řádcích (readline, velké soubory nejsou celé v paměti), nic nespouští ani nestahuje.
// Zapíše jediný .md do outDir. Uvádí jen nálezy nad prahem, aby byl report signál, ne šum.
// Pozor: report jde číst jako vstup pro Clauda, proto chyby třídíme (výpadek sítě != mrtvý model).
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { KEY_RES } = require('./fullLog');

const DAY_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/; // guard.jsonl a jiné soubory přeskočit
// Prahy: pod nimi se nález nezobrazí.
const T = {
  modelMinCalls: 3, modelErrRate: 0.2, modelSlowMs: 60000,
  modelPersistMin: 5, persistShare: 0.6, offlineShare: 0.6,
  toolSlowMs: 30000, toolSlowCount: 3, toolNearKillMs: 110000, toolSaneMaxMs: 900000,
  editFails: 3, httpFails: 3, repeatCmd: 3, todoStreak: 5, guardType: 3,
  ipcTotal: 100, ipcHuge: 5000, noModelMin: 3,
  startMs: 90000, idleMs: 600000, compactMin: 1,
};
// Interní volání czek-ai (test připojení, synchronizace modelů): nejsou to chatové modely.
const INTERNAL = new Set(['connection-test', 'model-sync']);
// Text chyby, který značí výpadek sítě / DNS (PC offline), ne chybu modelu.
const OFFLINE_RE = /ENOTFOUND|getaddrinfo|fetch failed|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|socket hang up/i;
const AUTOCHECK_RE = /kontrola po editu|automatická kontrola/i; // informativní kontrola po editu, ne smyčka
const AFTER_EDIT_NOTE_RE = /poznámka modelu k (write|edit|multiedit)/i; // druhá půlka téže kontroly, nepočítá se zvlášť
const CLASS_LABEL = {
  'síť/offline': 'síť/offline',
  'přerušeno': 'přerušeno (poražený v závodě / zrušeno)',
  'rate-limit (denní)': 'rate-limit (denní limit vyčerpán, platí dočasně)',
  'přetížený': 'přetížený poskytovatel (dočasné)',
  'klíč/autorizace': 'klíč/autorizace',
  'jiná': 'jiná chyba',
};

// Maskování klíčů stejně jako fullLog.mask (KEY_RES); aplikuje se na celý výstup.
function mask(text) {
  let s = text;
  for (const re of KEY_RES) s = s.replace(re, (m) => m.slice(0, 6) + '***');
  return s;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const trim = (v, n = 160) => {
  const s = str(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '...' : s;
};
const fmtS = (ms) => (ms / 1000).toFixed(1) + ' s';
const fmtMin = (ms) => (ms / 60000).toFixed(1) + ' min';
const pct = (a, b) => Math.round((100 * a) / b) + ' %';
const numOr = (v, text, re) => {
  if (typeof v === 'number') return v;
  const m = re.exec(text);
  return m ? Number(m[1]) : 0;
};
// Součet všech čísel v objektu (ipc-repeats jsou počty).
function sumNum(o) {
  if (typeof o === 'number') return o;
  if (o && typeof o === 'object') return Object.values(o).reduce((a, v) => a + sumNum(v), 0);
  return 0;
}

// Třída chyby volání: výpadek sítě, denní limit, přetížení, klíč, jinak.
function classify(status, text) {
  const s = Number(status);
  if (OFFLINE_RE.test(text)) return 'síť/offline';
  // Přerušeno (status 0/499/„aborted") = poražený v závodě (Max tier střílí krok na víc modelů, prohrávající se zruší)
  // nebo zrušené volání. NENÍ to chyba modelu ani výpadek sítě — jinak by zdravý závod vypadal jako offline relace.
  if (/aborted|AbortError/i.test(text) || s === 0 || s === 499) return 'přerušeno';
  if (s === 429) return 'rate-limit (denní)';
  if (s === 503 || s === 529) return 'přetížený';
  if (s === 401 || s === 403) return 'klíč/autorizace';
  return 'jiná';
}

// Dominantní třída chyb modelu ('-' když žádná).
function domClass(cls) {
  let best = '-', n = 0;
  for (const [k, v] of cls) if (v > n) { best = k; n = v; }
  return best;
}

// Délka nástroje: z časů stavu, jinak z "(NNN ms)" v popisu.
function toolMs(d, msg) {
  const tm = d.part?.state?.time;
  if (tm && tm.start != null && tm.end != null) return tm.end - tm.start;
  const m = /\((\d+) ms\)/.exec(msg);
  return m ? Number(m[1]) : null;
}

// czek-guard obalí dlouhý příkaz: kill-preamble (`czek_kill() {…}` + smyčka přes *.pid) a běh na pozadí
// `( <skutečný příkaz> ) > log 2>&1 < /dev/null &` + čekací smyčka. V reportu chceme vidět ten skutečný příkaz,
// ne boilerplate (jinak se všechna spuštění tváří jako „bash czek_kill() {…").
function stripLaunchPreamble(cmd) {
  let c = String(cmd || '');
  // „(" musí být na začátku řádku (tak ho píše backgroundize), ať se regex nechytne na „czek_kill(" uprostřed řádku
  const bg = /(?:^|\n)\(\s*([\s\S]*?)\s*\)\s*>\s*\S+\s+2>&1\s*<\s*\/dev\/null\s*&/.exec(c);
  if (bg && bg[1].trim()) return bg[1].trim();
  if (/czek_kill\s*\(\)\s*\{/.test(c)) {
    const after = c.replace(/^[\s\S]*?\bdone\b[^\n]*\n?/, '').trim(); // za kill smyčkou (…; done)
    if (after) return after;
    return '(czek-guard: ukončení dřívější appky)';
  }
  return c;
}

function describeTool(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  let arg = i.command || i.filePath || i.pattern || i.path || i.url || i.description || JSON.stringify(i);
  if (tool === 'bash' && i.command) arg = stripLaunchPreamble(i.command);
  return trim(`${tool} ${arg}`, 140);
}

function newState() {
  return {
    days: [], sessions: new Set(), starts: [], pendingStart: null, gaps: [], activeDays: new Set(), curDay: '',
    steps: 0, stepMs: 0, stepMsN: 0, tokIn: 0, tokOut: 0, stepStart: new Map(),
    models: new Map(), internal: new Map(), http: new Map(), timeouts: [], noModelN: 0,
    tools: new Map(), slow: [], idleInflated: 0, invalid: new Map(), failEdits: [],
    guards: new Map(), autocheck: 0, bashRepeat: new Map(), todoRun: 0, todoMax: 0, ipc: 0, compactions: 0, outTrunc: 0,
  };
}

// Jeden záznam logu → agregace.
function ingest(rec, A) {
  const kind = String(rec.kind || '');
  const d = rec.data && typeof rec.data === 'object' ? rec.data : {};
  const p = d.part && typeof d.part === 'object' ? d.part : {};
  const msg = String(rec.msg || '');
  const t = Date.parse(rec.t) || 0;
  const sid = d.sessionID || p.sessionID || d.info?.sessionID;
  if (sid) A.sessions.add(String(sid));

  // Start → první odpověď modelu, párováno jen v rámci jednoho dne (část 6).
  if (kind === 'start') { A.starts.push(t); A.pendingStart = t; }
  const answer = kind === 'message-done' || kind === 'model-text' || kind === 'step-finish' || (kind === 'call' && Number(d.status) === 200);
  if (answer && A.curDay) {
    A.activeDays.add(A.curDay);
    if (A.pendingStart != null && t >= A.pendingStart) { A.gaps.push({ day: A.curDay, ms: t - A.pendingStart }); A.pendingStart = null; }
  }

  // Kroky: počet, tokeny, čas start→finish.
  if (kind === 'step-start') A.stepStart.set(p.messageID, t);
  if (kind === 'step-finish') {
    A.steps++;
    const tk = p.tokens || {};
    const reason = p.reason || (/důvod: (\w+)/.exec(msg) || [])[1];
    if (reason === 'length') A.outTrunc++; // výstup narazil na strop → odpověď modelu uříznutá
    A.tokIn += numOr(tk.input, msg, /vstup (\d+)/);
    A.tokOut += numOr(tk.output, msg, /výstup (\d+)/);
    const s0 = A.stepStart.get(p.messageID);
    if (s0 != null && t >= s0) { A.stepMs += t - s0; A.stepMsN++; }
    A.stepStart.delete(p.messageID);
  }

  // Přetečení kontextu: OpenCode zkrátil kontext (compaction) = relace se blíží limitu a ztrácí starší kontext.
  if (/kontext zkrácen \(compaction\)/.test(msg)) A.compactions++;

  // Volání OmniRoute: model, stav, délka, třída chyby. Interní volání jen počítáme.
  if (kind === 'call') {
    const model = String(d.model || d.requestedModel || '?');
    const status = Number(d.status);
    if (INTERNAL.has(model)) A.internal.set(model, (A.internal.get(model) || 0) + 1);
    else {
      const m = A.models.get(model) || { calls: 0, ok: 0, err: 0, n: 0, sumMs: 0, maxMs: 0, lastStatus: null, lastErr: '', cls: new Map() };
      A.models.set(model, m);
      m.calls++;
      let cls = null;
      if (status === 200) m.ok++;
      else {
        m.err++;
        cls = classify(status, msg + ' ' + str(d.error));
        m.cls.set(cls, (m.cls.get(cls) || 0) + 1);
        m.lastStatus = d.status ?? '?'; m.lastErr = trim(d.error || msg, 140);
      }
      if (typeof d.duration === 'number') { m.n++; m.sumMs += d.duration; m.maxMs = Math.max(m.maxMs, d.duration); }
      // do HTTP součtu jen trvalé chyby; výpadek sítě, limit a přetížení jsou dočasné (jsou v tabulce modelů)
      if (cls === 'jiná' || cls === 'klíč/autorizace') A.http.set(String(status), (A.http.get(String(status)) || 0) + 1);
    }
  }
  // timeout hlídače (bez modelů) je šum, ne skutečný timeout nástroje; souhrn kontroly zdraví vypisuje cizí timeouty
  // („… modelů 400, timeout“) a není to selhání žádného volání
  if (!/bez modelů|kontrola (zdraví|čela)/i.test(msg) && /timeout/i.test(msg + ' ' + str(d.error))) A.timeouts.push(trim(msg, 140));

  // Nástroje: součty, nejdelší volání, neexistující nástroje, opakování, smyčka todowrite.
  if (kind.startsWith('tool-')) {
    const tool = String(p.tool || '?');
    const st = p.state && typeof p.state === 'object' ? p.state : {};
    const term = kind === 'tool-completed' || kind === 'tool-error';
    if (term) {
      const inv = /unavailable tool '([^']+)'/.exec(JSON.stringify(st));
      if (inv) A.invalid.set(inv[1], (A.invalid.get(inv[1]) || 0) + 1);
      const cmd = tool === 'bash' ? stripLaunchPreamble(str(st.input && st.input.command)) : str(st.input && st.input.command);
      if (tool === 'bash' && cmd) A.bashRepeat.set(cmd, (A.bashRepeat.get(cmd) || 0) + 1);
      if (kind === 'tool-error' && (tool === 'edit' || tool === 'multiedit')) A.failEdits.push(trim(st.error || msg, 140));
      if (tool === 'todowrite') { A.todoRun++; A.todoMax = Math.max(A.todoMax, A.todoRun); } else A.todoRun = 0;
    }
    if (kind === 'tool-completed') {
      const ms = toolMs(d, msg);
      const tt = A.tools.get(tool) || { calls: 0, sumMs: 0 };
      tt.calls++;
      A.tools.set(tool, tt);
      if (ms != null) {
        // Nereálně dlouhý čas (nad strop) = skoro jistě uspání PC během běhu na pozadí, ne skutečný běh nástroje;
        // nepočítat do součtu ani mezi nejpomalejší (jinak falešné „volání >= 110 s" a nafouknutý součet).
        if (ms > T.toolSaneMaxMs) { A.idleInflated++; } else {
          tt.sumMs += ms;
          A.slow.push({ tool, ms, desc: describeTool(tool, st.input) });
          if (A.slow.length > 500) { A.slow.sort((a, b) => b.ms - a.ms); A.slow.length = 200; }
        }
      }
    }
  }

  // Rozhodnutí hlídače smyček (czek-guard). Init pluginu a automatická kontrola po editu nejsou smyčky.
  if (kind === 'guard') {
    const text = str(d.msg) || msg;
    if (AUTOCHECK_RE.test(text)) A.autocheck++;
    else if (!/plugin načten/i.test(text) && !AFTER_EDIT_NOTE_RE.test(text)) {
      const type = text.split(/[\s:(]/)[0] || 'jiné';
      const g = A.guards.get(type) || { n: 0, ex: '' };
      g.n++;
      if (!g.ex) g.ex = trim(text, 140);
      A.guards.set(type, g);
    }
  }
  if (kind === 'ipc-repeats') A.ipc += sumNum(d);
  // Hlídač střílí každých pár sekund → jen počet, ne jednotlivé řádky.
  if (/bez modelů|prázdn[ýé] výb|žádný model/i.test(msg)) A.noModelN++;
}

// Čte soubor po řádcích; rozbité řádky se přeskočí. Den se předává zvlášť (start se páruje jen v rámci dne).
async function scanFile(file, day, A) {
  A.curDay = day;
  A.pendingStart = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec && typeof rec === 'object') ingest(rec, A);
  }
}

// Sestaví Markdown: souhrn vždy, ostatní sekce jen s nálezem nebo poznámkou nad prahem.
function buildReport(A, now) {
  const secs = [];
  const actions = [];
  let findings = 0;
  const section = (title, summary = false) => { const s = { title, summary, body: [], flags: 0, notes: false }; secs.push(s); return s; };
  const flag = (s, text, action) => {
    s.body.push('- POZOR ' + text);
    s.flags++;
    findings++;
    if (action && !actions.includes(action)) actions.push(action);
  };
  const flagRaw = (s, line) => { s.body.push('- ' + line); s.flags++; findings++; };
  const note = (s, text) => { s.body.push('- ' + text); s.notes = true; }; // informativní, nepočítá se jako nález
  const info = (s, text) => s.body.push('- ' + text);

  // 1 Souhrn (vždy)
  const sum = section('1. Souhrn', true);
  const sessions = A.sessions.size || A.starts.length;
  info(sum, `dny: ${A.days.length} (${A.days.join(', ') || 'žádný log'})`);
  info(sum, `relace: ${sessions}`);
  info(sum, `kroků modelu: ${A.steps}`);
  info(sum, `čas modelu: ${A.stepMsN ? fmtMin(A.stepMs) + ' (součet start→finish, ' + A.stepMsN + ' kroků)' : 'N/A (chybí step-start)'}`);
  info(sum, `tokeny: vstup ${A.tokIn}, výstup ${A.tokOut}`);
  const internalTxt = [...A.internal].map(([k, n]) => `${k} ${n}×`).join(', ');
  if (internalTxt) info(sum, `interní volání czek-ai (ne chat, mimo tabulku modelů): ${internalTxt}`);

  // 2 Modely (bez interních volání)
  const mS = section('2. Modely');
  const mRows = [...A.models].map(([name, m]) => {
    const avg = m.n ? Math.round(m.sumMs / m.n) : null;
    const persist = (m.cls.get('jiná') || 0) + (m.cls.get('klíč/autorizace') || 0);
    const aborted = m.cls.get('přerušeno') || 0; // poražený v závodě / zrušeno — ne chyba modelu
    const realErr = m.err - aborted;
    const realCalls = m.calls - aborted;
    const clsReal = new Map([...m.cls].filter(([k]) => k !== 'přerušeno')); // přerušení není selhání modelu
    return {
      name, m, avg, aborted, realErr, realCalls, dom: domClass(m.cls), domReal: domClass(clsReal),
      // „bad" jen ze skutečných pokusů (bez přerušených v závodě) — jinak každý poražený v Max tieru vypadá chybově
      bad: realCalls >= T.modelMinCalls && realErr / realCalls > T.modelErrRate,
      slow: avg != null && avg > T.modelSlowMs,
      // trvalá chyba (jiná / klíč) → vyřadit; výpadek sítě a limity jsou dočasné
      dead: realErr >= T.modelPersistMin && persist / realErr >= T.persistShare,
    };
  });
  const errAll = mRows.reduce((a, r) => a + r.m.err, 0);
  const okAll = mRows.reduce((a, r) => a + r.m.ok, 0);
  const offAll = mRows.reduce((a, r) => a + (r.m.cls.get('síť/offline') || 0), 0);
  // Offline (PC bez sítě) jen když se skoro nic nepovedlo. Když úspěšných volání přibylo dost (okAll), PC bylo
  // online a síťové chyby jsou výpadky jednotlivých poskytovatelů — ty se mají ukázat, ne schovat pod „offline".
  const offline = offAll >= T.modelMinCalls && offAll / errAll >= T.offlineShare && okAll < T.modelMinCalls;
  if (offline) flagRaw(mS, 'POZOR: během relace byla nedostupná síť (ENOTFOUND / fetch failed) — selhání modelů níže jsou nejspíš tím, ne mrtvými modely; ověřit, až bude PC online.');
  if (mRows.length) {
    // tabulka vždy, když se volaly modely (užitečný kontext i bez „POZOR"); „!" jen u skutečně chybových/pomalých
    // „chyby" = skutečná selhání (bez závodních přerušení); „přeruš." = poražení v závodě / zrušeno zvlášť
    mS.body.push('| model | volání | OK | chyby | přeruš. | prům. | max | hlavní chyba |', '|---|---|---|---|---|---|---|---|');
    for (const r of mRows) mS.body.push(`| ${r.bad || r.slow ? '!' : ''}${r.name} | ${r.m.calls} | ${r.m.ok} | ${r.realErr} | ${r.aborted} | ${r.avg == null ? '-' : fmtS(r.avg)} | ${r.m.n ? fmtS(r.m.maxMs) : '-'} | ${r.domReal} |`);
    mS.notes = true; // ať se sekce vykreslí i u zdravé relace bez nálezu
    if (offline) {
      // Offline relace: vysokou chybovost/latenci modelu nejde odlišit od mrtvého modelu (upstream nedostupný,
      // ENOTFOUND, HTTP 502/503/0). Jednotlivé modely proto neuvádíme jako nálezy — jen souhrnná poznámka
      // (tabulka výše zůstává jako kontext). Jinak jedna offline dev-relace vyrobí desítky falešných „POZOR".
      const names = mRows.filter((r) => r.bad || r.slow).map((r) => r.name);
      if (names.length) note(mS, `${names.length} modelů mělo vysokou chybovost/latenci, ale relace byla offline — neuvádím jako nálezy (ověřit online): ${names.join(', ')}`);
    } else {
      for (const r of mRows) {
        const act = r.dead;
        if (r.bad) {
          const cause = r.domReal === '-' ? 'bez popisu' : CLASS_LABEL[r.domReal] || r.domReal;
          flag(mS, `${r.name}: ${r.realErr}/${r.realCalls} chyb (${pct(r.realErr, r.realCalls)}), převážně ${cause}; HTTP ${r.m.lastStatus}; příklad: ${r.m.lastErr || 'bez popisu'}`, act ? `vyřadit ${r.name} z combo` : null);
        }
        // jeden doporučený krok na model: pomalý model se nenavrhuje, když už jde k vyřazení
        if (r.slow) flag(mS, `${r.name}: průměr ${fmtS(r.avg)} (nad 60 s)`, act ? null : `zvážit pomalý model ${r.name}`);
      }
    }
  }

  // 3 Nástroje
  const tS = section('3. Nástroje');
  const sorted = [...A.slow].sort((a, b) => b.ms - a.ms);
  const near = sorted.filter((x) => x.ms >= T.toolNearKillMs);
  const over = sorted.filter((x) => x.ms >= T.toolSlowMs).length;
  if (near.length) flag(tS, `${near.length}× volání >= 110 s (bash umírá na 120 s); nejdelší ${fmtS(near[0].ms)}: ${near[0].desc}`, 'dlouhé příkazy (build, server) spouštět na pozadí nebo rozdělit');
  if (over >= T.toolSlowCount) flag(tS, `${over}× volání nad 30 s`, 'pomalé nástroje: zkrátit výstup nebo rozdělit práci');
  if (A.idleInflated) info(tS, `${A.idleInflated}× volání s nereálně dlouhým časem (> 15 min) vynecháno – nejspíš uspání PC během běhu na pozadí, ne skutečný běh nástroje`);
  for (const x of sorted.slice(0, 10)) info(tS, `${fmtS(x.ms)} ${x.desc}`);
  const byTool = [...A.tools].sort((a, b) => b[1].sumMs - a[1].sumMs).slice(0, 10);
  if (byTool.length) {
    tS.body.push('| nástroj | volání | celkem |', '|---|---|---|');
    for (const [name, v] of byTool) tS.body.push(`| ${name} | ${v.calls} | ${fmtMin(v.sumMs)} |`);
  }
  if (tS.body.length) tS.notes = true; // tabulka a nejpomalejší volání jsou užitečný kontext i bez „POZOR"

  // 4 Chyby
  const eS = section('4. Chyby');
  const inv = [...A.invalid];
  const invN = inv.reduce((a, [, n]) => a + n, 0);
  if (invN) flag(eS, `${invN}× neexistující nástroj: ${inv.map(([k, n]) => `'${k}' ${n}×`).join(', ')}`, `model volá neexistující nástroje (${inv.map(([k]) => k).join(', ')}): v promptu uvádět jen dostupné`);
  if (A.failEdits.length >= T.editFails) flag(eS, `${A.failEdits.length}× nepovedený edit; příklad: ${A.failEdits[0]}`, 'před editem načíst soubor, ať oldString sedí');
  const httpN = [...A.http.values()].reduce((a, n) => a + n, 0);
  if (httpN >= T.httpFails) flag(eS, `${httpN}× HTTP trvalá chyba (jiná / klíč; limity a výpadky viz Modely): ${[...A.http].map(([k, n]) => `${k} ${n}×`).join(', ')}`, 'zkontrolovat OmniRoute a záložní model');
  if (A.timeouts.length) flag(eS, `${A.timeouts.length}× timeout; příklad: ${A.timeouts[0]}`, 'dlouhé úkoly rozdělit nebo zvýšit timeout');

  // 5 Smyčky a plýtvání
  const lS = section('5. Smyčky a plýtvání');
  for (const [type, g] of A.guards) if (g.n >= T.guardType) flag(lS, `czek-guard ${type}: ${g.n}× (příklad: ${g.ex})`);
  const reps = [...A.bashRepeat].filter(([, n]) => n >= T.repeatCmd).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [cmd, n] of reps) flag(lS, `stejný bash ${n}×: ${trim(cmd, 120)}`, 'omezit opakování stejného bash příkazu');
  if (A.todoMax >= T.todoStreak) flag(lS, `todowrite ${A.todoMax}× za sebou`, 'todowrite jen na začátku a konci úkolu');
  if (A.autocheck) note(lS, `czek-guard automatická kontrola po editu (${A.autocheck}×)`);
  if (A.ipc > T.ipcHuge) flag(lS, `ipc-repeats součet ${A.ipc}`, 'omezit opakované IPC volání');
  else if (A.ipc >= T.ipcTotal) note(lS, `ipc-repeats součet ${A.ipc} (informativně)`);

  // 6 Start: jen poslední den s aktivitou modelu, jen start → první odpověď v tom dni
  const stS = section('6. Start');
  const lastDay = [...A.activeDays].sort().pop();
  const g = lastDay ? A.gaps.filter((x) => x.day === lastDay).pop() : null;
  if (g) {
    if (g.ms > T.idleMs) note(stS, `appka běžela nečinně, než se začalo pracovat (${fmtMin(g.ms)}, den ${g.day})`);
    else if (g.ms > T.startMs) flag(stS, `start → první odpověď modelu ${fmtS(g.ms)} (den ${g.day})`, 'zkrátit start (načítání modelů na pozadí)');
  }
  if (A.noModelN >= T.noModelMin) flag(stS, `hlídač ${A.noModelN}× hlásil 'bez modelů' (OmniRoute nedostupný nebo offline)`, offline ? null : 'zkontrolovat, že OmniRoute běží');

  // 7 Kontext: přetečení (compaction) a uříznutý výstup – reálné zhoršení modelu (ztráta kontextu, neúplná odpověď)
  const kS = section('7. Kontext');
  if (A.compactions >= T.compactMin) flag(kS, `${A.compactions}× kontext zkrácen (compaction) – relace se blíží limitu a ztrácí starší kontext`, 'u dlouhých úkolů rozdělit do kratších relací, nebo zvýšit práh kompakce / kontext modelu');
  if (A.outTrunc) flag(kS, `${A.outTrunc}× výstup modelu uříznut (důvod length) – odpověď se nevešla do limitu výstupu`, 'zvýšit limit výstupu modelu nebo chtít kratší odpovědi');

  const out = ['# Sebehodnotící report czek-ai', `Vygenerováno: ${now.toISOString()}`, ''];
  for (const s of secs) if (s.summary || s.flags || s.notes) out.push(`## ${s.title}`, ...s.body, '');
  if (findings) out.push('## Co z toho může Claude opravit', ...(actions.length ? actions.map((a) => '- ' + a) : ['- nic akčního']), '');
  else out.push('Bez zásadních nálezů.', '');
  return { md: out.join('\n'), sessions, findings };
}

/**
 * @param {{dir: string, days?: number, outDir: string, now?: Date}} opts
 * @returns {Promise<{file: string, days: number, sessions: number, steps: number, findings: number}>}
 */
async function generateReport(opts) {
  const { dir, outDir } = opts;
  if (!dir || !outDir) throw new Error('generateReport: chybí dir nebo outDir');
  const days = Math.max(1, opts.days ?? 2);
  const now = opts.now instanceof Date ? opts.now : new Date();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => DAY_RE.test(f)).sort(); } catch {}
  const pick = names.slice(-days); // nejnovější dny, chronologicky (YYYY-MM-DD řadí i řetězec)
  const A = newState();
  A.days = pick.map((n) => n.slice(0, 10));
  for (const f of pick) await scanFile(path.join(dir, f), f.slice(0, 10), A);
  const latest = A.days[A.days.length - 1] || now.toISOString().slice(0, 10);
  const r = buildReport(A, now);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, latest + '.md');
  fs.writeFileSync(file, mask(r.md), 'utf8');
  return { file, days: A.days.length, sessions: r.sessions, steps: A.steps, findings: r.findings };
}

module.exports = { generateReport };
