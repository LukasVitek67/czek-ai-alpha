// Skutečný OpenCode + falešný model, který na první dotaz vrátí chybu Z.ai „Prompt exceeds max length“
// (400, živě 13. 11.). OpenCode tu hlášku nepozná jako přetečení kontextu a skončí. czek-guard musí
// kontext zkrátit (summarize auto) a OpenCode pak sám pokračuje → model dostane další dotaz a odpoví.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-overflow-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');

  const log = [];
  let failed = 0;
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      const sys = j.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ');
      const kind = !(j.tools || []).length ? (/summar/i.test(sys + JSON.stringify(j.messages.slice(-1))) ? 'compact' : 'title') : 'agent';
      log.push(kind);
      if (kind === 'agent' && failed === 0) {
        failed++;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Prompt exceeds max length', type: 'invalid_request_error', code: '1261' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      const text = kind === 'agent' ? 'Done after compaction.' : kind === 'compact' ? '## Summary\nThe user asked to fix the build.' : 'Title';
      res.end(ch({ role: 'assistant', content: text }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const oc = require('../src/opencode');
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false });

  env.PWD = proj;
  const port = 4316;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'fix the build' }] });
    let msgs = [];
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      msgs = await (await fetch(u + `/session/${s.id}/message` + q)).json();
      if (msgs.some((m) => m.parts.some((p) => p.type === 'text' && /Done after compaction/.test(p.text || '')))) break;
    }
    const errMsg = msgs.find((m) => m.info.error);
    assert.ok(errMsg && /Prompt exceeds max length/.test(JSON.stringify(errMsg.info.error)), 'the overflow error happened');
    assert.ok(msgs.some((m) => m.info.summary === true || m.parts.some((p) => p.type === 'compaction')), 'compaction ran: ' + log.join(','));
    assert.ok(msgs.some((m) => m.parts.some((p) => p.type === 'text' && /Done after compaction/.test(p.text || ''))), 'OpenCode continued after compaction: ' + log.join(','));
    console.log(`oc-overflow OK („Prompt exceeds max length“ → zkrácení → pokračuje samo; dotazy: ${log.join(', ')})`);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
