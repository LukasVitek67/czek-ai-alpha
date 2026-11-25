// Kontroloví subagenti (reviewer, reviewer-alt) v opencode.json:
//  1) writeConfig s reviewer:true → agent.reviewer (mode subagent, model max), agent.reviewer-alt, compaction zůstane;
//  2) skutečný `opencode serve` s touto konfigurací → GET /config vrátí oba agenty;
//  3) reviewer:false → oba agenti pryč, compaction zůstane.
// Izolované XDG, nic z uživatelova profilu. node test/oc-reviewer.js (OPENCODE_BIN = cesta k opencode.exe)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-reviewer-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const oc = require('../src/opencode');

  const opts = { tiers: [{ id: 'max', name: 'Max', keys: [] }, { id: 'high', name: 'High', keys: [] }], snapshotOff: true, dcp: false, agentTips: false };
  const read = () => JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));

  // výchozí stav: uživatelský compaction bez modelu (writeConfig k němu doplní model, ale nesmí smazat agenta)
  fs.mkdirSync(path.dirname(oc.CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(oc.CONFIG_FILE(), JSON.stringify({ agent: { compaction: { hidden: true } } }));

  // 1) reviewer zapnutý
  oc.writeConfig(0, [], { ...opts, reviewer: true });
  let cfg = read();
  console.log('agent:', JSON.stringify(cfg.agent));
  assert.strictEqual(cfg.agent.reviewer.mode, 'subagent', 'reviewer mode');
  assert.match(cfg.agent.reviewer.model, /max/, 'reviewer on strong model');
  assert.strictEqual(cfg.agent['reviewer-alt'].mode, 'subagent', 'reviewer-alt mode');
  assert.match(cfg.agent['reviewer-alt'].model, /high/, 'reviewer-alt on second route');
  assert.deepStrictEqual(cfg.agent.reviewer.permission, { edit: 'deny', write: 'deny', bash: 'allow' }, 'reviewer nemění kód (edit/write deny), build/testy smí (bash allow, bez dialogu)');
  assert.ok(cfg.agent.compaction, 'compaction kept with reviewers on');
  assert.strictEqual(cfg.agent.compaction.hidden, true, 'user compaction field kept');

  // 2) skutečný opencode serve s touto konfigurací: GET /config vrátí oba agenty
  const port = 4317;
  const u = `http://127.0.0.1:${port}`;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: base, env: { ...env, PWD: base }, windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const served = await (await fetch(u + '/config?directory=' + encodeURIComponent(base))).json();
    assert.ok(served.agent && served.agent.reviewer, 'opencode serve sees agent.reviewer: ' + JSON.stringify(served.agent || null).slice(0, 300));
    assert.ok(served.agent['reviewer-alt'], 'opencode serve sees agent.reviewer-alt');
    assert.strictEqual(served.agent.reviewer.mode, 'subagent');
    console.log('serve OK: /config obsahuje reviewer + reviewer-alt');
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
  }

  // 3) reviewer vypnutý: oba pryč, compaction zůstává
  oc.writeConfig(0, [], { ...opts, reviewer: false });
  cfg = read();
  assert.ok(!cfg.agent || !('reviewer' in cfg.agent), 'reviewer removed');
  assert.ok(!cfg.agent || !('reviewer-alt' in cfg.agent), 'reviewer-alt removed');
  assert.ok(cfg.agent && cfg.agent.compaction, 'compaction stays with reviewers off');
  console.log('oc-reviewer OK (reviewer + reviewer-alt zapsány, serve je vidí, reviewer:false je smaže, compaction zůstává)');

  setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
})().catch((e) => { console.error(e); process.exitCode = 1; });
