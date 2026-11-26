// Free modely OpenCode Zen ve skutečném OpenCode (izolované XDG) + czek-guard: Zen (falešný server místo
// opencode.ai) selže → guard sám pokračuje na tieru Max (falešný „opencode-omniroute/zdarma-max“):
//  1) 429 FreeUsageLimitError (OpenCode opakuje → guard opakování hned utne),
//  2) 403 chyba bez opakování,
//  3) stream se zasekne → chunkTimeout ho utne (v testu 3 s, v appce 60 s),
//  4) zastavení uživatelem → žádný přechod. Plus konfigurace: vestavěný poskytovatel zapnutý, chunkTimeout 60 s.
//   OPENCODE_BIN=<opencode> node test/oc-zen.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (model, text) => {
  const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
  return ch({ role: 'assistant', content: text }, null) + ch({}, 'stop') + 'data: [DONE]\n\n';
};

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-zen-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'), OPENCODE_DISABLE_CLAUDE_CODE: '1' });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const guardLog = path.join(base, 'guard.jsonl');
  env.CZEK_GUARD_LOG = guardLog;
  const proj = x('proj');
  const oc = require('../src/opencode');
  let mode = '429';
  const zenHits = [], maxHits = [];
  const zen = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      zenHits.push(mode);
      const err = JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } });
      if (mode === '429') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(err); return; }
      if (mode === '403') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Region not allowed.' } })); return; }
      if (mode === 'stall' || mode === 'user') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Začínám…' }, finish_reason: null }] })}\n\n`);
        return; // a dál nic (zaseknutý stream)
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse('m', 'OK zen'));
    });
  });
  const max = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"zdarma-max"}]}'); return; }
      const j = JSON.parse(b);
      const last = [...j.messages].reverse().find((m) => m.role === 'user');
      const t = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      if ((j.tools || []).length) maxHits.push(t);
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(j.model, 'Pokračuji na Max.'));
    });
  });
  const zp = 46500 + Math.floor(Math.random() * 300), mp = zp + 400;
  await new Promise((r) => zen.listen(zp, '127.0.0.1', r));
  await new Promise((r) => max.listen(mp, '127.0.0.1', r));
  let child = null;
  try {
    // konfigurace czek-ai (guard apod.), pak Zen a „OmniRoute“ přesměrované na falešné servery
    oc.writeConfig(mp, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, caveman: false, method: false, presets: false });
    const cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
    delete cfg.enabled_providers;
    cfg.disabled_providers = (cfg.disabled_providers || []).filter((p) => p !== 'opencode');
    cfg.provider = { ...(cfg.provider || {}),
      opencode: { options: { baseURL: `http://127.0.0.1:${zp}/v1`, apiKey: 'public', chunkTimeout: 3000 } },
      'opencode-omniroute': { npm: '@ai-sdk/openai-compatible', name: 'czek-ai', options: { baseURL: `http://127.0.0.1:${mp}/v1`, apiKey: 'x' }, models: { 'zdarma-max': { name: 'Max', tool_call: true, limit: { context: 96000, output: 8000 } } } } };
    fs.writeFileSync(oc.CONFIG_FILE(), JSON.stringify(cfg, null, 2));
    // a výstup applyZen v konfiguraci appky
    const appCfg = {};
    oc._applyZen?.(appCfg, true);
    child = spawn(findOpencode(), ['serve', '--port', '4343', '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
    const u = 'http://127.0.0.1:4343', q = '?directory=' + encodeURIComponent(proj);
    const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json().catch(() => null);
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await wait(500); }
    const glog = () => (fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8') : '');
    const run = async (m, ms = 60000) => {
      mode = m;
      const before = maxHits.length;
      const s = await post('/session', {});
      const send = post(`/session/${s.id}/message`, { model: { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' }, parts: [{ type: 'text', text: 'udělej soubor a.txt' }] });
      if (m === 'user') { await wait(2500); await post(`/session/${s.id}/abort`, {}); }
      await send;
      for (let t = 0; t < ms && maxHits.length === before; t += 500) await wait(500);
      if (m === 'user') await wait(4000);
      return { id: s.id, hits: maxHits.slice(before) };
    };
    const r429 = await run('429');
    console.log('429:', zenHits.filter((h) => h === '429').length, 'pokusů na Zen; Max dostal:', JSON.stringify(r429.hits[0]?.slice(0, 120)));
    if (!r429.hits.length) {
      console.log('plugin:', JSON.stringify(cfg.plugin), 'log:', glog().slice(0, 600));
      const ld = path.join(env.XDG_DATA_HOME, 'opencode', 'log');
      for (const f of fs.existsSync(ld) ? fs.readdirSync(ld) : []) console.log(fs.readFileSync(path.join(ld, f), 'utf8').split('\n').filter((l) => /plugin|guard|error/i.test(l)).slice(0, 15).map((l) => l.slice(0, 300)).join('\n'));
    }
    assert.ok(r429.hits.length >= 1 && /free OpenCode Zen model\) stopped/.test(r429.hits[0]), '429 → pokračování na Max');
    assert.ok(zenHits.filter((h) => h === '429').length <= 3, 'opakování na Zen utnuto brzy');
    const r403 = await run('403');
    console.log('403: Max dostal:', JSON.stringify(r403.hits[0]?.slice(0, 120)));
    assert.ok(r403.hits.length >= 1 && /Region not allowed|stopped/.test(r403.hits[0]), '403 → pokračování na Max');
    const t0 = Date.now();
    const rst = await run('stall');
    console.log(`stall: Max za ${Math.round((Date.now() - t0) / 1000)} s:`, JSON.stringify(rst.hits[0]?.slice(0, 120)));
    assert.ok(rst.hits.length >= 1, 'zaseknutý stream → chunkTimeout → Max');
    const rus = await run('user', 9000);
    console.log('zastavení uživatelem: Max dostal', rus.hits.length);
    assert.strictEqual(rus.hits.length, 0, 'zastavení uživatelem → žádný přechod');
    const L = glog();
    assert.ok(/zen-fail/.test(L) && /zen-retry-abort/.test(L), 'guard log: zen-fail + zen-retry-abort');
    // konfigurace appky: vestavěný Zen s chunkTimeout 60 s
    const c2 = {}; oc.applyZen(c2, true);
    assert.strictEqual(c2.provider?.opencode?.options?.chunkTimeout, 60000);
    const c3 = { provider: { opencode: { options: { chunkTimeout: 60000 } } } }; oc.applyZen(c3, false);
    assert.ok(!c3.provider, 'vypnutí uklidí');
    console.log('oc-zen OK (429 / 403 / zaseknutý stream → guard pokračuje na Max; zastavení uživatelem ne; chunkTimeout 60 s)');
  } finally {
    if (child) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill('SIGKILL'); } catch {} } }
    zen.close(); max.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
