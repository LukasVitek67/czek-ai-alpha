// Skutečný OpenCode + falešný model, který spustí kontrolu s uříznutým výstupem (`… | head -5`, jako
// `cargo check 2>&1 | head -30` živě 13. 11.). czek-guard musí příkaz rozšířit ještě před spuštěním:
// model pak dostane všech 60 řádků „chyb“ a poznámku, ať je opraví naráz.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ocwiden-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');
  // „kontrola“ = skript make-check.js, který vypíše 60 chyb; v příkazu je slovo make → CHECK
  fs.writeFileSync(path.join(proj, 'Makefile.js'), 'for (let i = 1; i <= 60; i++) console.log("error E" + i);\n');
  const command = 'node Makefile.js 2>&1 | head -5 # make';

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
      n++;
      if (n > 1) { res.end(ch({ role: 'assistant', content: 'Done.' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      res.end(ch({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'check' }) } }] }, null) + ch({}, 'tool_calls') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));

  const oc = require('../src/opencode');
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false });

  env.PWD = proj;
  const port = 4314;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'check it' }] });
    const tool = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).at(-1) || '';
    assert.match(tool, /error E60/, 'all 60 lines reached the model: ' + tool.slice(0, 300));
    assert.match(tool, /widened this command \(output was cut to 5 lines/, 'note');
    console.log(`oc-guard-widen OK (head -5 → model vidí všech ${(tool.match(/error E\d+/g) || []).length} chyb + poznámku)`);
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
