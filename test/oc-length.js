// Skutečný OpenCode (izolované XDG) + falešný model. První odpověď skončí finish_reason „length“ (výstupní limit,
// bez nástroje) → OpenCode relaci ukončí a čeká na uživatele. czek-guard musí sám poslat pokračování se stejným
// modelem (bez zprávy od testu). Druhý scénář: model vrací „length“ pořád → nejvýš 2 automatická pokračování / 10 min.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const CUT = 'cut off at the output token limit';

// toolText = první odpověď je volání nástroje napsané jako text (finish „stop“, žádný skutečný nástroj)
async function scenario(name, port, lengthReplies, waitMs, toolText = null) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-oclen-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const guardLog = path.join(base, 'guard.jsonl');
  env.CZEK_GUARD_LOG = guardLog;
  const proj = x('proj');

  const agentReqs = []; // poslední uživatelská zpráva každého dotazu agenta
  let agentCount = 0;
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      const sys = j.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ');
      const kind = !(j.tools || []).length ? (/summar/i.test(sys + JSON.stringify(j.messages.slice(-1))) ? 'compact' : 'title') : 'agent';
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (kind !== 'agent') {
        res.end(ch({ role: 'assistant', content: 'Title' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
        return;
      }
      agentCount++;
      const lastUser = [...j.messages].reverse().find((m) => m.role === 'user');
      const lu = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
      agentReqs.push(lu);
      const isLength = agentCount <= lengthReplies;
      if (toolText && agentCount === 1) { res.end(ch({ role: 'assistant', content: toolText }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      res.end(ch({ role: 'assistant', content: isLength ? 'Partial reply that ran out' : 'OK' }, null)
        + ch({}, isLength ? 'length' : 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const oc = require('../src/opencode');
  oc.writeConfig(up.address().port, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false });

  env.PWD = proj;
  const child = spawn(findOpencode(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, windowsHide: true, stdio: 'ignore' });
  const u = `http://127.0.0.1:${port}`;
  const q = '?directory=' + encodeURIComponent(proj);
  const post = async (p, body) => (await fetch(u + p + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const s = await post('/session', {});
    await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'write the report' }] });
    // čekáme jen na automatiku: test už žádnou další zprávu neposílá
    await new Promise((r) => setTimeout(r, waitMs));
    const readLog = () => (fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const conts = readLog().filter((e) => e.kind === 'continue');
    const skips = readLog().filter((e) => e.kind === 'continue-skip');
    console.log(`  [${name}] dotazy agenta: ${agentCount}, záznamy continue: ${conts.length}, continue-skip: ${skips.length}`);
    return { agentCount, agentReqs, conts, skips };
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

(async () => {
  // 1) jedno „length“ → automatické pokračování
  const a = await scenario('jednou length', 4317, 1, 20000);
  assert.ok(a.agentCount >= 2, 'a second agent request arrived without a test message: ' + a.agentCount);
  assert.ok(a.agentReqs.length >= 2 && a.agentReqs[1].includes(CUT), 'continue text is the last user message: ' + JSON.stringify(a.agentReqs[1]));
  assert.ok(a.conts.length >= 1, 'guard log has a continue entry');

  // 2) pořád „length“ → nejvýš 2 automatická pokračování za 10 min
  const b = await scenario('pořád length', 4318, 1000, 30000);
  assert.ok(b.conts.length === 2, 'at most 2 auto-continues in 10 min, got ' + b.conts.length);
  assert.ok(b.agentCount === 3, 'original + 2 continues = 3 agent requests, got ' + b.agentCount);
  assert.ok(b.skips.length >= 1, 'third attempt logged as continue-skip');

  // 3) volání nástroje napsané jako text (živě 15. 11.: GLM po převzetí konverzace od jiného modelu) → guard pošle
  //    výzvu zavolat nástroj správně; běžná odpověď „stop“ bez takového textu nic nespustí
  const c = await scenario('nástroj jako text', 4319, 0, 20000, '<tool_call>proxy_read\n<arg_key>filePath</arg_key>\n<arg_value>C:/x/src/header.js</arg_value>\n</tool_call>');
  assert.ok(c.agentCount === 2, 'guard asked the model to redo the tool call: ' + c.agentCount);
  assert.ok(c.agentReqs[1].includes('wrote a tool call as plain text'), 'nudge text is the last user message: ' + JSON.stringify(c.agentReqs[1]));
  assert.strictEqual(c.conts[0]?.why, 'tooltext');
  const d = await scenario('běžná odpověď', 4320, 0, 12000);
  assert.ok(d.agentCount === 1 && d.conts.length === 0, 'a normal final answer is left alone: ' + d.agentCount);

  console.log(`oc-length OK (length → guard pošle pokračování samo; pořád length → nejvýš 2×/10 min: ${b.agentCount} dotazy, ${b.skips.length}× přeskočeno; nástroj jako text → výzva; běžná odpověď beze změny)`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
