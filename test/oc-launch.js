// Spouštění appky / dev serveru z nástroje bash na skutečném OpenCode s czek-guard (Windows, Git Bash).
// Bez guardu (změřeno 19. 11.): `cd X && npm run dev > log &` visí do limitu 120 s a OpenCode pak celý strom zabije.
// S guardem: nástroj vrátí do pár sekund, appka běží dál, výstup je v logu; před kopírováním (cp) guard appku
// spuštěnou v téže relaci ukončí, aby .exe nebyl zamčený.
'use strict';
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-oclaunch-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  env.CZEK_GUARD_LOG = path.join(base, 'guard.jsonl');
  const proj = x('proj');
  // „dev server“: běží 60 s, každou sekundu tep do souboru
  fs.writeFileSync(path.join(proj, 'app.js'), "const fs=require('fs');let n=0;console.log('DEV SERVER READY on http://localhost:5173');setInterval(()=>{fs.writeFileSync('beat.txt',String(++n));if(n>=60)process.exit(0);},1000);");
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'node app.js' } }));
  const projSh = proj.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
  // appka .exe (kopie node.exe jako FurryBee.exe + skript s tepem) spuštěná přesně jako živě 20. 11.: `& sleep 3; ps aux | grep`
  fs.copyFileSync(process.execPath, path.join(proj, 'FurryBee.exe'));
  fs.writeFileSync(path.join(proj, 'furry.js'), "const fs=require('fs');let n=0;console.log('FURRY UP');setInterval(()=>{fs.writeFileSync('beat2.txt',String(++n));if(n>=90)process.exit(0);},1000);");
  const CMDS = [`cd "${projSh}" && npm run dev > dev.log 2>&1 &`, `cd "${projSh}" && cp app.js app-copy.js`, `cd "${projSh}" && npm run build`,
    `cd "${projSh}" && ./FurryBee.exe furry.js 2>&1 &
sleep 3
ps aux | grep -i furrybee`, `cd "${projSh}" && cp furry.js furry-copy.js`];
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'node app.js', build: 'node -e "console.log(1)"' } }));
  let step = 0;
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!(j.tools || []).length) { res.end(ch({ role: 'assistant', content: 'T' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      const done = j.messages.filter((m) => m.role === 'tool').length;
      if (done < CMDS.length) {
        const args = JSON.stringify({ command: CMDS[done], description: 'step ' + done });
        res.end(ch({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + (++step), type: 'function', function: { name: 'bash', arguments: args } }] }, null) + ch({}, 'tool_calls') + 'data: [DONE]\n\n');
      } else res.end(ch({ role: 'assistant', content: 'done' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME; delete process.env.OPENCODE_CONFIG_DIR;
  const oc = require('../src/opencode');
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, fullAuto: true });
  env.PWD = proj;
  const port = 4562;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`; const q = '?directory=' + encodeURIComponent(proj);
  const beat = () => Number(fs.existsSync(path.join(proj, 'beat.txt')) ? fs.readFileSync(path.join(proj, 'beat.txt'), 'utf8') : 0);
  try {
    for (let i = 0; i < 160; i++) { try { if ((await fetch(u + '/')).status) break; } catch {} await wait(250); }
    const s = await (await fetch(u + '/session' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const t0 = Date.now();
    // sledovat tep během běhu: appka musí běžet po skončení 1. nástroje
    let aliveAfterLaunch = false;
    let alive2 = false;
    const beat2 = () => Number(fs.existsSync(path.join(proj, 'beat2.txt')) ? fs.readFileSync(path.join(proj, 'beat2.txt'), 'utf8') : 0);
    const watcher2 = (async () => { for (let i = 0; i < 400; i++) { await wait(500); const msgs = await (await fetch(u + `/session/${s.id}/message` + q)).json().catch(() => []); const tools = (Array.isArray(msgs) ? msgs : []).flatMap((m) => m.parts).filter((p) => p.type === 'tool'); if (tools.length >= 4 && tools[3].state?.status === 'completed' && !alive2) { const a = beat2(); await wait(2200); alive2 = beat2() > a; return; } } })();
    const watcher = (async () => { for (let i = 0; i < 120; i++) { await wait(500); const msgs = await (await fetch(u + `/session/${s.id}/message` + q)).json().catch(() => []); const tools = (Array.isArray(msgs) ? msgs : []).flatMap((m) => m.parts).filter((p) => p.type === 'tool'); if (tools.length >= 1 && tools[0].state?.status === 'completed' && !aliveAfterLaunch) { const a = beat(); await wait(2200); aliveAfterLaunch = beat() > a; } if (tools.length >= 2) return; } })();
    await fetch(u + `/session/${s.id}/message` + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'run the dev server, then copy app.js' }] }), signal: AbortSignal.timeout(200000) }).then((r) => r.text());
    await watcher; await watcher2;
    const wall = Date.now() - t0;
    const msgs = await (await fetch(u + `/session/${s.id}/message` + q)).json();
    const tools = msgs.flatMap((m) => m.parts).filter((p) => p.type === 'tool');
    const [t1, t2, , t4, t5] = tools;
    const d1 = (t1.state.time.end - t1.state.time.start) / 1000;
    const b1 = beat(); await wait(2500); const b2 = beat();
    const d4 = (t4.state.time.end - t4.state.time.start) / 1000;
    const c1 = beat2(); await wait(2500); const c2 = beat2();
    console.log(`  4) ${CMDS[3].replace(/\n/g, ' ⏎ ')}\n     nástroj ${d4.toFixed(1)} s (${t4.state.status}), appka běžela po návratu: ${alive2}; po cp tep ${c1}→${c2}`);
    assert.ok(t4.state.status === 'completed' && d4 < 25, 'exe launch with `& sleep 3; ps aux | grep` returns quickly (20. 11.: hung 120 s, 4×): ' + d4);
    assert.ok(alive2, 'the app keeps running after the tool returned');
    assert.strictEqual(c2, c1, 'app stopped before the next cp');
    assert.ok(t5.state.status === 'completed' && fs.existsSync(path.join(proj, 'furry-copy.js')), 'copy ran normally (not in the background)');
    assert.ok(!/czek-guard ran this long-running command/.test(t5.state.output), 'cp is not a launch');
    console.log(`  1) ${CMDS[0]}\n     nástroj ${d1.toFixed(1)} s, appka běžela po návratu: ${aliveAfterLaunch}; výstup: ${String(t1.state.output).replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log(`  2) ${CMDS[1]} → po kopírování tep ${b1}→${b2} (appka ukončená: ${b2 === b1})`);
    assert.ok(d1 < 25, 'launch returns quickly instead of waiting for the 120 s timeout: ' + d1);
    assert.ok(aliveAfterLaunch, 'the dev server keeps running after the tool returned');
    assert.ok(/DEV SERVER READY|běží na pozadí/.test(t1.state.output), 'tool output shows the background status / log tail');
    assert.ok(/czek-guard ran this long-running command in the background/.test(t1.state.output), 'note for the model');
    assert.strictEqual(b2, b1, 'app started in this session is stopped before cp (no locked .exe)');
    assert.ok(fs.existsSync(path.join(proj, 'app-copy.js')), 'the copy itself ran');
    const log = fs.readFileSync(env.CZEK_GUARD_LOG, 'utf8');
    assert.ok(/"kind":"background"/.test(log) && /"kind":"release"/.test(log), 'guard log: background + release');
    assert.ok(/"kind":"timeout"/.test(log), 'build dostal delší limit nástroje bash (10 min místo 120 s)');
    console.log(`oc-launch OK (dev server na pozadí za ${d1.toFixed(1)} s místo 120 s, běží dál; před cp ukončen; FurryBee.exe s ps | grep za ${d4.toFixed(1)} s místo visení; celý dotaz ${(wall / 1000).toFixed(1)} s)`);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    await wait(1500);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 300));
