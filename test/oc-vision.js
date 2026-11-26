// Obrázek od uživatele na skutečném OpenCode: OpenCode → skutečný plugin OmniRoute (patch czek-vision: tier combo hlásí
// obrázky) → proxy závodu (src/race.js, popis přes falešné vidění) → falešný OmniRoute. Dřív (živě 20. 11.) OpenCode
// obrázek nahradil větou „Cannot read image.png (this model does not support image input)“ a model ho nikdy neviděl.
// Teď model dostane text: cesta k souboru v projektu (.czek/obrazky) + popis. A agent má nástroj look (czek-guard).
// node test/oc-vision.js   (OMNI_PLUGIN_DIR = složka pluginu, když OmniRoute není nainstalovaný)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');
const { createRaceProxy } = require('../src/race');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 8×8 PNG (červený čtverec)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

(async () => {
  const pluginSrc = process.env.OMNI_PLUGIN_DIR || require('../src/omniroute').findPlugin();
  if (!pluginSrc) { console.log('oc-vision SKIP (plugin OmniRoute není nainstalovaný)'); return; }
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ocvision-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME; process.env.XDG_DATA_HOME = env.XDG_DATA_HOME; delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');

  const agentReqs = [];
  const model = (id) => ({ id, object: 'model', owned_by: 'omniroute', context_length: 131072, max_output_tokens: 32000, capabilities: { tool_calling: true } }); // členové BEZ obrázků (jako Nemotron)
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url === '/v1/models') return json({ object: 'list', data: ['m/a', 'm/b', 'zdarma-max', 'zdarma-low'].map(model) });
      const members = ['m/a', 'm/b'].map((m) => ({ kind: 'model', model: m }));
      if (url === '/api/combos') return json({ combos: [{ id: 'c-max', name: 'zdarma-max', models: members }, { id: 'c-low', name: 'zdarma-low', models: members }] });
      if (url.startsWith('/api/')) return json({ combos: [], data: [] });
      const j = JSON.parse(b);
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ((j.tools || []).length) agentReqs.push(j);
      res.end(ch({ role: 'assistant', content: (j.tools || []).length ? 'I see the description.' : 'Title' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  let visionCalls = 0;
  const proxy = createRaceProxy({ target: () => `http://127.0.0.1:${up.address().port}`, candidates: (m) => (m === 'zdarma-max' ? ['m/a', 'm/b'] : []), n: () => 2, graceMs: 100,
    imageDir: () => x('fallback'), // čistá záložní složka (titulek relace pracovní složku v promptu nemá)
    vision: async (imgs) => { visionCalls++; assert.ok(imgs[0].startsWith('data:image/png;base64,')); return { text: 'A small solid red square.', model: 'qwen3-vl-30b' }; } });
  const proxyUrl = await proxy.listen(0);
  env.CZEK_VISION_URL = proxyUrl + '/czek/vision';
  const oc = require('../src/opencode');
  oc.writeConfig(0, [], { omniUrl: proxyUrl, omniKey: 'test-key', pluginSrc, snapshotOff: true, dcp: false, agentTips: false });

  env.PWD = proj;
  const port = 4331;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await sleep(500); }
    await sleep(2000);
    const prov = await (await fetch(u + '/config/providers' + q)).json();
    const mm = (prov.providers || []).find((p) => p.id === 'opencode-omniroute')?.models?.['zdarma-max'];
    console.log('  zdarma-max v OpenCode:', JSON.stringify({ attachment: mm?.attachment, modalities: mm?.modalities, input: mm?.capabilities?.input }));
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'opencode-omniroute', modelID: 'zdarma-max' },
      parts: [{ type: 'text', text: 'here is his pic, use it' }, { type: 'file', mime: 'image/png', filename: 'pic.png', url: 'data:image/png;base64,' + PNG }] });
    await sleep(500);
    assert.ok(agentReqs.length >= 1, 'agent step reached the models');
    const lastUser = [...agentReqs[0].messages].reverse().find((m) => m.role === 'user');
    const txt = JSON.stringify(lastUser.content);
    console.log('  zpráva uživatele, jak ji model dostal:', txt.slice(0, 400));
    assert.ok(!/Cannot read|does not support image input/.test(txt), 'OpenCode už obrázek nezahodí');
    assert.ok(!/image_url/.test(JSON.stringify(agentReqs)), 'model nedostane obrázek, jen text');
    assert.match(txt, /Image from the user, saved as/);
    assert.match(txt, /qwen3-vl-30b/); assert.match(txt, /small solid red square/);
    const plain = lastUser.content.map((p) => p.text || '').join(' ');
    const file = /saved as "([^"]+\.png)"/.exec(plain)?.[1] || '';
    const dirImg = path.join(proj, '.czek', 'obrazky');
    // titulek relace přijde dřív a pracovní složku v promptu nemá – krok agenta přesto musí dostat cestu v projektu
    assert.ok(file.toLowerCase().startsWith(dirImg.toLowerCase()) && fs.existsSync(file), 'obrázek uložen v projektu a cesta pro model vede tam: ' + file);
    assert.strictEqual(visionCalls, 1);
    const toolNames = agentReqs[0].tools.map((t) => t.function.name);
    // look (snímek okna přes PrintWindow) je jen pro Windows (src/guard/index.mjs)
    if (process.platform === 'win32') assert.ok(toolNames.includes('look'), 'agent má nástroj look: ' + toolNames.join(','));
    else assert.ok(!toolNames.includes('look'), 'look jen na Windows');
    console.log(`oc-vision OK (obrázek přes OpenCode a plugin → soubor v projektu + popis od modelu s viděním; nástroj look k dispozici; nástroje: ${toolNames.join(', ')})`);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close(); proxy.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
