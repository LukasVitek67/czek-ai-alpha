// Benchmark kvality: skutečné OpenCode staví malou aplikaci přes proxy Zdarmy, pak se výsledek ověří
// a vypíše se technický záznam proxy (bez obsahu zpráv).
// node test/bench-agent.js [tierlist=max] [poskytovatelé=ovh,llm7,kilo,pollinations] [timeout_min=12]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { PROVIDERS } = require('../src/providers');
const { ModelRegistry } = require('../src/agent');
const { createProxy, listen } = require('../src/proxy');
const tiers = require('../src/tiers');
const opencode = require('../src/opencode');

const tier = process.argv[2] || 'max';
const enabled = (process.argv[3] || 'ovh,llm7,kilo,pollinations').split(',');
const timeoutMin = Number(process.argv[4]) || 12;

// BENCH_TASK=web: webová aplikace ověřená ve skutečném (skrytém) okně – prázdná stránka, chyby JS, klikání
const WEB_TASK = `Vytvoř jednoduchou webovou aplikaci na úkoly bez knihoven a bez build kroku: index.html, style.css, app.js (otevírá se přímo jako soubor index.html).
- Pole pro text má id "new", tlačítko Přidat id "add", seznam úkolů je <ul id="list"> a každý úkol je <li> s textem úkolu.
- Kliknutí na tlačítko (nebo Enter v poli) přidá úkol na konec seznamu; prázdný text (i jen mezery) se nepřidá.
- Kliknutí na <li> přepne hotovo: <li> dostane/ztratí třídu "done" (přeškrtnutý text).
- Úkoly i stav hotovo se ukládají do localStorage a po obnovení stránky zůstanou.
Hezký, čistý vzhled. Zkontroluj, že app.js nemá syntaktické chyby (např. "node --check app.js"). Nakonec stručně napiš, co jsi udělal.`;
// BENCH_TASK=electron: desktopová aplikace (main + preload + renderer + IPC + soubor), ověřená skrytě
const ELECTRON_TASK = `Vytvoř desktopovou aplikaci Poznámky v Electronu (bez dalších knihoven, bez build kroku). Soubory: package.json ("main": "main.js", skript "start": "electron ."), main.js, preload.js, index.html, renderer.js, style.css.
- Bezpečně: contextIsolation: true, nodeIntegration: false. preload.js přes contextBridge vystaví window.notes = { list(), save(note), remove(id) }, každá funkce volá ipcRenderer.invoke a vrací Promise.
- main.js obslouží tato volání přes ipcMain.handle a poznámky ukládá do souboru notes.json ve složce app.getPath('userData') (poznámka = { id, title, body }).
- Okno: pole pro titulek <input id="title">, text <textarea id="body">, tlačítko Uložit id="save" a seznam <ul id="notes">. Každá poznámka je <li> s titulkem a tlačítkem s třídou "delete", které ji smaže.
- Uložit přidá poznámku do seznamu i do souboru; poznámka s prázdným titulkem (i jen mezery) se neuloží. Po spuštění se načtou uložené poznámky.
Aplikaci NESPOUŠTĚJ a nespouštěj npm install (prostředí nemá displej, Electron je k dispozici). Zkontroluj syntaxi všech .js souborů (node --check). Nakonec stručně napiš, co jsi udělal.`;
const TASK = process.env.BENCH_TASK === 'electron' ? ELECTRON_TASK : process.env.BENCH_TASK === 'web' ? WEB_TASK : `Vytvoř v Node.js (bez externích knihoven) jednoduchou konzolovou aplikaci na úkoly v souboru todo.js:
- "node todo.js add <text>" přidá úkol, "node todo.js list" vypíše úkoly jako "1. [ ] text" (hotové "[x]"), "node todo.js done <číslo>" označí úkol jako hotový.
- Úkoly ukládej do todo.json ve stejné složce.
Napiš i test.js (jen modul assert), který ověří přidání, výpis a označení hotového úkolu (test si před spuštěním smaže todo.json).
Spusť "node test.js" a oprav chyby, dokud test neprojde. Nakonec stručně napiš, co jsi udělal.`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-bench-'));
  const proj = path.join(root, 'app');
  const xdg = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d; };
  fs.mkdirSync(proj);
  // BENCH_GIT=1: vlastní git repozitář v projektu (jinak OpenCode vezme nejbližší nadřazený repozitář –
  // tady domovskou složku – jako celý projekt)
  if (process.env.BENCH_GIT) spawnSync('git', ['init', '-q'], { cwd: proj });
  const traceFile = path.join(root, 'trace.jsonl');
  const settings = { providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, { enabled: enabled.includes(p.id) }])), customProviders: [], favorites: [], fallback: true, preferFamilies: ['kimi', 'deepseek-v4', 'glm'], tiers: {} };
  const registry = new ModelRegistry(() => settings);
  // BENCH_OMNI=1: tierlisty směruje OmniRoute (vlastní DATA_DIR v dočasné složce)
  let engine = null;
  const server = createProxy({ registry, getSettings: () => settings, omni: () => engine, trace: (e) => fs.appendFileSync(traceFile, JSON.stringify(e) + '\n') });
  const port = await listen(server, 0);
  const { models } = await registry.list();
  if (process.env.BENCH_OMNI) {
    const { OmniRoute } = require('../src/omniroute');
    const eng = new OmniRoute({ dataDir: path.join(root, 'omniroute-data'), log: (l) => console.log('  [omniroute] ' + l) });
    process.on('exit', () => eng.stop()); // i při chybě – jinak zůstane viset
    await eng.start();
    await eng.sync({ registry, models, settings });
    engine = eng;
  }
  // PWD: OpenCode bere pracovní složku z PWD (zděděné z bashe), ne z cwd procesu
  // ELECTRON_RUN_AS_NODE: kdyby agent aplikaci přece spustil, neotevře se okno na ploše uživatele
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PWD: proj, XDG_CONFIG_HOME: xdg('config'), XDG_DATA_HOME: xdg('data'), XDG_STATE_HOME: xdg('state'), XDG_CACHE_HOME: path.join(os.tmpdir(), 'zdarma-bench-cache') };
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME; // ať opencode.js zapíše do izolované konfigurace
  opencode.writeConfig(port, models, { tiers: tiers.overview(models, settings, registry), onlyTiers: true });
  const order = tiers.order(tier, models, settings, registry).map((m) => m.key);
  console.log(`Tierlist ${tier}: ${order.length} modelů · prvních 6: ${order.slice(0, 6).join(', ')}`);
  console.log(`Složka: ${proj}`);

  const t0 = Date.now();
  const bin = path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  // průběžně: co proxy právě dělá (rozpracované požadavky)
  const watch = setInterval(() => {
    const cur = [...server.activity.current.values()].map((c) => `${c.model} ${Math.round((Date.now() - c.since) / 1000)}s`);
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] rozpracováno: ${cur.join(', ') || '—'} · hotovo požadavků: ${fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).length : 0}`);
  }, 20000);
  const logArgs = process.env.BENCH_LOGS ? ['--print-logs', '--log-level', 'INFO'] : [];
  const out = await new Promise((resolve) => {
    let text = '';
    const p = spawn(bin, ['run', ...logArgs, '-m', `zdarma/${tier}`, TASK], { cwd: proj, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); // stdin zavřený, jinak run čeká na vstup
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    const timer = setTimeout(() => { text += '\n[TIMEOUT]'; spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); }, timeoutMin * 60000);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
  clearInterval(watch);
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  server.close();
  if (process.env.BENCH_LOGS) fs.writeFileSync(path.join(root, 'opencode.log'), out.text);

  // ověření výsledku (vlastní kontrola, nezávislá na testu modelu)
  const run = (args) => spawnSync(process.execPath, args, { cwd: proj, encoding: 'utf8', timeout: 20000 });
  const files = fs.readdirSync(proj);
  let check = 'todo.js chybí';
  if (files.includes('todo.js')) {
    try { fs.rmSync(path.join(proj, 'todo.json'), { force: true }); } catch {}
    const a = run(['todo.js', 'add', 'koupit mléko']);
    const l1 = run(['todo.js', 'list']).stdout || '';
    run(['todo.js', 'done', '1']);
    const l2 = run(['todo.js', 'list']).stdout || '';
    const ok = /koupit mléko/.test(l1) && /\[ \]/.test(l1) && /\[x\]/i.test(l2);
    check = ok ? 'FUNGUJE (add/list/done)' : `NEFUNGUJE · add exit ${a.status} · list1="${l1.trim().slice(0, 60)}" · list2="${l2.trim().slice(0, 60)}"`;
  }
  const t = files.includes('test.js') ? run(['test.js']) : null;
  let web = null;
  if (process.env.BENCH_TASK === 'web' || process.env.BENCH_TASK === 'electron') {
    const isEl = process.env.BENCH_TASK === 'electron';
    const need = isEl ? 'package.json' : 'index.html';
    if (!files.includes(need)) web = { ok: false, steps: [[need + ' existuje', false]] };
    else {
      const electron = require('electron'); // cesta k binárce
      const venv = { ...process.env };
      delete venv.ELECTRON_RUN_AS_NODE;
      const args = isEl
        ? [path.join(__dirname, '..', 'tools', 'verify-electron.js'), proj, path.join(root, 'verify-userdata')]
        : [path.join(__dirname, '..', 'tools', 'verify-web.js'), proj];
      const v = spawnSync(electron, args, { encoding: 'utf8', timeout: 70000, windowsHide: true, env: venv });
      const line = String(v.stdout || '').split('\n').find((l) => l.startsWith('VERIFY '));
      web = line ? JSON.parse(line.slice(7)) : { ok: false, steps: [['ověření proběhlo', false]], errors: [String(v.stderr || '').slice(0, 300)] };
    }
  }
  if (engine) engine.stop();

  // rozbor záznamu proxy
  const tr = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const seq = tr.filter((r) => r.ok).map((r) => r.model);
  const switches = seq.filter((m, i) => i && m !== seq[i - 1]).length;
  const att = tr.flatMap((r) => r.attempts);
  const fails = {};
  for (const a of att.filter((x) => !x.ok)) fails[a.kind] = (fails[a.kind] || 0) + 1;
  const modelsUsed = {};
  for (const m of seq) modelsUsed[m] = (modelsUsed[m] || 0) + 1;
  console.log('\n=== výsledek');
  console.log(`OpenCode skončil: exit ${out.code} za ${mins} min${out.text.includes('[TIMEOUT]') ? ' (TIMEOUT)' : ''}`);
  console.log(`soubory: ${files.join(', ') || '(nic)'}`);
  if (web) {
    console.log(`${process.env.BENCH_TASK === 'electron' ? 'Electron' : 'webová'} aplikace: ${web.ok ? 'FUNGUJE' : 'NEFUNGUJE'} (${web.steps.filter((s) => s[1]).length}/${web.steps.length})`);
    for (const [name, ok] of web.steps) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (web.errors?.length) console.log(`  chyby: ${web.errors.slice(0, 3).join(' | ')}`);
    if (web.mainErrors?.length) console.log(`  chyby main: ${web.mainErrors.slice(0, 3).join(' | ')}`);
  } else {
    console.log(`aplikace: ${check}`);
    console.log(`test.js modelu: ${t ? (t.status === 0 ? 'projde' : `neprojde (exit ${t.status})`) : 'chybí'}`);
  }
  console.log('\n=== proxy');
  console.log(`požadavků ${tr.length} (úspěšných ${seq.length}, neúspěšných ${tr.filter((r) => !r.ok).length}) · přepnutí modelu mezi kroky: ${switches}`);
  console.log(`směrování: ${engine ? 'OmniRoute (combo zdarma-' + tier + ')' : 'vlastní proxy Zdarmy'}`);
  console.log(`modely: ${Object.entries(modelsUsed).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  console.log(`chyby pokusů: ${JSON.stringify(fails)}`);
  console.log(`finish=length: ${att.filter((a) => a.finish === 'length').length} · prázdné (jen uvažování): ${att.filter((a) => a.ok && !a.content && !a.toolCalls && a.reasoning).length} · nástroje s rozbitými argumenty: ${att.reduce((s, a) => s + (a.badArgs || 0), 0)} · textový režim: ${att.filter((a) => a.textMode).length}`);
  console.log(`max_tokens od OpenCode: ${[...new Set(tr.map((r) => r.maxTokensReq))].join(', ')} · vstup tokeny (odhad) max: ${Math.max(0, ...tr.map((r) => r.estTok))}`);
  console.log(`\nzáznam: ${traceFile}\nposlední výstup OpenCode:\n${out.text.trim().split('\n').slice(-12).join('\n')}`);
})().catch((e) => { console.error(e); process.exit(1); });
