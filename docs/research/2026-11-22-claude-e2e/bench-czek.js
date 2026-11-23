// End-to-end benchmark of czek-ai's OWN path on Linux (no Electron window): the same wiring as src/main.js startOmni():
// real OmniRoute 3.8.53 with the user's keys → tier combos (zdarma-max…) from czek-ai's sync/rebalance → race proxy
// (src/race.js) → OpenCode 1.19.5 with czek-ai's config (src/opencode.js writeConfig: OmniRoute plugin, guard, caveman,
// reviewer, limits) → the real coding task with hidden tests (test/fixtures/feature, 15 tests).
//
//   node bench-czek.js <outdir> [tier=zdarma-max] [feature|bugfix]
//   env: ZDARMA_OMNIROUTE_ROOT (default ~/.local/share/czek-bench/node_modules/omniroute), OPENCODE_BIN, BENCH_LIMIT_MIN (10),
//        BENCH_RACE (number of racers, default 2; 0/1 = race off), BENCH_KEEP=1 keeps the temp folder
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '../../..');
const [out, tierArg, fixtureArg] = process.argv.slice(2);
if (!out) { console.error('usage: node bench-czek.js <outdir> [tier] [feature|bugfix|project|session|repo]'); process.exit(2); }
const TIER = tierArg || 'zdarma-max';
const FIXTURE = ['bugfix', 'project', 'session', 'repo'].includes(fixtureArg) ? fixtureArg : 'feature';
// repo = větší projekt (27 souborů ve vrstvách) a úkol jako issue na GitHubu; část testů skrytá (test/fixtures/repo-hidden)
const TASK = FIXTURE === 'repo'
  ? 'V tomhle repozitáři vyřeš issue docs/ISSUE-42.md (pokuty za pozdní vrácení a chyba ve vyhledávání). Nejdřív si projdi strukturu projektu (README.md), dodrž jeho pravidla a styl. Nové testy test/fines.test.js musí projít a stávající testy se nesmí rozbít. Testy neměň. Na konci spusť npm test a ověř, že vše prochází.'
  : FIXTURE === 'project' || FIXTURE === 'session'
  ? 'Projekt znamky (README.md) je nedodělaný: chybí funkce ve více modulech, je v něm chyba a příkazová řádka neumí vše. Dodělej a oprav zdrojáky ve složce src/ přesně podle README.md tak, aby `npm test` prošel celý. Testy (složka test/) neměň. Na konci spusť npm test a ověř, že vše prochází.'
  : FIXTURE === 'feature'
  ? 'Moduly ve složce src/ jsou prázdné. Implementuj je podle README.md a testů ve složce test/ tak, aby `npm test` prošel celý. Testy neměň. Na konci spusť npm test a ověř, že vše prochází.'
  : 'V tomhle projektu neprocházejí testy (npm test). Najdi a oprav chyby ve zdrojácích ve složce src/ tak, aby prošly všechny testy. Testy (složka test/) neměň. Na konci spusť npm test a ověř, že vše prochází.';
// session = dlouhá relace: 3 zadání po sobě ve STEJNÉ konverzaci (projekt → nová funkce s novými testy → požadavek
// popsaný slovy, testy skryté až do vyhodnocení). test/fixtures/session/{stage2,hidden}, základ = test/fixtures/project.
const STAGES = FIXTURE === 'session' ? [
  { text: TASK },
  { tests: 'stage2', text: 'Učitelka chce dvě nové věci: (a) příkaz `stats <předmět>` – souhrn předmětu přes všechny žáky: počet známek, kolik je N, vážený průměr a rozložení známek 1–5 (funkce `subjectStats(store, předmět)` v src/report.js); (b) příkaz `remove-grade <id> <pořadí>` – smaže n-tou známku žáka (číslováno od 1 v pořadí přidání) a změnu uloží. Přesný formát výstupů je v novém testu test/stats.test.js. Testy neměň. Na konci spusť npm test a ověř, že vše prochází.' },
  { text: 'Učitelka hlásí: český Excel neotevře export správně, protože čeká středník. Udělej, aby `export ;` vytvořil CSV oddělené středníkem (a `csv(store, \';\')` v src/report.js); bez argumentu zůstane čárka. Buňky, které obsahují použitý oddělovač, uvozovky nebo nový řádek, dej do uvozovek. Jiný oddělovač než čárka nebo středník je chyba použití (code 2). Ověř to přes npm test.' },
] : [{ text: TASK }];
const LIMIT_MS = Number(process.env.BENCH_LIMIT_MIN || 10) * 60000;
process.env.ZDARMA_OMNIROUTE_ROOT ||= path.join(os.homedir(), '.local/share/czek-bench/node_modules/omniroute');
process.env.OPENCODE_BIN ||= path.join(os.homedir(), '.local/share/czek-bench/node_modules/opencode-linux-x64/bin/opencode');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const dbg = (m) => process.env.BENCH_DEBUG && console.error(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const f of fs.readdirSync(a, { withFileTypes: true })) { if (f.isDirectory()) copyDir(path.join(a, f.name), path.join(b, f.name)); else fs.copyFileSync(path.join(a, f.name), path.join(b, f.name)); } };
const hashDir = (d) => require('crypto').createHash('sha256').update(fs.readdirSync(d).sort().map((f) => f + fs.readFileSync(path.join(d, f), 'utf8')).join('|')).digest('hex');
const SECRET = /(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|hf_[A-Za-z0-9]{8,})/g;

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'czek-path-')));
  const x = (k) => { const d = path.join(root, k); fs.mkdirSync(d, { recursive: true }); return d; };
  // OpenCode config + data in a temp profile (never the user's real one)
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) process.env[k] = x(k.toLowerCase());
  delete process.env.OPENCODE_CONFIG_DIR;
  // the OmniRoute plugin reads its key from OPENCODE_DATA_DIR/auth.json, so pin it to the temp profile
  process.env.OPENCODE_DATA_DIR = path.join(process.env.XDG_DATA_HOME, 'opencode');
  const { PROVIDERS } = require(path.join(repo, 'src/providers'));
  const { ModelRegistry } = require(path.join(repo, 'src/agent'));
  const { OmniRoute, findPlugin } = require(path.join(repo, 'src/omniroute'));
  const { createRaceProxy } = require(path.join(repo, 'src/race'));
  const oc = require(path.join(repo, 'src/opencode'));
  const { serveEnv } = require(path.join(repo, 'src/opencodeServer'));

  const keys = JSON.parse(fs.readFileSync(path.join(repo, 'private/keys.json'), 'utf8')).providers;
  const settings = {
    // BENCH_NO_KEYS=1: a classmate right after install, without a single key (only keyless providers work)
    providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, keys[p.id] && process.env.BENCH_NO_KEYS !== '1' ? { enabled: true, key: keys[p.id] } : {}])),
    customProviders: [], favorites: [], model: 'auto', fallback: true, tiers: {}, router: 'omniroute',
    preferFamilies: ['kimi', 'deepseek-v4', 'glm'], ocOnlyTiers: true, ocFullAuto: true, lang: 'cs',
  };
  const registry = new ModelRegistry(() => settings);
  const res = { path: 'czek-ai (OmniRoute + race + plugin)', noKeys: process.env.BENCH_NO_KEYS === '1', tier: TIER, fixture: FIXTURE, race: Number(process.env.BENCH_RACE ?? 2), at: new Date().toISOString() };
  const logs = [];
  const eng = new OmniRoute({ dataDir: x('omniroute'), log: (l) => logs.push(String(l)) });
  let race = null, child = null;
  const cleanup = async () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch {} try { race?.close?.(); } catch {} try { eng.stop(); } catch {} await wait(1500); };
  try {
    const tStart = Date.now();
    const parts = {};
    const sec = (a) => Math.round((Date.now() - a) / 100) / 10;
    const PARALLEL = process.env.BENCH_PARALLEL === '1';   // 1 = OpenCode spawns while the OmniRoute sync still runs
    await eng.start(); parts.omnirouteStart = sec(tStart); dbg(`omniroute up at ${eng.url}`);
    const raceLog = [];
    race = createRaceProxy({ target: () => eng.url, candidates: (m, t, r) => { try { return eng.raceCandidates(m, t, r) || []; } catch { return []; } },
      n: () => res.race, log: (msg, data) => raceLog.push({ msg, data }), ...(process.env.BENCH_GRACE ? { graceMs: Number(process.env.BENCH_GRACE) } : {}) });
    const raceUrl = await race.listen(0); dbg(`race at ${raceUrl}`);

    // combos are needed only when OpenCode asks for providers, not before it starts: this can run in parallel
    const runOmniSync = async () => {
      let a = Date.now();
      const { models } = await registry.list(); parts.registryList = sec(a);
      dbg(`registry ${models.length} models, ${models.filter((m) => m.usable).length} usable`);
      a = Date.now();
      await eng.sync({ registry, models, settings, listMs: 0 }); parts.omniSync = sec(a); dbg('synced');
      const combosAfter = (await eng.api('GET', '/api/combos').catch(() => ({})))?.combos || [];
      res.combos = combosAfter.length;
      res.maxModels = combosAfter.find((c) => c.name === 'zdarma-max')?.models?.length || 0;
      dbg(`combos ${res.combos}, zdarma-max ${res.maxModels} models`);
      if (process.env.BENCH_DEBUG) for (const l of logs.slice(-6)) dbg('omni: ' + String(l).replace(SECRET, '***').slice(0, 300));
      a = Date.now();
      await eng.rebalance().catch((e) => dbg('rebalance: ' + e.message)); parts.rebalance = sec(a);
      if (typeof eng.probeHeads === 'function' && process.env.BENCH_PROBE !== '0') {   // like src/main.js startOmni (update 2)
        const pr = await eng.probeHeads().catch((e) => ({ error: e.message }));
        await eng.syncCooldowns?.().catch(() => {}); await eng.rebalance().catch(() => {});
        res.probe = pr.results ? Object.fromEntries(Object.entries(pr.results).filter(([, s]) => s !== 200)) : pr; dbg('probe ' + JSON.stringify(res.probe).slice(0, 300));
        parts.probeHeads = sec(a);
      }
      res.syncEndS = sec(tStart);
    };
    const writeOcConfig = async () => {   // needs only the OmniRoute url + key, not the sync results
      let a = Date.now();
      const apiKey = eng.apiKey || await eng.ensureKey().catch(() => null); parts.omniKey = sec(a);
      oc.writeConfig(0, [], { omniUrl: raceUrl, omniKey: apiKey, pluginSrc: findPlugin(), onlyTiers: true, fullAuto: true, snapshotOff: true,
        reviewer: process.env.BENCH_REVIEWER !== '0', caveman: true, cavemanSkill: path.join(repo, 'skills/caveman/SKILL.md'), sysInfo: null });
      parts.writeConfig = 0;
      // BENCH_OC_DEBUG: turn on the plugin's own startup diagnostics + info logging (measurement only)
      if (process.env.BENCH_OC_DEBUG) {
        const cfgFile = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
        try {
          const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
          const e = (c.plugin || []).find((p) => Array.isArray(p) && p[1]?.providerId === 'omniroute');
          if (e) e[1].features = { ...(e[1].features || {}), startupDebug: true, logLevel: 'info' };
          fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
        } catch (err) { dbg('oc debug patch failed: ' + err.message); }
      }
    };
    // the task project + OpenCode process
    const proj = path.join(root, 'app');
    copyDir(path.join(repo, 'test/fixtures', FIXTURE === 'session' ? 'project' : FIXTURE), proj);
    const placed = new Map();   // každý testovací soubor, který jsme do projektu dali → obsah (testy agent měnit nesmí)
    const placeTests = (dir) => { for (const f of fs.readdirSync(dir)) { fs.copyFileSync(path.join(dir, f), path.join(proj, 'test', f)); placed.set(f, fs.readFileSync(path.join(dir, f), 'utf8')); } };
    for (const f of fs.readdirSync(path.join(proj, 'test'))) placed.set(f, fs.readFileSync(path.join(proj, 'test', f), 'utf8'));
    const testHash = hashDir(path.join(proj, 'test'));
    const port = 4950 + Math.floor(Math.random() * 40);
    const base = `http://127.0.0.1:${port}`;
    const q = '?directory=' + encodeURIComponent(proj);
    const get = async (p, ms = 15000) => { try { return await (await fetch(base + p + q, { signal: AbortSignal.timeout(ms) })).json(); } catch { return null; } };
    const spawnOc = () => {
      const env = serveEnv({ ...process.env });
      child = spawn(process.env.OPENCODE_BIN, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const ocLog = [];
      const slurp = (s) => s.on('data', (b) => { const line = String(b).trim(); if (line) ocLog.push({ at: sec(tStart), line: line.replace(SECRET, 'KEY***').slice(0, 300) }); });
      slurp(child.stdout); slurp(child.stderr);
      return ocLog;
    };
    const waitUp = async () => { for (let i = 0; i < 240; i++) { try { if ((await fetch(base + '/', { signal: AbortSignal.timeout(3000) })).status) break; } catch {} await wait(250); } };
    // the plugin loads the catalog asynchronously: wait until the tier is offered (500 ms poll, logged)
    const waitTier = async () => {
      let offered = false; const polls = [];
      for (let i = 0; i < 240 && !offered; i++) {
        const t = Date.now(); const pv = await get('/config/providers', 30000);
        const p = pv?.providers?.find((x) => x.id === 'opencode-omniroute');
        polls.push({ at: sec(tStart), callMs: sec(t), models: p ? Object.keys(p.models || {}).length : 0, providers: pv?.providers?.length ?? 0 });
        offered = !!p?.models?.[TIER];
        if (!offered) await wait(500);
      }
      return { offered, polls };
    };
    let ocLog = []; let offered = false; let polls = [];
    if (PARALLEL) {
      // OpenCode starts while the combo sync is still running
      await writeOcConfig();
      let a = Date.now();
      ocLog = spawnOc();
      const syncJob = runOmniSync().catch((e) => dbg('sync: ' + e.message));
      await waitUp(); parts.ocSpawn = sec(a); a = Date.now();
      const r = await waitTier();
      offered = r.offered; polls = r.polls; parts.ocProviders = sec(a);
      res.offeredAt = sec(tStart);
      res.modelsAtReady = polls[0]?.models || 0;
      await syncJob;
      // is the catalog the plugin published during startup a cached snapshot, or does it refresh?
      const after = await get('/config/providers', 30000);
      const pa = after?.providers?.find((x) => x.id === 'opencode-omniroute');
      res.modelsAfterSync = pa ? Object.keys(pa.models || {}).length : 0;
      // cheap refresh: drop the per-directory instance (same trick as src/ocWatch.js) and re-read
      if (process.env.BENCH_TOPUP !== '0') {
        const tTopUp = Date.now();
        await fetch(base + '/instance/dispose' + q, { method: 'POST', signal: AbortSignal.timeout(20000) }).catch(() => {});
        const again = await get('/config/providers', 30000);
        const pb = again?.providers?.find((x) => x.id === 'opencode-omniroute');
        res.modelsAfterTopUp = pb ? Object.keys(pb.models || {}).length : 0;
        res.topUpMs = Math.round((Date.now() - tTopUp) / 100) / 10;
      }
    } else {
      await runOmniSync();
      await writeOcConfig();
      res.setupS = sec(tStart); res.setupParts = parts;
      ocLog = spawnOc();
      let a = Date.now();
      await waitUp(); parts.ocSpawn = sec(a); a = Date.now();
      const r = await waitTier();
      offered = r.offered; polls = r.polls; parts.ocProviders = sec(a);
    }
    res.parallel = PARALLEL; res.setupParts = parts; res.setupS = res.syncEndS;   // setup = OmniRoute combos ready
    res.modelsAtReady = res.modelsAtReady || polls[0]?.models || 0;
    res.readyS = sec(tStart);   // app start -> OpenCode offers the tier
    res.polls = { n: polls.length, firstCallMs: polls[0]?.callMs, lastCallMs: polls[polls.length - 1]?.callMs, sumCallMs: Math.round(polls.reduce((a, p) => a + p.callMs, 0) * 10) / 10 };
    res.ocLog = ocLog.filter((l) => /omniroute|catalog|plugin|provider/i.test(l.line)).slice(0, 40);
    res.pollTrajectory = polls.filter((_, i) => i % 20 === 0).map((p) => `${p.at}s ${p.models}m ${p.providers}p ${p.callMs}ms`);
    res.ocLogRaw = ocLog.slice(-12).map((l) => `${l.at}s ${l.line}`);
    if (process.env.BENCH_OC_DEBUG) {
      try { res.startupDiag = fs.readFileSync(path.join(process.env.OPENCODE_DATA_DIR, 'plugins', 'omniroute-startup-diagnostics.log'), 'utf8').replace(SECRET, 'KEY***').slice(0, 1200); } catch {}
    }
    if (!offered) throw new Error(`tier ${TIER} not offered by the OmniRoute plugin (${polls.length} polls)`);
    if (process.env.BENCH_SETUP_ONLY) { res.wallS = 0; res.steps = 0; }
    else {
    const model = { providerID: 'opencode-omniroute', modelID: TIER };
    const s = await (await fetch(base + '/session' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) })).json();
    const t1 = Date.now(); let timedOut = false;
    res.stages = [];
    for (const [k, stage] of STAGES.entries()) {
      if (stage.tests) placeTests(path.join(repo, 'test/fixtures', FIXTURE, stage.tests));
      const ts = Date.now(); let answered = false;
      const body = JSON.stringify({ model, parts: [{ type: 'text', text: stage.text }] });
      const req = require('http').request(base + `/session/${s.id}/message` + q, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => { r.resume(); r.on('end', () => { answered = true; }); });
      req.on('error', () => { answered = true; });
      req.end(body);
      let idleSeen = 0;
      while (!answered) {
        await wait(5000);
        if (Date.now() - t1 > LIMIT_MS) { timedOut = true; break; }
        const st = await get('/session/status'); const mine = st && st[s.id];
        if (mine && mine.type === 'retry') res.lastRetry = JSON.stringify(mine).replace(SECRET, '***').slice(0, 300);
        idleSeen = (!mine || mine.type === 'idle') && Date.now() - ts > 20000 ? idleSeen + 1 : 0;
        if (idleSeen >= 3) break;
      }
      req.destroy();
      res.stages.push({ stage: k + 1, wallS: Math.round((Date.now() - ts) / 100) / 10 });
      if (timedOut) break;
    }
    if (timedOut) await fetch(base + `/session/${s.id}/abort` + q, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
    res.wallS = Math.round((Date.now() - t1) / 100) / 10; res.timedOut = timedOut;
    const msgs = (await get(`/session/${s.id}/message`, 60000)) || [];
    const asst = msgs.filter((m) => m.info.role === 'assistant');
    const tools = asst.flatMap((m) => m.parts.filter((p) => p.type === 'tool'));
    const by = {}; for (const t of tools) by[t.tool] = (by[t.tool] || 0) + 1;
    res.steps = asst.length; res.tools = by; res.toolErrors = tools.filter((t) => t.state?.status === 'error').length;
    res.tokens = asst.reduce((a, m) => { const t = m.info.tokens || {}; a.in += t.input || 0; a.out += t.output || 0; a.reasoning += t.reasoning || 0; return a; }, { in: 0, out: 0, reasoning: 0 });
    res.errors = asst.filter((m) => m.info.error).map((m) => JSON.stringify(m.info.error).replace(SECRET, '***').slice(0, 220)).slice(0, 4);
    // which models actually answered (race winners)
    const won = {}; const wms = [];
    for (const e of raceLog) if (e.data?.winner) { won[e.data.winner] = (won[e.data.winner] || 0) + 1; if (Number.isFinite(e.data.ms)) wms.push(e.data.ms); }
    res.raceWinners = won; res.raceEvents = raceLog.length;
    // kolik dotazů na modely stál jeden krok (souběžný závod 2, odstupňovaný ~1): ze zápisu vítěze v logu závodu
    const runs = raceLog.filter((e) => e.data?.winner && Number.isFinite(e.data.runners)).map((e) => e.data.runners);
    if (runs.length) { res.raceCalls = runs.reduce((a, b) => a + b, 0); res.callsPerStep = Math.round(res.raceCalls / runs.length * 100) / 100; }
    res.hedge = process.env.ZDARMA_RACE_HEDGE_MS ?? 'auto';
    // how much of the wall time is spent waiting for the race winner (every agent step = one race)
    if (wms.length) {
      const s = wms.slice().sort((a, b) => a - b);
      res.raceMs = { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length), max: s[s.length - 1], sumS: Math.round(s.reduce((a, b) => a + b, 0) / 100) / 10 };
    }
    res.raceFailures = raceLog.filter((e) => /selhal|vypadl|fail/i.test(e.msg)).map((e) => String(e.msg).replace(SECRET, '***').slice(0, 160)).slice(0, 6);
    const changedTests = [...placed].filter(([f, c]) => { try { return fs.readFileSync(path.join(proj, 'test', f), 'utf8') !== c; } catch { return true; } }).map(([f]) => f);
    if (FIXTURE === 'session') placeTests(path.join(repo, 'test/fixtures/session/hidden'));   // skryté testy 3. zadání
    if (FIXTURE === 'repo') placeTests(path.join(repo, 'test/fixtures/repo-hidden'));   // skryté testy issue
    const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: proj, encoding: 'utf8', timeout: 120000 });
    const o = (t.stdout || '') + (t.stderr || '');
    res.testsPass = Number((/# pass (\d+)/.exec(o) || [])[1] || 0); res.testsFail = Number((/# fail (\d+)/.exec(o) || [])[1] || 0);
    res.failedTests = [...o.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((n) => !/\.js$|^test$/.test(n)).slice(0, 10);
    res.testsUntouched = ['session', 'repo'].includes(FIXTURE) ? !changedTests.length : hashDir(path.join(proj, 'test')) === testHash;
    if (changedTests.length) res.changedTests = changedTests;
    res.success = t.status === 0 && res.testsFail === 0 && res.testsPass > 0 && res.testsUntouched;
    // neúspěch: zdrojáky projektu a výstup testů vedle výsledku (ať jde dohledat, co přesně selhalo)
    if (!res.success) {
      const keep = path.join(out, `czek-${FIXTURE}-${TIER}${process.env.BENCH_TAG ? '-' + process.env.BENCH_TAG : ''}-failed`);
      try { copyDir(path.join(proj, 'src'), path.join(keep, 'src')); fs.writeFileSync(path.join(keep, 'tests.txt'), o.slice(-20000)); res.failedKept = path.relative(repo, keep); } catch {}
    }
    }
  } catch (e) { res.error = String(e.message || e).replace(SECRET, '***').slice(0, 300); res.omniLog = logs.slice(-8).map((l) => l.replace(SECRET, '***').slice(0, 200)); }
  await cleanup();
  const tag = process.env.BENCH_TAG ? `-${process.env.BENCH_TAG}` : '';
  fs.writeFileSync(path.join(out, `czek-${FIXTURE}-${TIER}${tag}.json`), JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ path: 'czek', tier: TIER, success: res.success, tests: `${res.testsPass}/${(res.testsPass || 0) + (res.testsFail || 0)}`, wallS: res.wallS, setupS: res.setupS, steps: res.steps, winners: res.raceWinners, error: res.error }));
  if (!process.env.BENCH_KEEP) fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
