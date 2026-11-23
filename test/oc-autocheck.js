// Skutečný OpenCode (izolované XDG) + skutečný cargo + falešný model:
//  1) krok se dvěma edity naráz → guard spustí `cargo check` JEDNOU, celý výsledek (zbývá 1 chyba) je u
//     posledního editu, u prvního jen věta;  2) další edit → „no errors“. Model nemusí spouštět kontrolu sám.
//  3) seznam úkolů: nástroj todowrite v požadavku na model není.
//  4) poskytovatelé s klíčem v OmniRoute (zai) jsou v OpenCode skrytí a zase vrácení.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-autocheck-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  const guardLog = path.join(base, 'guard.jsonl');
  env.CZEK_GUARD_LOG = guardLog;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const oc = require('../src/opencode');

  // 4) směrování přes OmniRoute (větev s pluginem OmniRoute; plugin falešný)
  const plug = x('fakeplugin');
  fs.writeFileSync(path.join(plug, 'package.json'), '{"name":"@omniroute/opencode-plugin","version":"0.0.1"}');
  fs.mkdirSync(path.join(plug, 'dist'));
  fs.writeFileSync(path.join(plug, 'dist', 'index.js'), 'export const X = async () => ({});\n');
  const omni = { omniUrl: 'http://127.0.0.1:1', omniKey: 'test-key', pluginSrc: plug, dcp: false, snapshotOff: true };
  fs.mkdirSync(path.dirname(oc.CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(oc.CONFIG_FILE(), JSON.stringify({ model: 'zai/glm-4.5-flash', disabled_providers: ['anthropic'] }));
  oc.writeConfig(0, [], { ...omni, routed: ['zai', 'groq'] });
  let cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
  assert.deepStrictEqual([...cfg.disabled_providers].sort(), ['anthropic', 'groq', 'opencode', 'zai']);
  assert.strictEqual(cfg.model, oc.DEFAULT_MODEL, 'model of a hidden provider reset');
  assert.strictEqual(cfg.tools?.todowrite, false, 'todowrite off');
  oc.writeConfig(0, [], { ...omni, routed: [], todo: true });
  cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
  assert.deepStrictEqual([...cfg.disabled_providers].sort(), ['anthropic', 'opencode'], 'own disabled kept, ours returned');
  assert.ok(cfg.tools?.todowrite === undefined, 'todowrite back');
  assert.strictEqual(cfg.tools?.omniroute_sync_models, false, 'omniroute_sync_models stays hidden from the agent');
  fs.rmSync(oc.CONFIG_FILE());

  // projekt v Rustu se dvěma chybami
  const proj = x('proj');
  fs.mkdirSync(path.join(proj, 'src'));
  fs.writeFileSync(path.join(proj, 'Cargo.toml'), '[package]\nname = "ac"\nversion = "0.1.0"\nedition = "2021"\n');
  const main = path.join(proj, 'src', 'main.rs');
  fs.writeFileSync(main, 'fn main() {\n    let a: u32 = "x";\n    let b: u32 = "y";\n    println!("{} {}", a, b);\n}\n');

  // model: krok 1 = dva edity naráz (oprava a + komentář), krok 2 = oprava b, pak konec
  const edit = (id, o, n) => ({ index: id, id: 'call_' + id + '_' + Math.random().toString(36).slice(2, 6), type: 'function', function: { name: 'edit', arguments: JSON.stringify({ filePath: main, oldString: o, newString: n }) } });
  let plan = [
    [edit(0, '    let a: u32 = "x";', '    let a: u32 = 1;'), edit(1, 'fn main() {', '// ac\nfn main() {')],
    [edit(0, '    let b: u32 = "y";', '    let b: u32 = 2;')],
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
      // položka plánu { text } = odpověď bez nástroje (konec kroku)
      if (!calls || calls.text) { res.end(ch({ role: 'assistant', content: calls?.text || 'Done.' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      res.end(ch({ role: 'assistant', tool_calls: calls }, null) + ch({}, 'tool_calls') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  // plný automatický režim: jeho permission nesmí todowrite vrátit
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, fullAuto: true });
  assert.ok(fs.existsSync(path.join(oc.GUARD_DIR(), 'autocheck.mjs')), 'autocheck.mjs installed with the guard');

  env.PWD = proj;
  const port = 4315;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    const t0 = Date.now();
    await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'fix the build' }] });
    const secs = Math.round((Date.now() - t0) / 1000);
    const names = seen[0].tools.map((t) => t.function.name);
    assert.ok(!names.includes('todowrite'), 'todowrite not offered: ' + names.join(','));
    const tool = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    assert.strictEqual(tool.length, 3, 'three edit results');
    const step1 = tool.slice(0, 2);
    const full = step1.find((t) => /error remains/.test(t));
    assert.ok(full, 'one of the two parallel edits carries the check result: ' + step1.map((t) => t.slice(-300)).join(' || '));
    assert.match(full, /E0308|mismatched types/, 'the remaining error is listed');
    // plná hláška rustc (ukázka kódu, popisek), ne jen jednořádkový tvar
    assert.match(full, /Full compiler message/, 'full compiler message attached');
    assert.match(full, /let b: u32 = "y";/, 'source snippet in the message: ' + full.slice(-600));
    assert.match(full, /expected `u32`, found `&str`/, 'rustc label in the message');
    assert.ok(step1.some((t) => /checked this together/.test(t)), 'the other edit only has a short line');
    assert.match(tool[2], /no errors/, 'after the last fix: no errors — ' + tool[2].slice(-300));
    assert.strictEqual(fs.readFileSync(main, 'utf8').includes('let b: u32 = 2;'), true);

    // 5) model build rozbije a skončí („Stuck … Next: …“) → guard sám pošle pokračování, model opraví
    //    (živě 20. 11.: relace stála od 1:39 do rána s nepřeložitelným projektem)
    plan = [
      [edit(0, '    let b: u32 = 2;', '    let b: u32 = "z";')],
      { text: 'Building the app. Currently stuck on 1 type error in main.rs. Next: fix the type.' },
      [edit(0, '    let b: u32 = "z";', '    let b: u32 = 3;')],
      { text: 'Done, it compiles.' },
    ];
    n = 0; seen.length = 0;
    const s2 = await post('/session', {});
    await post(`/session/${s2.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'change b' }] });
    for (let i = 0; i < 60 && n < 4; i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 1500));
    const lastUser = (j) => { const m = [...j.messages].reverse().find((x) => x.role === 'user'); return m ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : ''; };
    const cont = seen.map(lastUser).filter((t) => /does not compile/.test(t));
    const glines = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l)) : [];
    const gl = glines.filter((e) => /continue|autocheck/.test(e.kind)).map((e) => e.kind + ': ' + String(e.msg).slice(0, 160));
    assert.ok(cont.length >= 1, 'guard sent a continue after the stop with a broken build: ' + seen.map(lastUser).map((t) => t.slice(0, 80)).join(' | ') + ' || ' + gl.join(' || '));
    assert.match(cont[0], /reported 1 error\b/, 'continue says how many errors remain');
    assert.strictEqual(fs.readFileSync(main, 'utf8').includes('let b: u32 = 3;'), true, 'model fixed it after the continue');
    assert.strictEqual(n, 4, 'no further continue after a clean build (Done.)');
    console.log(`oc-autocheck OK (2 edity naráz → 1× cargo check, zbývá 1 chyba s plnou hláškou rustc; po opravě bez chyb; konec s rozbitým buildem → guard pokračuje; todowrite není; zai přes OmniRoute; ${secs} s)`);
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
