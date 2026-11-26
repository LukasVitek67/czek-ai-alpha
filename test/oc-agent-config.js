// Skutečný OpenCode (izolované XDG, vlastní port): pokyny Zdarmy ("instructions") jsou v systémovém
// promptu, kompakce jde na zdarma/max i když chat běží na zdarma/mid, popisy přibalených skills jsou krátké.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-agentcfg-'));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;

  // falešný upstream: zapíše požadavek, odpoví krátkým textem (SSE)
  const seen = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b); seen.push(j);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.end(ch({ role: 'assistant', content: 'Hotovo.' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upPort = up.address().port;

  // konfigurace přes writeConfig Zdarmy (tierlisty max/mid), proxy = falešný upstream
  const oc = require('../src/opencode');
  const tiers = [{ id: 'max', name: 'Max', keys: [] }, { id: 'mid', name: 'Mid', keys: [] }];
  oc.writeConfig(upPort, [], { tiers, snapshotOff: true });
  const cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
  assert.strictEqual(cfg.agent.compaction.model, 'zdarma/max');
  assert.ok(cfg.instructions.includes(oc.AGENT_TIPS_FILE()));

  // přibalené skills (zkrácené popisy) do skills složky konfigurace
  const skills = require('../src/skills');
  // izolace: test nesmí záviset na skutečných ~/.claude/skills (jinak se přibalené skills, co tam uživatel má, nezkopírují)
  process.env.ZDARMA_CLAUDE_SKILLS = path.join(env.XDG_CONFIG_HOME, 'claude-skills-empty');
  skills.sync({ bundleDir: path.join(__dirname, '..', 'skills'), targetDir: path.join(env.XDG_CONFIG_HOME, 'opencode', 'skills'), version: 'test' });

  const proj = x('proj'); env.PWD = proj;
  const port = 4310;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'mid' }, parts: [{ type: 'text', text: 'ahoj' }] });
    const chat = seen.find((j) => j.model === 'mid' && (j.tools || []).length);
    assert.ok(chat, 'chat request on mid: ' + seen.map((j) => j.model).join(','));
    const sys = chat.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.ok(sys.includes('Working rules (added by Zdarma)'), 'tips in system prompt');
    const sk = sys.slice(sys.indexOf('<available_skills>'), sys.indexOf('</available_skills>'));
    // jen přibalené skills (složka skills konfigurace OpenCode), ne vlastní ~/.claude/skills uživatele
    const descs = [...sk.matchAll(/<skill>[\s\S]*?<description>([\s\S]*?)<\/description>\s*<location>([^<]*)<\/location>\s*<\/skill>/g)]
      .filter((d) => /[\\/]opencode[\\/]skills[\\/]/.test(d[2]));
    assert.ok(descs.length > 20, 'bundled skills listed: ' + descs.length);
    const long = descs.filter((d) => d[1].length > skills.DESC_MAX + 40);
    if (long.length) console.log(long.map((d) => d[1].length + ': ' + d[1].slice(0, 400)).join('\n'));
    assert.deepStrictEqual(long.map((d) => d[2]), [], 'bundled skill descriptions short');

    // ruční kompakce: musí jít na max
    seen.length = 0;
    await post(`/session/${s.id}/summarize`, { providerID: 'zdarma', modelID: 'mid', auto: false });
    for (let i = 0; i < 40 && !seen.length; i++) await new Promise((r) => setTimeout(r, 250));
    assert.ok(seen.length, 'compaction request sent');
    assert.ok(seen.every((j) => j.model === 'max'), 'compaction model: ' + seen.map((j) => j.model).join(','));
    console.log(`oc-agent-config OK (system prompt ${sys.length} znaků, skills blok ${sk.length})`);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
