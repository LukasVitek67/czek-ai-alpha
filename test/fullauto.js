// Plný automatický režim: zápis oprávnění do konfigurace OpenCode, záloha a vrácení původního nastavení
// uživatele a kontrola, že skutečné OpenCode konfiguraci přijme. Vše v dočasných složkách (XDG_*).
// node test/fullauto.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-fullauto-'));
const xdg = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d; };
delete process.env.OPENCODE_CONFIG_DIR;
process.env.XDG_CONFIG_HOME = xdg('config');
const opencode = require('../src/opencode');
const file = opencode.CONFIG_FILE();
const models = [{ key: 'kilo/x', id: 'x', provider: 'kilo', usable: true, tools: true, context: 131072 }];
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

// 1) uživatel má vlastní permission a další klíče
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ theme: 'tokyonight', permission: { bash: 'ask', edit: 'deny' }, mcp: { a: { type: 'local', command: ['x'] } } }, null, 2));
opencode.writeConfig(4545, models, { fullAuto: true });
let c = read();
assert.deepStrictEqual(c.permission, { ...opencode.FULL_AUTO, todowrite: 'deny' }, 'zapnuto: plná sada (seznam úkolů vypnutý)');
assert.ok(!('edit' in c.permission) && !('*' in c.permission), 'bez edit a "*" (jinak by přebily režim Plan)');
assert.equal(c.permission.external_directory['*'], 'allow');
assert.equal(c.permission.read['*.env'], 'allow');
assert.equal(c.permission.doom_loop, 'allow');
assert.equal(c.theme, 'tokyonight'); assert.ok(c.mcp.a, 'ostatní klíče zůstanou');
assert.ok(fs.existsSync(opencode.PERM_BACKUP()), 'původní permission je zálohovaná');
opencode.writeConfig(4545, models, { fullAuto: true }); // podruhé: záloha se nepřepíše plnou sadou
assert.deepStrictEqual(JSON.parse(fs.readFileSync(opencode.PERM_BACKUP(), 'utf8')).permission, { bash: 'ask', edit: 'deny' });
opencode.writeConfig(4545, models, { fullAuto: false });
c = read();
assert.deepStrictEqual(c.permission, { bash: 'ask', edit: 'deny' }, 'vypnuto: původní nastavení zpět');
assert.ok(!fs.existsSync(opencode.PERM_BACKUP()), 'záloha uklizená');

// 2) uživatel permission neměl → po vypnutí klíč zmizí
fs.writeFileSync(file, JSON.stringify({ theme: 'x' }));
opencode.writeConfig(4545, models, { fullAuto: true });
assert.deepStrictEqual(read().permission, { ...opencode.FULL_AUTO, todowrite: 'deny' });
opencode.writeConfig(4545, models, { fullAuto: false });
assert.ok(!('permission' in read()), 'vypnuto: žádný klíč permission');
// běžný zápis (vypnuto) permission uživatele nemění
fs.writeFileSync(file, JSON.stringify({ permission: { bash: 'deny' } }));
opencode.writeConfig(4545, models, {});
assert.deepStrictEqual(read().permission, { bash: 'deny' });
console.log('zápis konfigurace OK');

// 3) skutečné OpenCode: přijme konfiguraci s plnou sadou (server naběhne a /config ji vrátí)
const bin = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
if (!fs.existsSync(bin)) { console.log('OpenCode není nainstalovaný – kontrola přeskočena'); process.exit(0); }
fs.writeFileSync(file, '{}');
opencode.writeConfig(4545, models, { fullAuto: true });
const env = { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: xdg('data'), XDG_STATE_HOME: xdg('state'), XDG_CACHE_HOME: xdg('cache'), PWD: xdg('proj') };
const port = 4300 + Math.floor(Math.random() * 500);
const p = spawn(bin, ['serve', '--port', String(port)], { cwd: env.PWD, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
const kill = () => spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
(async () => {
  let cfg = null;
  for (let i = 0; i < 60 && !cfg; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await fetch(`http://127.0.0.1:${port}/config?directory=${encodeURIComponent(env.PWD)}`); if (r.ok) cfg = await r.json(); } catch {}
  }
  // výsledná pravidla agentů: platí poslední shodné pravidlo
  let agents = null;
  try { agents = await (await fetch(`http://127.0.0.1:${port}/agent?directory=${encodeURIComponent(env.PWD)}`)).json(); } catch {}
  kill();
  const last = (agent, perm, pattern) => (agent.permission || []).filter((r) => r.permission === perm && r.pattern === pattern).pop()?.action;
  const build = (agents || []).find((a) => a.name === 'build');
  const plan = (agents || []).find((a) => a.name === 'plan');
  assert.ok(build && plan, 'OpenCode vrací agenty build a plan');
  for (const [perm, pat] of [['external_directory', '*'], ['read', '*.env'], ['doom_loop', '*'], ['bash', '*']])
    assert.equal(last(build, perm, pat), 'allow', `build: ${perm} ${pat} = allow`);
  assert.equal(last(plan, 'edit', '*'), 'deny', 'režim Plan dál nesmí upravovat soubory');
  console.log('výsledná pravidla OK (build se na nic neptá, Plan dál bez úprav)');
  assert.ok(cfg, 'OpenCode naběhlo s konfigurací plného automatu. Výstup: ' + log.slice(-500));
  const perm = cfg.permission;
  assert.ok(perm, '/config vrací permission: ' + JSON.stringify(cfg).slice(0, 300));
  const flat = JSON.stringify(perm);
  assert.ok(/external_directory/.test(flat) && /doom_loop/.test(flat), 'OpenCode převzalo plnou sadu: ' + flat.slice(0, 300));
  console.log('OpenCode konfiguraci přijalo: ' + flat.slice(0, 160));
  console.log('fullauto OK');
  process.exit(0);
})().catch((e) => { kill(); console.error(e); process.exit(1); });
