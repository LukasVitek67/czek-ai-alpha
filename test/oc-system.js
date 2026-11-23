// Skutečný OpenCode (izolované XDG) + falešný model: v systémovém promptu je oddíl o počítači a uživateli
// (OS, Git Bash, žádný nástroj ls, účet, složky, jazyk, nástroje); bez sysInfo není. Živý záznam 14. 11.:
// model volal neexistující nástroj „ls“ a o uživateli nevěděl nic.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-system-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const oc = require('../src/opencode');
  const proj = x('proj');

  const systems = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ((j.tools || []).length) systems.push(j.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
      res.end(ch({ role: 'assistant', content: 'Done.' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));

  const info = {
    os: 'Windows 11 Home (10.0.26200, x64)', shell: 'C:\\Program Files\\Git\\bin\\bash.exe', user: 'tester', home: 'C:\\Users\\tester',
    desktop: 'C:\\Users\\tester\\Desktop', documents: 'C:\\Users\\tester\\Documents', downloads: 'C:\\Users\\tester\\Downloads',
    locale: 'cs-CZ', tools: ['node', 'git', 'cargo'],
  };
  const port = 4317;
  const ask = async (sysInfo) => {
    oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, guard: false, agentTips: false, sysInfo });
    const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env: { ...env, PWD: proj }, windowsHide: true, stdio: 'ignore' });
    const u = `http://127.0.0.1:${port}`;
    const q = '?directory=' + encodeURIComponent(proj);
    const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    try {
      for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
      const s = await post('/session', {});
      const before = systems.length;
      await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'hi' }] });
      return systems.slice(before).at(-1) || '';
    } finally {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      await new Promise((r) => setTimeout(r, 800));
    }
  };

  try {
    const on = await ask(info);
    assert.ok(fs.existsSync(oc.SYSTEM_FILE()), 'czek-system.md written');
    for (const s of ['# This computer and its user', 'Windows 11 Home', 'Git Bash', 'There is no `ls` or `list` tool', 'Windows account "tester"', 'Documents C:\\Users\\tester\\Documents', 'cs-CZ', 'node, git, cargo']) {
      assert.ok(on.includes(s), 'system prompt contains: ' + s);
    }
    const off = await ask(null);
    assert.ok(!off.includes('# This computer and its user'), 'without sysInfo the section is gone');
    assert.ok(!JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8')).instructions?.includes(oc.SYSTEM_FILE()), 'instructions without czek-system.md');
    console.log(`oc-system OK (oddíl o počítači a uživateli v systémovém promptu: ${oc.systemContext(info).length} znaků; bez sysInfo pryč)`);
  } finally {
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
