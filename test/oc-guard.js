// Skutečný OpenCode (izolované XDG) + falešný model, který pořád dokola čte tentýž soubor:
// czek-guard musí do výsledku nástroje připsat poznámku a 5. stejné volání zablokovat.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ocguard-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');
  const file = path.join(proj, 'a.txt');
  fs.writeFileSync(file, 'hello\n');

  const seen = [];
  let n = 0;
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      const agent = (j.tools || []).length > 0;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      if (!agent) { res.end(ch({ role: 'assistant', content: 'Title' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      seen.push(j);
      n++;
      if (n > 7) { res.end(ch({ role: 'assistant', content: 'Giving up.' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      res.end(ch({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + n, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: file }) } }] }, null) + ch({}, 'tool_calls') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));

  const oc = require('../src/opencode');
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true });
  const cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
  assert.ok(cfg.plugin.some((p) => String(p).includes('czek-guard')), 'guard in plugin list');

  env.PWD = proj;
  const port = 4312;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'read a.txt' }] });
    const toolMsgs = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    assert.ok(toolMsgs.length >= 5, 'tool results: ' + toolMsgs.length);
    assert.ok(!/czek-guard|same result each time/.test(toolMsgs[1]), '2nd call has no note');
    assert.match(toolMsgs[2], /same result each time/, '3rd identical call gets a note');
    assert.match(toolMsgs[4], /Blocked by czek-guard/, '5th identical call is blocked: ' + toolMsgs[4].slice(0, 200));
    console.log(`oc-guard OK (${toolMsgs.length} volání, poznámka u 3., blok u 5.)`);
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
