// Štíhlý dotaz na model na skutečném OpenCode (izolované XDG, falešný OmniRoute):
//  1) kopie pluginu OmniRoute nezávisí na balíku @opencode-ai/plugin (čistý profil: poskytovatel se načte hned,
//     i když instance vznikne dřív, než si OpenCode balík doinstaluje) a nástroj omniroute_sync_models není;
//  2) combo zdarma-* / auto/* má výstup COMBO_OUTPUT (plugin jinak hlásí minimum přes členy, 8192) → max_tokens;
//  3) skillsAllow: v systémovém promptu jsou jen povolené skills (soukromé skills uživatele a caveman ne);
//     pravidlo permission.skill, které si uživatel napsal sám, se nemění; null = bez omezení.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-lean-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) process.env[k] = env[k];
  delete process.env.OPENCODE_CONFIG_DIR; delete process.env.OPENCODE_DATA_DIR;
  const seen = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.url.includes('chat/completions')) {
        const j = JSON.parse(b); seen.push(j);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
        res.end(ch({ role: 'assistant', content: 'OK' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.includes('/models')) res.end(JSON.stringify({ object: 'list', data: [{ id: 'auto/coding', object: 'model', owned_by: 'omniroute', context_length: 1050000, max_output_tokens: 8192 }] }));
      else res.end(JSON.stringify({ combos: [] }));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upUrl = `http://127.0.0.1:${up.address().port}`;
  const oc = require('../src/opencode');
  const skills = require('../src/skills');
  const bundle = path.join(__dirname, '..', 'skills');
  const allow = [...skills.bundled(bundle).filter((n) => !/^(caveman|cavecrew)/.test(n)), 'customize-opencode'];
  const write = (skillsAllow) => oc.writeConfig(0, [], { omniUrl: upUrl, omniKey: 'sk-test-local', onlyTiers: true, routed: [], caveman: true, cavemanSkill: path.join(bundle, 'caveman', 'SKILL.md'), skillsAllow });
  write(allow);
  const cfgDir = path.join(env.XDG_CONFIG_HOME, 'opencode');
  skills.sync({ bundleDir: bundle, targetDir: path.join(cfgDir, 'skills'), version: 'test' });

  // 1) kopie pluginu bez závislosti
  const entry = path.join(cfgDir, 'plugins', 'omniroute', 'dist', 'index.js');
  const code = fs.readFileSync(entry, 'utf8');
  assert.ok(!/from "@opencode-ai\/plugin"/.test(code), 'plugin copy must not import @opencode-ai/plugin');
  assert.ok(!/omniroute_sync_models: syncTool/.test(code), 'unused sync tool is not registered');
  assert.ok(!fs.existsSync(path.join(cfgDir, 'node_modules')), 'fresh profile: nothing installed yet');
  const cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
  assert.strictEqual(cfg.permission.skill['*'], 'deny');
  assert.strictEqual(cfg.permission.skill['app-debugging'], 'allow');
  assert.strictEqual(cfg.permission.skill.caveman, undefined);

  const proj = x('proj'); env.PWD = proj;
  const port = 4326;
  const start = () => spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const stop = async (c) => { try { execFileSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(1500); };
  const u = `http://127.0.0.1:${port}`; const q = '?directory=' + encodeURIComponent(proj);
  const upWait = async () => { for (let i = 0; i < 160; i++) { try { if ((await fetch(u + '/')).status) return; } catch {} await wait(250); } };
  const ask = async () => {
    seen.length = 0;
    const s = await (await fetch(u + '/session' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    await fetch(u + `/session/${s.id}/message` + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: { providerID: 'opencode-omniroute', modelID: 'auto/coding' }, parts: [{ type: 'text', text: 'hi' }] }), signal: AbortSignal.timeout(180000) }).then((r) => r.text());
    const chat = seen.find((j) => (j.tools || []).length);
    assert.ok(chat, 'agent request reached the model');
    const sys = chat.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    return { chat, sys, names: [...sys.matchAll(/<skill>\s*<name>([^<]*)<\/name>/g)].map((m) => m[1]) };
  };
  let child = start();
  try {
    await upWait();
    // instance hned po startu serveru, na čistém profilu (balík ještě není) → poskytovatel i modely musí být
    const prov = await (await fetch(u + '/config/providers' + q, { signal: AbortSignal.timeout(120000) })).json();
    const p = (prov.providers || []).find((v) => v.id === 'opencode-omniroute');
    assert.ok(p && p.models['auto/coding'], 'provider loaded on a fresh profile: ' + (prov.providers || []).map((v) => v.id).join(','));
    // 2) limity
    assert.strictEqual(p.models['auto/coding'].limit.output, oc.COMBO_OUTPUT, 'combo output limit raised');
    assert.strictEqual(p.models['auto/coding'].limit.context, oc.AUTO_CONTEXT);
    const a = await ask();
    assert.strictEqual(a.chat.max_tokens, oc.COMBO_OUTPUT, 'max_tokens sent to the model');
    assert.ok(!a.chat.tools.some((t) => t.function?.name === 'omniroute_sync_models'), 'no sync tool in the request');
    // 3) jen povolené skills
    const foreign = a.names.filter((n) => !allow.includes(n));
    assert.deepStrictEqual(foreign, [], 'only allowed skills listed, extra: ' + foreign.join(','));
    assert.ok(a.names.includes('app-debugging') && !a.names.some((n) => /^(caveman|cavecrew)/.test(n)), 'bundled yes, caveman family no');
    const leanLen = a.sys.length;

    // null = bez omezení (všechny skills, i soukromé) → restart serveru, konfigurace se čte při startu
    await stop(child);
    write(null);
    const cfg2 = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
    assert.ok(!cfg2.permission || cfg2.permission.skill === undefined, 'rule removed when unrestricted');
    child = start(); await upWait();
    const b = await ask();
    assert.ok(b.names.length > a.names.length && b.names.some((n) => /^caveman/.test(n)), 'unrestricted lists more skills');

    // vlastní pravidlo uživatele se nepřepisuje
    const own = { '*': 'allow', remotion: 'deny' };
    cfg2.permission = { skill: own };
    fs.writeFileSync(oc.CONFIG_FILE(), JSON.stringify(cfg2, null, 2));
    write(allow);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8')).permission.skill, own, "user's own skill rule kept");
    console.log(`oc-lean OK (plugin bez závislosti: poskytovatel hned na čistém profilu; max_tokens ${a.chat.max_tokens}; skills ${a.names.length} místo ${b.names.length}, systémový prompt ${leanLen} místo ${b.sys.length} znaků)`);
  } finally {
    await stop(child);
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
