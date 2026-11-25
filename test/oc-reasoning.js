// Proč je samotné OpenCode s jedním modelem lepší než czek-ai (změřeno 14. 11. nahráním požadavků): OpenCode
// posílá u GLM přímo na Z.ai `thinking: {type: "enabled", clear_thinking: false}` a teplotu 1, přes OmniRoute
// (model auto/coding / combo) nepošle nic a OmniRoute pak uvažování nezapne. czek-guard proto přes chat.params
// posílá `reasoning_effort` (OmniRoute ho převede pro každého poskytovatele). A nástroj omniroute_sync_models
// z pluginu OmniRoute agent nevidí.
// Skutečný OpenCode + skutečný plugin OmniRoute + falešný OmniRoute, který nahrává požadavky.
// node test/oc-reasoning.js   (OMNI_PLUGIN_DIR = složka pluginu, když OmniRoute není nainstalovaný)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(guard, pluginSrc, port) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-reason-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');
  fs.writeFileSync(path.join(proj, 'a.txt'), 'hello\n');

  const reqs = [];
  let steps = 0;
  const model = (id) => ({ id, object: 'model', owned_by: 'omniroute', context_length: 131072, max_output_tokens: 32000, capabilities: { tool_calling: true, thinking: true } });
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url === '/v1/models') return json({ object: 'list', data: [model('auto/coding'), model('auto/fast')] });
      if (url.startsWith('/api/')) return json({ combos: [], data: [] });
      if (!url.endsWith('/chat/completions')) return json({ data: [] });
      const j = JSON.parse(b);
      const agent = (j.tools || []).length > 0;
      reqs.push(j);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      if (agent && steps++ === 0) {
        res.end(ch({ role: 'assistant', reasoning_content: 'read first' }, null)
          + ch({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: path.join(proj, 'a.txt') }) } }] }, null)
          + ch({}, 'tool_calls') + 'data: [DONE]\n\n');
        return;
      }
      res.end(ch({ role: 'assistant', content: agent ? 'Done.' : 'Title' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const oc = require('../src/opencode');
  oc.writeConfig(0, [], { omniUrl: `http://127.0.0.1:${up.address().port}`, omniKey: 'test-key', pluginSrc, snapshotOff: true, dcp: false, guard, agentTips: false });

  env.PWD = proj;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await sleep(500); }
    await sleep(2000);
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'opencode-omniroute', modelID: 'auto/coding' }, parts: [{ type: 'text', text: 'read a.txt' }] });
    for (let i = 0; i < 60 && steps < 2; i++) await sleep(500);
    await sleep(1000);
    const agents = reqs.filter((r) => (r.tools || []).length);
    const others = reqs.filter((r) => !(r.tools || []).length);
    return {
      agentEffort: agents.map((r) => r.reasoning_effort ?? null),
      otherEffort: others.map((r) => r.reasoning_effort ?? null),
      tools: agents[0] ? agents[0].tools.map((t) => t.function.name) : [],
      reasoningEchoed: agents.length > 1 && agents[1].messages.some((m) => m.role === 'assistant' && m.reasoning_content === 'read first'),
    };
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

(async () => {
  const pluginSrc = process.env.OMNI_PLUGIN_DIR || require('../src/omniroute').findPlugin();
  if (!pluginSrc) { console.log('oc-reasoning SKIP (plugin OmniRoute není nainstalovaný, nastav OMNI_PLUGIN_DIR)'); return; }
  const off = await run(false, pluginSrc, 4323);
  assert.ok(off.agentEffort.length >= 2 && off.agentEffort.every((e) => e == null), 'bez czek-guard OpenCode přes OmniRoute uvažování nežádá: ' + JSON.stringify(off));
  const on = await run(true, pluginSrc, 4324);
  assert.ok(on.agentEffort.length >= 2 && on.agentEffort.every((e) => e === 'medium'), 'každý krok agenta má reasoning_effort medium: ' + JSON.stringify(on));
  // titulek relace (malý model) nastavuje OpenCode samo, guard ho nemění
  assert.deepStrictEqual(on.otherEffort, off.otherEffort, 'titulek relace beze změny: ' + JSON.stringify({ on, off }));
  assert.ok(!on.tools.includes('omniroute_sync_models') && on.tools.includes('read'), 'omniroute_sync_models agent nevidí: ' + on.tools.join(','));
  assert.ok(on.reasoningEchoed, 'uvažování z minulého kroku jde v historii zpět');
  console.log(`oc-reasoning OK (bez czek-guard: reasoning_effort ${JSON.stringify(off.agentEffort)}; s ním: ${JSON.stringify(on.agentEffort)}, titulek ${JSON.stringify(on.otherEffort)}; nástroje ${on.tools.length}, bez omniroute_sync_models)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
