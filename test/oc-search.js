// Skutečný OpenCode + falešný model: czek-guard nahradí glob/grep verzemi, které přeskočí node_modules/target.
// Potřebuje rg.exe (guard ho hledá v XDG_DATA_HOME/opencode/bin) a balíček @opencode-ai/plugin, který se stáhne až při první session (~13 s); bez nich guard drží vestavěné nástroje.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const PORT = 4321;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trim = (s) => String(s).slice(0, 400);

// rg.exe: PATH, ~/.local/share/opencode/bin, copilot balík, zd-* temp (kopie z minulých běhů)
function findRg() {
  const cands = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'rg.exe'));
  cands.push(path.join(process.env.USERPROFILE || os.homedir(), '.local', 'share', 'opencode', 'bin', 'rg.exe'));
  const pkg = path.join(process.env.LOCALAPPDATA || '', 'copilot', 'pkg');
  try { for (const a of fs.readdirSync(pkg)) for (const v of fs.readdirSync(path.join(pkg, a))) cands.push(path.join(pkg, a, v, 'ripgrep', 'bin', 'win32-x64', 'rg.exe')); } catch {}
  try { for (const d of fs.readdirSync(os.tmpdir())) if (d.startsWith('zd-')) cands.push(path.join(os.tmpdir(), d, 'cache', 'opencode', 'bin', 'rg.exe')); } catch {}
  return cands.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

async function run(guard, rg) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-search-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  fs.mkdirSync(path.join(x('data'), 'opencode', 'bin'), { recursive: true });
  fs.copyFileSync(rg, path.join(base, 'data', 'opencode', 'bin', 'rg.exe'));
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const oc = require('../src/opencode');

  // projekt: dva skutečné soubory + 300 šumových v node_modules a target
  const proj = x('proj');
  const w = (rel, s) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  w('src/a.ts', 'export const a = "needle42";\n');
  w('src/b.ts', 'export const b = 1;\n');
  for (let i = 0; i < 300; i++) w(`node_modules/pkg/f${i}.ts`, 'export const v = "needle42";\n');
  w('target/x.ts', 'export {};\n');
  const pkgDir = path.join(proj, 'node_modules', 'pkg');

  // plán: jeden nástroj na krok, pak konec
  const call = (k, name, args) => ({ index: 0, id: 'call_' + k, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const plan = [
    [call(1, 'glob', { pattern: '**/*.ts' })],
    [call(2, 'grep', { pattern: 'needle42' })],
    [call(3, 'glob', { pattern: '**/*.ts', path: pkgDir })],
  ];
  const seen = [];
  let n = 0;
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      if (!(j.tools || []).length) { res.end(ch({ role: 'assistant', content: 'Title' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      seen.push(j);
      const calls = plan[n++];
      if (!calls) { res.end(ch({ role: 'assistant', content: 'Done.' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      res.end(ch({ role: 'assistant', tool_calls: calls }, null) + ch({}, 'tool_calls') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, agentTips: false, guard });

  // balíček pluginu, který OpenCode stahuje na pozadí při startu
  const plugPkg = path.join(env.XDG_CONFIG_HOME, 'opencode', 'node_modules', '@opencode-ai', 'plugin', 'package.json');
  const u = `http://127.0.0.1:${PORT}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  env.PWD = proj;

  // jeden start opencode serve + jedna zpráva; vrací výsledky nástrojů
  async function attempt() {
    const child = spawn(findOpencode(), ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
    try {
      for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await sleep(500); }
      // první požadavek na adresář spustí instanci; OpenCode při ní dotáhne balíček pluginu
      const s = await post('/session', {});
      if (guard) {
        const t = Date.now();
        while (!fs.existsSync(plugPkg) && Date.now() - t < 90000) await sleep(1000);
        console.log(`  plugin ${fs.existsSync(plugPkg) ? 'ok' : 'CHYBI'} (${Math.round((Date.now() - t) / 1000)} s čekání)`);
      }
      seen.length = 0; n = 0;
      const t0 = Date.now();
      await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'find the ts files and the needle' }] });
      const secs = (Date.now() - t0) / 1000;
      assert.ok(seen.length, 'model nedostal žádný požadavek s nástroji');
      const tool = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      return { tool, secs, names: seen[0].tools.map((t) => t.function.name) };
    } finally {
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
      await sleep(2000);
    }
  }

  try {
    let r = await attempt();
    let att = 1;
    // první start bez pluginu: krok 1 ještě ukáže node_modules → restart serve jednou
    if (guard && /node_modules/.test(r.tool[0] || '')) { console.log('  krok 1 obsahuje node_modules → restart serve'); r = await attempt(); att = 2; }
    return { ...r, att };
  } finally {
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

(async () => {
  const rg = findRg();
  if (!rg) { console.log('oc-search SKIP: rg.exe nenalezen (PATH, ~/.local/share/opencode/bin, copilot, zd-*)'); return; }
  console.log('guard: true (rg ' + rg + ')');
  const T = await run(true, rg);
  const [s1, s2, s3] = T.tool;
  assert.strictEqual(T.tool.length, 3, 'tři výsledky nástrojů, je ' + T.tool.length);
  assert.ok(T.names.includes('glob'), 'model vidí nástroj glob: ' + T.names.join(','));
  assert.ok(/a\.ts/.test(s1) && /b\.ts/.test(s1), 'krok 1 má a.ts i b.ts: ' + trim(s1));
  assert.ok(!/node_modules|target/.test(s1), 'krok 1 bez node_modules/target: ' + trim(s1));
  assert.ok(s2.startsWith('Found 1 matches') && /a\.ts/.test(s2), 'krok 2 = 1 shoda v a.ts: ' + trim(s2));
  assert.ok(/node_modules/.test(s3), 'krok 3 (výslovná cesta) vrací node_modules: ' + trim(s3));
  assert.ok(s3.includes('(Results are truncated'), 'krok 3 má poznámku o zkrácení: ' + trim(s3.slice(-300)));
  const guardFiles = (s1.match(/\.ts/g) || []).length;

  console.log('guard: false (jen výpis)');
  const F = await run(false, rg);
  const f1 = F.tool[0] || '';
  console.log(`  krok 1: node_modules ${/node_modules/.test(f1)}, a.ts ${/a\.ts/.test(f1)}, ${(f1.match(/\.ts/g) || []).length} řádků .ts`);

  console.log(`oc-search OK (guard: krok 1 ${guardFiles} .ts bez node_modules; krok 2 "Found 1 matches"; krok 3 přes node_modules + zkrácení; pokus ${T.att}; ${T.secs.toFixed(1)} s; bez guardu ${F.secs.toFixed(1)} s, krok 1 node_modules ${/node_modules/.test(f1)})`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
