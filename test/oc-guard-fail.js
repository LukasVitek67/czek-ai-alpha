// Skutečný OpenCode (izolované XDG) + falešný model:
//  1) přečte a.txt, pak 4× edit s oldString, který v souboru není (každý jiný, mezi nimi bash) →
//     první 3 selžou chybou OpenCode, 4. zablokuje czek-guard (selhání chytá přes událost, after se u chyb nevolá);
//  2) 4× todowrite bez jiné práce → výstup je krátké potvrzení místo JSON, 4. volání zablokované,
//     seznam úkolů v OpenCode (GUI ho bere z úložiště) je přesto uložený.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ocguardfail-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');
  const file = path.join(proj, 'a.txt');
  fs.writeFileSync(file, 'hello\n');

  const todos = [{ content: 'Fix the bug', status: 'in_progress', priority: 'high' }, { content: 'Write a test', status: 'pending', priority: 'medium' }];
  const script = [
    ['read', { filePath: file }],
    ['edit', { filePath: file, oldString: 'nope 1', newString: 'x' }],
    ['bash', { command: 'echo step1', description: 'echo' }],
    ['edit', { filePath: file, oldString: 'nope 2', newString: 'x' }],
    ['bash', { command: 'echo step2', description: 'echo' }],
    ['edit', { filePath: file, oldString: 'nope 3', newString: 'x' }],
    ['edit', { filePath: file, oldString: 'nope 4', newString: 'x' }],
    ['todowrite', { todos }],
    ['todowrite', { todos }],
    ['todowrite', { todos }],
    ['todowrite', { todos }],
  ];
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
      const step = script[n++];
      if (!step) { res.end(ch({ role: 'assistant', content: 'Done.' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      res.end(ch({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + n, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }, null) + ch({}, 'tool_calls') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));

  const oc = require('../src/opencode');
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, fullAuto: true, dcp: false, todo: true });

  env.PWD = proj;
  const port = 4313;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'fix a.txt' }] });
    const tool = seen.at(-1).messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    assert.strictEqual(tool.length, script.length, 'tool results: ' + tool.length);
    const [, e1, , e2, , e3, e4, t1, t2, t3, t4] = tool;
    for (const e of [e1, e2, e3]) assert.match(e, /oldString|Could not find/i, 'OpenCode edit error: ' + e.slice(0, 160));
    assert.doesNotMatch(e3, /czek-guard/, '3rd failing edit still runs');
    assert.match(e4, /Blocked by czek-guard: 3 edits of a\.txt have failed/, '4th edit blocked: ' + e4.slice(0, 200));
    for (const t of [t1, t2, t3]) {
      assert.match(t, /Todo list saved \(2 items: 0 completed, 1 in progress, 1 pending\)/, 'short todowrite output: ' + t.slice(0, 200));
      assert.doesNotMatch(t, /"priority"/, 'no JSON echo');
    }
    assert.match(t4, /todowrite was called 3 times in a row/, '4th todowrite blocked: ' + t4.slice(0, 200));
    const stored = await (await fetch(`${u}/session/${s.id}/todo${q}`)).json();
    assert.strictEqual(stored.length, 2, 'todos stored for the GUI: ' + JSON.stringify(stored));
    console.log(`oc-guard-fail OK (${tool.length} volání: 3 chyby editu → blok 4.; todowrite krátce, 4. blok; seznam uložen)`);
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
