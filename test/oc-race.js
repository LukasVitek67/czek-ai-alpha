// Závod modelů na skutečném OpenCode: OpenCode → skutečný plugin OmniRoute → proxy závodu (src/race.js) → falešný
// OmniRoute. Falešné combo „zdarma-max“ se chová jako OmniRoute s pomalým modelem v čele (první model 8 s mlčí, pak
// odpoví až další) – závod se 3 modely musí krok agenta (volání nástroje i závěrečnou odpověď) doručit hned od
// rychlého modelu, OpenCode nástroj provést a relaci dokončit; titulek (bez nástrojů) jde beze změny na combo.
// node test/oc-race.js   (OMNI_PLUGIN_DIR = složka pluginu, když OmniRoute není nainstalovaný)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');
const { createRaceProxy, GRACE_MS } = require('../src/race');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLOW_MS = 8000;

async function run(race, pluginSrc, port, stallFirst = false) {
  let stalled = 0;
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ocrace-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');
  fs.writeFileSync(path.join(proj, 'a.txt'), 'hello\n');

  const reqs = []; // { model, agent, closedEarly }
  let agentSteps = 0; // dokončené kroky agenta (podle toho, co dostal OpenCode)
  const model = (id) => ({ id, object: 'model', owned_by: 'omniroute', context_length: 131072, max_output_tokens: 32000, capabilities: { tool_calling: true } });
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url === '/v1/models') return json({ object: 'list', data: ['m/slow', 'm/fast', 'm/mid', 'zdarma-max', 'zdarma-low'].map(model) });
      const members = ['m/slow', 'm/fast', 'm/mid'].map((m) => ({ kind: 'model', model: m }));
      if (url === '/api/combos') return json({ combos: [{ id: '11111111-aaaa-4bbb-8ccc-000000000001', name: 'zdarma-max', models: members, strategy: 'priority' }, { id: '11111111-aaaa-4bbb-8ccc-000000000002', name: 'zdarma-low', models: members, strategy: 'priority' }] });
      if (url.startsWith('/api/')) return json({ combos: [], data: [] });
      if (!url.endsWith('/chat/completions')) return json({ data: [] });
      const j = JSON.parse(b);
      const agent = (j.tools || []).length > 0;
      const rec = { model: j.model, agent, closedEarly: false };
      reqs.push(rec);
      let done = false; let timer = null;
      res.on('close', () => { if (!done) rec.closedEarly = true; clearTimeout(timer); });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.write(ch({ role: 'assistant', content: '' }, null));
      // pomalý model v čele: m/slow sám, i combo (OmniRoute ho zkouší první) mlčí SLOW_MS
      // stallFirst: rychlý model při prvním kroku začne (uvažování) a pak zmlkne → hlídač proxy krok ukončí chybou
      if (stallFirst && agent && j.model === 'm/fast' && !stalled++) { setTimeout(() => res.write(ch({ reasoning_content: 'Let me read' }, null)), 150); return; }
      const delay = !agent ? 10 : j.model === 'm/slow' || j.model === 'zdarma-max' ? SLOW_MS : j.model === 'm/fast' ? 150 : 3500; // m/mid až po přednostním okně (2,5 s)
      timer = setTimeout(() => {
        done = true;
        const hadTool = j.messages.some((m) => m.role === 'tool');
        if (agent && !hadTool) {
          res.end(ch({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: path.join(proj, 'a.txt') }) } }] }, null)
            + ch({}, 'tool_calls') + 'data: [DONE]\n\n');
        } else {
          res.end(ch({ content: agent ? `Done by ${j.model}.` : 'Title' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
        }
        if (agent) agentSteps++;
      }, delay);
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upUrl = `http://127.0.0.1:${up.address().port}`;
  const asked = []; // modely kroků agenta, jak je poslal plugin (název combo, ne jeho id)
  const proxy = createRaceProxy({
    target: () => upUrl,
    candidates: (m, n) => { asked.push(m); return m === 'zdarma-max' ? ['m/slow', 'm/fast', 'm/mid'].slice(0, n) : []; },
    n: () => (race ? 3 : 0),
    stallMs: 1500,
  });
  const proxyUrl = await proxy.listen(0);
  const oc = require('../src/opencode');
  oc.writeConfig(0, [], { omniUrl: proxyUrl, omniKey: 'test-key', pluginSrc, snapshotOff: true, dcp: false, agentTips: false });

  env.PWD = proj;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await sleep(500); }
    await sleep(2000);
    const s = await post('/session', {});
    const t0 = Date.now();
    await post(`/session/${s.id}/message`, { model: { providerID: 'opencode-omniroute', modelID: 'zdarma-max' }, parts: [{ type: 'text', text: 'read a.txt' }] });
    const ms = Date.now() - t0;
    // guard může po chybě poslat pokračování (zmlklý vítěz) → počkat, až relace opravdu stojí
    if (stallFirst) {
      const busy = async () => Object.values(await (await fetch(u + "/session/status" + q)).json().catch(() => ({}))).some((v) => v && v.type && v.type !== "idle");
      for (let i = 0, calm = 0; i < 80 && calm < 3; i++) { await sleep(500); calm = (await busy()) ? 0 : calm + 1; }
    }
    await sleep(500);
    const msgs = await (await fetch(u + `/session/${s.id}/message` + q)).json();
    const parts = msgs.flatMap((m) => m.parts || []);
    const toolOk = parts.some((p) => p.type === 'tool' && p.tool === 'read' && p.state?.status === 'completed' && /hello/.test(p.state?.output || ''));
    const final = parts.filter((p) => p.type === 'text' && /^Done by/.test(p.text || '')).map((p) => p.text);
    const errors = msgs.filter((m) => m.info?.error).map((m) => m.info.error.name + ': ' + String(m.info.error.data?.message || '').slice(0, 120));
    return { ms, toolOk, final, reqs, stats: proxy.stats, asked, post: msgs.length, errors };
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close(); proxy.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

(async () => {
  const pluginSrc = process.env.OMNI_PLUGIN_DIR || require('../src/omniroute').findPlugin();
  if (!pluginSrc) { console.log('oc-race SKIP (plugin OmniRoute není nainstalovaný, nastav OMNI_PLUGIN_DIR)'); return; }
  const off = await run(false, pluginSrc, 4327);
  const on = await run(true, pluginSrc, 4328);
  const agentModels = (r) => r.reqs.filter((x) => x.agent).map((x) => x.model);
  console.log(`  bez závodu: ${off.ms} ms, kroky agenta: ${agentModels(off).join(', ')}`);
  console.log(`  se závodem: ${on.ms} ms, kroky agenta: ${agentModels(on).join(', ')}; vyhrál ${JSON.stringify(on.stats.won)}; plugin poslal model ${JSON.stringify([...new Set(on.asked)])}`);
  assert.ok(on.asked.includes('zdarma-max'), 'plugin posílá název combo: ' + JSON.stringify(on.asked));
  assert.ok(off.toolOk && off.final.length, 'bez závodu relace doběhne: ' + JSON.stringify(off.final));
  assert.ok(on.toolOk, 'se závodem OpenCode provedl nástroj read od vítěze');
  assert.deepStrictEqual(on.final, ['Done by m/fast.'], 'závěrečná odpověď od vítěze, nic od poražených');
  assert.deepStrictEqual(agentModels(off), ['zdarma-max', 'zdarma-max'], 'bez závodu jde krok na combo');
  assert.deepStrictEqual(agentModels(on).sort(), ['m/fast', 'm/fast', 'm/mid', 'm/mid', 'm/slow', 'm/slow'], 'každý krok na 3 modely');
  assert.ok(on.reqs.filter((x) => x.agent && x.model !== 'm/fast').every((x) => x.closedEarly), 'poražení zrušeni');
  assert.ok(on.reqs.filter((x) => !x.agent).every((x) => x.model !== 'm/fast' && x.model !== 'm/slow'), 'titulek beze změny modelu');
  assert.strictEqual(on.stats.races, 2);
  // každý krok: místo SLOW_MS jen GRACE_MS (silnější m/slow dostane přednost, pak vyhraje m/fast)
  assert.ok(off.ms - on.ms > 2 * (SLOW_MS - GRACE_MS) * 0.8, `závod ušetří čekání na pomalý model v obou krocích (${off.ms} → ${on.ms} ms)`);
  // zmlklý vítěz: proxy po 1,5 s ukončí krok chybou → OpenCode ho zopakuje (bez zmlklého modelu) a relace doběhne
  const st = await run(true, pluginSrc, 4329, true);
  console.log(`  zmlklý vítěz: ${st.ms} ms, kroky agenta: ${agentModels(st).join(', ')}; chyby zpráv: ${JSON.stringify(st.errors)}`);
  assert.ok(st.toolOk, 'po zmlknutí vítěze OpenCode krok zopakoval a nástroj provedl');
  assert.strictEqual(st.final.length, 1, 'relace doběhla do konce: ' + JSON.stringify(st.final));
  assert.ok(!agentModels(st).slice(3).includes('m/fast'), 'zmlklý model se v dalších krocích nezkouší');
  console.log(`oc-race OK (relace se 2 kroky: ${off.ms} ms → ${on.ms} ms se závodem 3 modelů)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
