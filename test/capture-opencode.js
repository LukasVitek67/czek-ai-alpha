// Diagnostika: co přesně OpenCode posílá modelu a co se vrací. Nahrávací proxy mezi izolovaným OpenCode
// a skutečným modelem (výchozí Kilo Nemotron 3 Ultra, bez klíče). Zapisuje parametry požadavku (ne obsah
// zpráv kromě délky a začátku systémového promptu) a souhrn odpovědi: uvažování, text, nástroje, finish, čas.
// node test/capture-opencode.js [úkol=electron|todo] [timeout_min=10]
//   CAPTURE_UPSTREAM=url  CAPTURE_MODEL=id  CAPTURE_PATCH='{"temperature":1}'  (úprava požadavku pro pokus)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const opencode = require('../src/opencode');
const tiers = require('../src/tiers');

const task = process.argv[2] || 'electron';
const timeoutMin = Number(process.argv[3]) || 10;
const UP = process.env.CAPTURE_UPSTREAM || 'https://api.kilo.ai/api/gateway/chat/completions';
const MODEL = process.env.CAPTURE_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const PATCH = process.env.CAPTURE_PATCH ? JSON.parse(process.env.CAPTURE_PATCH) : null;

const TASKS = {
  todo: 'Vytvoř v Node.js soubor todo.js: "node todo.js add <text>", "node todo.js list" (výpis "1. [ ] text", hotové "[x]"), "node todo.js done <číslo>"; ukládání do todo.json. Napiš test.js (assert), spusť ho a oprav chyby.',
  electron: fs.readFileSync(path.join(__dirname, 'bench-agent.js'), 'utf8').match(/const ELECTRON_TASK = `([\s\S]*?)`;/)[1],
  // oprava chyb v existujícím projektu o víc souborech (typ práce, na který si uživatel stěžuje)
  bugfix: 'V tomhle projektu neprocházejí testy (npm test). Najdi a oprav chyby ve zdrojácích ve složce src/ tak, aby prošly všechny testy. Testy (složka test/) neměň. Na konci spusť npm test a ověř, že vše prochází.',
  // jako uživatel 8. 11. (lossless-player): Svelte 5 + Vite, nesestaví se a pak je okno prázdné
  // (špatná cesta importu, $state v obyčejném .js, nedeklarovaný handler, undefined.toUpperCase)
  blankapp: "the app doesnt work, there is no ui, just a blank black window. Fix it. It's supposed to be a music player like musicbee (Svelte 5 + Vite, npm run build).",
};
// node_modules pro blankapp se kopírují (ne odkaz – agent by mohl měnit balíčky jiného projektu)
const BLANK_NODE_MODULES = process.env.BENCH_NODE_MODULES || path.join(os.homedir(), 'Documents', 'Claude code', 'lossless-player', 'node_modules');
const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const f of fs.readdirSync(a, { withFileTypes: true })) { if (f.isDirectory()) copyDir(path.join(a, f.name), path.join(b, f.name)); else fs.copyFileSync(path.join(a, f.name), path.join(b, f.name)); } };
const hashDir = (d) => require('crypto').createHash('sha256').update(fs.readdirSync(d).sort().map((f) => f + fs.readFileSync(path.join(d, f), 'utf8')).join('|')).digest('hex');

(async () => {
  // plná cesta: Vite/Rollup neumí zkrácenou 8.3 cestu s „~“ (C:\Users\STUDEN~1 → „STUDEN%7E1“, build selže)
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-capture-')));
  const proj = path.join(root, 'app');
  fs.mkdirSync(proj);
  let testHash = null;
  if (task === 'bugfix') { copyDir(path.join(__dirname, 'fixtures', 'bugfix'), proj); testHash = hashDir(path.join(proj, 'test')); }
  if (task === 'blankapp') { copyDir(path.join(__dirname, 'fixtures', 'blankapp'), proj); fs.cpSync(BLANK_NODE_MODULES, path.join(proj, 'node_modules'), { recursive: true }); }
  const log = path.join(root, 'capture.jsonl');
  const xdg = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d; };
  let n = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'max', object: 'model' }] })); }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const id = ++n;
    const t0 = Date.now();
    const sys = (body.messages || []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const params = Object.fromEntries(Object.entries(body).filter(([k]) => !['messages', 'tools'].includes(k)));
    const reqInfo = { id, params, msgs: body.messages?.length, roles: (body.messages || []).map((m) => m.role[0]).join(''), sysLen: sys.length, sysHead: id === 1 ? sys.slice(0, 600) : undefined, tools: (body.tools || []).map((t) => t.function?.name), estTok: Math.round(raw.length / 3.5) };
    const up = { ...body, model: MODEL, ...(PATCH || {}) };
    let rs = 0, content = 0, calls = 0, finish = null, usage = null, ttft = null, chunks = 0, sample = '';
    try {
      const r = await fetch(UP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(up) });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'text/event-stream' });
      const dec = new TextDecoder();
      let buf = '';
      for await (const part of r.body) {
        res.write(part);
        buf += dec.decode(part, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d === '[DONE]') continue;
          try {
            const o = JSON.parse(d);
            if (o.usage) usage = o.usage;
            for (const c of o.choices || []) {
              const dl = c.delta || c.message || {};
              const r1 = dl.reasoning_content ?? dl.reasoning;
              if (typeof r1 === 'string' && r1) { rs += r1.length; if (ttft == null) ttft = Date.now() - t0; }
              if (typeof dl.content === 'string' && dl.content) { content += dl.content.length; if (ttft == null) ttft = Date.now() - t0; if (sample.length < 160) sample += dl.content; }
              if (dl.tool_calls) { calls = Math.max(calls, ...dl.tool_calls.map((t) => (t.index ?? 0) + 1)); if (ttft == null) ttft = Date.now() - t0; }
              if (c.finish_reason) finish = c.finish_reason;
              chunks++;
            }
          } catch {}
        }
      }
      res.end();
      fs.appendFileSync(log, JSON.stringify({ ...reqInfo, status: r.status, ms: Date.now() - t0, ttft, reasoningChars: rs, contentChars: content, toolCalls: calls, finish, usage, chunks, sample }) + '\n');
    } catch (e) {
      fs.appendFileSync(log, JSON.stringify({ ...reqInfo, error: e.message }) + '\n');
      try { res.end(); } catch {}
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // konfigurace stejná jako ve Zdarmě (writeConfig), jen jediný model → capture proxy
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PWD: proj, XDG_CONFIG_HOME: xdg('config'), XDG_DATA_HOME: xdg('data'), XDG_STATE_HOME: xdg('state'), XDG_CACHE_HOME: path.join(os.tmpdir(), 'zdarma-bench-cache') };
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  const models = [{ key: 'kilo/' + MODEL, id: MODEL, provider: 'kilo', usable: true, tools: true, context: 262144 }];
  const settings = { tiers: {}, favorites: [], preferFamilies: [] };
  const reg = { autoOrder: (ms) => ms, isUncensored: () => false };
  const w = opencode.writeConfig(port, models, { tiers: tiers.overview(models, settings, reg), onlyTiers: true, snapshotOff: true });
  // CAPTURE_PROMPT=<soubor>: vlastní systémový prompt agenta build (pokus: jiný prompt než OpenCode volí sám)
  if (process.env.CAPTURE_PROMPT) {
    const c = JSON.parse(fs.readFileSync(w.file, 'utf8'));
    c.agent = { ...(c.agent || {}), build: { ...(c.agent?.build || {}), prompt: `{file:${path.resolve(process.env.CAPTURE_PROMPT).replace(/\\/g, '/')}}` } };
    fs.writeFileSync(w.file, JSON.stringify(c, null, 2));
  }
  // přibalené skills jako ve Zdarmě (app-debugging se skriptem cdp-console), CAPTURE_NOSKILLS=1 = bez nich
  if (!process.env.CAPTURE_NOSKILLS) require('../src/skills').sync({ bundleDir: path.join(__dirname, '..', 'skills'), targetDir: path.join(env.XDG_CONFIG_HOME, 'opencode', 'skills'), version: 'bench' });
  if (process.env.CAPTURE_NOTIPS) { const c = JSON.parse(fs.readFileSync(w.file, 'utf8')); delete c.instructions; fs.writeFileSync(w.file, JSON.stringify(c, null, 2)); }
  console.log('config:', w.file);
  const bin = path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const p = spawn(bin, ['run', '-m', 'zdarma/max', TASKS[task]], { cwd: proj, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', () => {}); p.stderr.on('data', () => {});
    const timer = setTimeout(() => spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }), timeoutMin * 60000);
    p.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  server.close();
  const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  console.log(`OpenCode exit ${code} za ${((Date.now() - t0) / 60000).toFixed(1)} min · požadavků ${rows.length} · soubory: ${fs.readdirSync(proj).join(', ')}`);
  if (task === 'bugfix') {
    const t = spawnSync(process.execPath, ['--test'], { cwd: proj, encoding: 'utf8', timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    const out = (t.stdout || '') + (t.stderr || '');
    const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? -1), total = Number(/ℹ tests (\d+)/.exec(out)?.[1] ?? -1);
    const untouched = hashDir(path.join(proj, 'test')) === testHash;
    console.log(`VÝSLEDEK bugfix: testy ${pass}/${total} · testy nezměněné: ${untouched ? 'ano' : 'NE (podvod)'} · tokeny vstup celkem ${rows.reduce((s, r) => s + (r.usage?.prompt_tokens || r.estTok || 0), 0)}`);
  }
  if (task === 'blankapp') {
    const b = spawnSync(process.execPath, [path.join(proj, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: proj, encoding: 'utf8', timeout: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    const built = b.status === 0;
    let page = '';
    if (built) page = spawnSync(process.execPath, [path.join(__dirname, '..', 'skills', 'app-debugging', 'scripts', 'cdp-console.cjs'), '--dist', path.join(proj, 'dist'), '3000'], { encoding: 'utf8', timeout: 90000 }).stdout || '';
    const text = Number(/visibleText=(\d+)/.exec(page)?.[1] || 0);
    const exc = (page.match(/EXCEPTION:/g) || []).length;
    const has = (s) => page.includes(s);
    // výpis TEXT je jen začátek stránky → všechny 3 skladby poznat podle „Library (3)“ v postranním panelu
    const all3 = has('Clair de Lune') && has('Library (3)');
    const ok = built && text > 0 && exc === 0 && all3;
    console.log(`VÝSLEDEK blankapp: ${ok ? 'OPRAVENO' : 'NEOPRAVENO'} · build ${built ? 'ok' : 'SELHAL'} · výjimky ${exc} · viditelný text ${text} · všechny 3 skladby ${all3 ? 'ano' : 'ne'} · požadavků ${rows.length}`);
    if (!ok) console.log(page.split('\n').slice(0, 8).join('\n') || (b.stdout + b.stderr).slice(-600));
  }
  if (rows[0]) {
    console.log('PARAMETRY 1. požadavku:', JSON.stringify(rows[0].params));
    console.log('nástroje:', rows[0].tools.join(','), '| systémový prompt', rows[0].sysLen, 'znaků');
    console.log('začátek systémového promptu:', JSON.stringify(rows[0].sysHead));
  }
  for (const r of rows) console.log(`#${r.id} ${r.roles?.slice(-6)} msgs=${r.msgs} ~${r.estTok}tok → ${r.status ?? r.error} ${r.ms}ms ttft=${r.ttft} reasoning=${r.reasoningChars} text=${r.contentChars} calls=${r.toolCalls} finish=${r.finish} out=${r.usage?.completion_tokens ?? '?'} ${r.params?.temperature !== undefined ? 'temp=' + r.params.temperature : ''} ${JSON.stringify((r.sample || '').slice(0, 80))}`);
  console.log('záznam:', log);
})().catch((e) => { console.error(e); process.exit(1); });
