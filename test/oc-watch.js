// Skutečný OpenCode + skutečný plugin @omniroute/opencode-plugin + falešný OmniRoute, který zpočátku
// neodpovídá (jako při startu, živě 13. 11.: instance složky lossless-player zůstala bez modelů →
// „No model results“). 1) chyba se zopakuje: instance bez modelů; 2) OmniRoute už jede → ocWatch.heal
// instanci zahodí a nová má modely.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');
const ocWatch = require('../src/ocWatch');

(async () => {
  const pluginSrc = require('../src/omniroute').findPlugin();
  if (!pluginSrc) { console.log('oc-watch SKIP (OmniRoute plugin není nainstalovaný)'); return; }
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ocwatch-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');

  let healthy = false;
  const hits = [];
  const model = (id) => ({ id, object: 'model', owned_by: 'omniroute', context_length: 96000, max_output_tokens: 8192, capabilities: { tool_calling: true } });
  const up = http.createServer((req, res) => {
    hits.push((healthy ? 'ok ' : 'down ') + req.url.split('?')[0]);
    if (!healthy) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"starting"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/v1/models')) res.end(JSON.stringify({ object: 'list', data: [model('auto/coding'), model('auto/fast')] }));
    else if (req.url.startsWith('/api/combos')) res.end(JSON.stringify({ combos: [] }));
    else res.end('{"data":[]}');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const omniUrl = `http://127.0.0.1:${up.address().port}`;
  const oc = require('../src/opencode');
  oc.writeConfig(0, [], { omniUrl, omniKey: 'test-key', pluginSrc, snapshotOff: true, dcp: false, guard: false });
  const cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
  const providerID = ocWatch.providerOf(cfg.model);
  assert.strictEqual(providerID, 'opencode-omniroute');

  env.PWD = proj;
  const port = 4318;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const before = await ocWatch.modelsIn(u, proj, providerID);
    assert.strictEqual(before, 0, 'bug reproduced: instance without models while OmniRoute was down (got ' + before + ')');
    healthy = true;
    const still = await ocWatch.modelsIn(u, proj, providerID);
    assert.strictEqual(still, 0, 'OpenCode keeps the empty instance even after OmniRoute is up (got ' + still + ')');
    const r = await ocWatch.heal(u, proj, providerID, { wait: 1000 });
    assert.ok(r.healed && r.ok && r.models > 0, 'healed: ' + JSON.stringify(r) + ' hits: ' + hits.slice(-6).join(', '));
    const again = await ocWatch.heal(u, proj, providerID, { wait: 1000 });
    assert.ok(again.ok && !again.healed, 'healthy instance is left alone');
    console.log(`oc-watch OK (OmniRoute nedostupný → instance bez modelů; po zotavení zůstala prázdná; heal → ${r.models} modely; zdravou nechá být)`);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
