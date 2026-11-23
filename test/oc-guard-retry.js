// Skutečný OpenCode (izolované XDG) + falešný model, který pořád vrací 529 „overloaded“ (jako Z.ai 13. 11.).
// Bez guardu OpenCode opakuje donekonečna („retrying … attempt #N“) a relace nikdy není idle (seznam úkolů
// visí). czek-guard musí požadavek po 3 pokusech zastavit → relace idle, model dostal jen pár požadavků.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ocretry-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');

  let chat = 0;
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      if (!(j.tools || []).length) { // název relace apod.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'T' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      chat++;
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '[1305] The service may be temporarily overloaded, please try again later', type: 'overloaded_error', code: 529 } }));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));

  const oc = require('../src/opencode');
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false });

  env.PWD = proj;
  const port = 4313;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'hi' }] }).catch(() => {});
    // OpenCode čeká mezi pokusy 2, 4, 8 … s; bez guardu by po 60 s byla relace pořád „retry“
    let st = null;
    const t0 = Date.now();
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = (await (await fetch(u + '/session/status' + q)).json())[s.id];
      if (i > 6 && (!st || st.type === 'idle')) break;
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    assert.ok(!st || st.type === 'idle', 'session must be idle, got ' + JSON.stringify(st));
    assert.ok(chat >= 2 && chat <= 5, 'upstream attempts: ' + chat);
    console.log(`oc-guard-retry OK (529 dokola: ${chat} pokusy, relace idle za ${secs} s)`);
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
