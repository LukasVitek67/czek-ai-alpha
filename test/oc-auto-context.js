// Skutečný OpenCode + skutečný plugin @omniroute/opencode-plugin + falešný OmniRoute, který u auto/coding hlásí
// kontext největšího kandidáta (1 050 000, jako skutečný OmniRoute u uživatele). OpenCode pak sám nezkracuje nikdy
// a dotaz přeteče u člena se 128k (0.15.6). czek-ai plugin při instalaci upraví → auto/* má strop AUTO_CONTEXT.
// Kontrola: 1) /config/providers ukazuje u auto/coding strop; 2) po kroku s 90 000 tokeny OpenCode sám zkrátí
// (požadavek na shrnutí) ještě před dalším krokem; 3) bez úpravy (původní plugin) 1 050 000 a žádné zkrácení.
// node test/oc-auto-context.js   (OMNI_PLUGIN_DIR = složka balíčku pluginu, když OmniRoute není nainstalovaný)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const BIG = 1050000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(patched, pluginSrc, port) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-autoctx-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');
  fs.writeFileSync(path.join(proj, 'a.txt'), 'hello\n');

  const log = [];
  let agentCalls = 0;
  const model = (id) => ({ id, object: 'model', owned_by: 'omniroute', context_length: BIG, max_output_tokens: 8192, capabilities: { tool_calling: true } });
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url === '/v1/models') return json({ object: 'list', data: [model('auto/coding'), model('auto/fast')] });
      if (url === '/api/combos/auto') return json({ combos: [{ id: 'auto-coding', variant: 'coding', candidateCount: 12, context_length: BIG, max_output_tokens: 8192 }] });
      if (url.startsWith('/api/combos')) return json({ combos: [] });
      if (!url.endsWith('/chat/completions')) return json({ data: [] });
      const j = JSON.parse(b);
      const all = JSON.stringify(j.messages);
      const sys = JSON.stringify(j.messages.filter((m) => m.role === 'system'));
      const kind = (j.tools || []).length ? 'agent' : /title/i.test(sys) ? 'title' : /summar|compact/i.test(all) ? 'compact' : 'other';
      log.push(kind);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f, usage) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }], ...(usage ? { usage } : {}) })}\n\n`;
      if (kind === 'agent' && agentCalls++ === 0) {
        // 1. krok: přečte soubor; kontext už je 90 000 tokenů (pod 128k, ale nad stropem 96 000 − 8 192)
        res.end(ch({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: path.join(proj, 'a.txt') }) } }] }, null)
          + ch({}, 'tool_calls', { prompt_tokens: 90000, completion_tokens: 20, total_tokens: 90020 }) + 'data: [DONE]\n\n');
        return;
      }
      const text = kind === 'agent' ? 'Done.' : kind === 'compact' ? '## Summary\nThe user asked to read a.txt.' : 'Title';
      res.end(ch({ role: 'assistant', content: text }, null) + ch({}, 'stop', { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005 }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const omniUrl = `http://127.0.0.1:${up.address().port}`;
  const oc = require('../src/opencode');
  oc.writeConfig(0, [], { omniUrl, omniKey: 'test-key', pluginSrc, snapshotOff: true, dcp: false, guard: false, agentTips: false });
  if (!patched) fs.copyFileSync(path.join(pluginSrc, 'dist', 'index.js'), path.join(oc.PLUGIN_DIR(), 'dist', 'index.js'));

  env.PWD = proj;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await sleep(500); }
    let ctx = null;
    for (let i = 0; i < 30 && ctx == null; i++) {
      const r = await (await fetch(u + '/config/providers' + q)).json();
      const p = (r.providers || []).find((x) => x.id === 'opencode-omniroute');
      ctx = p?.models?.['auto/coding']?.limit?.context ?? null;
      if (ctx == null) await sleep(1000);
    }
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'opencode-omniroute', modelID: 'auto/coding' }, parts: [{ type: 'text', text: 'read a.txt' }] });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const st = await (await fetch(u + '/session/status' + q)).json().catch(() => ({}));
      if (log.includes('agent') && agentCalls >= 2 && !st[s.id]) break;
    }
    const agentAt = log.indexOf('agent');
    const compactAt = log.indexOf('compact', agentAt + 1);
    const secondAgentAt = log.indexOf('agent', agentAt + 1);
    const compactedBeforeNextStep = compactAt > agentAt && (secondAgentAt < 0 || compactAt < secondAgentAt);
    return { ctx, compactedBeforeNextStep, log: log.join(' ') };
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

(async () => {
  const pluginSrc = process.env.OMNI_PLUGIN_DIR || require('../src/omniroute').findPlugin();
  if (!pluginSrc) { console.log('oc-auto-context SKIP (plugin OmniRoute není nainstalovaný, nastav OMNI_PLUGIN_DIR)'); return; }
  const { AUTO_CONTEXT } = require('../src/opencode');
  const before = await run(false, pluginSrc, 4321);
  assert.strictEqual(before.ctx, BIG, 'bez úpravy hlásí OpenCode kontext největšího kandidáta: ' + JSON.stringify(before));
  assert.ok(!before.compactedBeforeNextStep, 'bez úpravy OpenCode po 90 000 tokenech nezkracuje: ' + before.log);
  const after = await run(true, pluginSrc, 4322);
  assert.strictEqual(after.ctx, AUTO_CONTEXT, 'auto/coding má strop: ' + JSON.stringify(after));
  assert.ok(after.compactedBeforeNextStep, 'po kroku s 90 000 tokeny OpenCode sám zkrátí před dalším krokem: ' + after.log);
  console.log(`oc-auto-context OK (původní plugin: auto/coding ${before.ctx}, po 90k tokenech bez zkrácení [${before.log}]; czek-ai: ${after.ctx}, zkrácení před dalším krokem [${after.log}])`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
