// Pracovní postup czek-method + směrovač skills trvale zapnutý: skutečný OpenCode (izolované XDG) + falešný model.
// Postup a tabulka „úkol → skills“ musí přijít v systémovém promptu KAŽDÉHO dotazu, s method: false zmizet.
// Zároveň skills z tabulky (impeccable, ui-ux-pro-max, czek-debugging…) musí v OpenCode opravdu existovat.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const SKILL = path.join(__dirname, '..', 'skills', 'czek-method', 'SKILL.md');

async function run(oc, env, proj, port, upPort) {
  const seen = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      if ((j.tools || []).length) seen.push(j.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
      res.end(ch({ role: 'assistant', content: 'OK' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(upPort, '127.0.0.1', r));
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    for (const text of ['hi', 'second message']) await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text }] });
    return seen;
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    await new Promise((r) => setTimeout(r, 800));
  }
}

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-method-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');
  env.PWD = proj;
  const oc = require('../src/opencode');
  const upPort = 45000 + Math.floor(Math.random() * 1000);
  try {
    oc.writeConfig(upPort, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, caveman: false, method: true, methodSkill: SKILL });
    let cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
    assert.ok(cfg.instructions.includes(oc.METHOD_FILE()), 'method file in instructions');
    const on = await run(oc, env, proj, 4321, upPort);
    assert.ok(on.length >= 2, 'two agent requests: ' + on.length);
    for (const [i, sys] of on.entries()) {
      assert.match(sys, /How you work \(always on\)/, `request ${i + 1}: method in system prompt`);
      assert.match(sys, /Skill router – load these automatically/, `request ${i + 1}: skill router in system prompt`);
      assert.match(sys, /`czek-frontend`, `impeccable`, `ui-ux-pro-max`/, `request ${i + 1}: design skills routed`);
      assert.match(sys, /Finish properly/, `request ${i + 1}: full method body`);
    }
    oc.writeConfig(upPort + 1, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, caveman: false, method: false, methodSkill: SKILL });
    cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
    assert.ok(!(cfg.instructions || []).includes(oc.METHOD_FILE()) && !fs.existsSync(oc.METHOD_FILE()), 'method removed when off');
    const off = await run(oc, env, proj, 4322, upPort + 1);
    assert.ok(off.length >= 1 && off.every((sys) => !/How you work \(always on\)/.test(sys)), 'no method when off');
    // každý skill zmíněný ve směrovači existuje ve skills/ (jinak by ho agent nemohl načíst)
    const routed = [...fs.readFileSync(SKILL, 'utf8').split('## Skill router')[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    const missing = [...new Set(routed)].filter((n) => !fs.existsSync(path.join(__dirname, '..', 'skills', n, 'SKILL.md')));
    assert.deepStrictEqual(missing, [], 'every routed skill is bundled');
    console.log(`oc-method OK (zapnuto: postup + směrovač v systémovém promptu všech ${on.length} dotazů; vypnuto: pryč; ${new Set(routed).size} skills ve směrovači existuje)`);
  } finally {
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
