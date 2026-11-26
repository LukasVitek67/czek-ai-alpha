// Presety chatu na skutečném OpenCode (izolované XDG) + falešný model: preset je primární agent v konfiguraci, zpráva
// s agentem presetu dostane v systémovém promptu blok presetu (povinné skills + plán) a zároveň zůstane základní prompt
// i czek-method; další zpráva téže relace s agentem build už preset nemá; presets:false = žádní agenti ani blok.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const METHOD = path.join(__dirname, '..', 'skills', 'czek-method', 'SKILL.md');

async function run(env, proj, port, upPort, turns) {
  const seen = []; // systémový prompt každého kroku agenta (dotazy s nástroji)
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      if ((j.tools || []).length) seen.push(j.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.end(ch({ role: 'assistant', content: 'OK' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(upPort, '127.0.0.1', r));
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const agents = await (await fetch(u + '/agent' + q)).json().catch(() => []);
    const s = await post('/session', {});
    const per = [];
    for (const agent of turns) {
      const before = seen.length;
      await post(`/session/${s.id}/message`, { agent, model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'udělej mi jednoduchou stránku' }] });
      per.push({ agent, sys: seen.slice(before) });
    }
    return { per, agents: Array.isArray(agents) ? agents : [] };
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    await new Promise((r) => setTimeout(r, 800));
  }
}

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-preset-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const proj = x('proj');
  env.PWD = proj;
  const oc = require('../src/opencode');
  const upPort = 46000 + Math.floor(Math.random() * 1000);
  const wd = oc.presetsData('en').find((p) => p.id === 'web-design');
  assert.ok(wd?.plan, 'plán src/presets/web-design.md existuje');
  try {
    oc.writeConfig(upPort, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, caveman: false, method: true, methodSkill: METHOD });
    const cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
    assert.ok(cfg.agent?.['web-design']?.mode === 'primary', 'agent web-design v konfiguraci');
    assert.ok(fs.existsSync(path.join(oc.GUARD_DIR(), 'presets.json')), 'presets.json pro guard');
    const on = await run(env, proj, 4331, upPort, ['web-design', 'web-design', 'build']);
    assert.ok(on.agents.some((a) => a.name === 'web-design' && a.mode === 'primary'), 'OpenCode zná primárního agenta web-design');
    const [first, second, plain] = on.per;
    assert.ok(first.sys.length >= 1 && second.sys.length >= 1 && plain.sys.length >= 1, `kroky agenta zachycené: ${on.per.map((t) => t.sys.length)}`);
    for (const [i, t] of [first, second].entries()) {
      for (const sys of t.sys) {
        assert.match(sys, /czek-ai preset: Web design/, `zpráva ${i + 1}: blok presetu`);
        assert.match(sys, /`czek-frontend`, `modern-web-design`/, `zpráva ${i + 1}: povinné skills`);
        assert.match(sys, /## Plan/, `zpráva ${i + 1}: plán postupu`);
        assert.match(sys, /How you work \(always on\)/, `zpráva ${i + 1}: czek-method zůstává`);
        assert.ok(sys.indexOf('czek-ai preset:') > sys.length / 3, `zpráva ${i + 1}: preset je přidaný za základní prompt, ne místo něj`);
      }
    }
    for (const sys of plain.sys) assert.ok(!/czek-ai preset:/.test(sys), 'agent build: bez presetu');
    // vypnuto: žádní agenti presetů ani blok
    oc.writeConfig(upPort + 1, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, caveman: false, method: true, methodSkill: METHOD, presets: false });
    const cfg2 = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
    assert.ok(!cfg2.agent?.['web-design'] && !fs.existsSync(path.join(oc.GUARD_DIR(), 'presets.json')), 'presets:false = bez agentů a dat');
    const len = (t) => t.sys[0]?.length || 0;
    console.log(`oc-preset OK (agent web-design v OpenCode, preset ve ${first.sys.length + second.sys.length} krocích za základním promptem, build bez presetu, vypnutí čisté; prompt ${len(plain)} → ${len(first)} znaků s presetem)`);
  } finally {
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
