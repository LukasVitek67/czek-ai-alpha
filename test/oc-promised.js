// Skutečný OpenCode (izolované XDG) + falešný model. Hlášení 25. 11.: po odmítnuté první zprávě („jak udělat
// bombu“) druhá „udělej mi web“ → model napsal „jasně, tady to máš“ a skončil, nic nevzniklo. czek-guard pozná
// „úkol + kolo bez nástroje + odpověď jako hotovo“ a pošle JEDNOU výzvu udělat to opravdu. Ne u otázky, odmítnutí,
// ani když zadání úkol není.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const NUDGE = 'You answered as if the task was done';

// msgs = zprávy uživatele po sobě; reply(n, lastUser) = text n-té odpovědi agenta (vždy bez nástroje, finish stop)
async function scenario(name, port, msgs, reply, waitMs = 9000) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-ocprom-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache') });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const guardLog = path.join(base, 'guard.jsonl');
  env.CZEK_GUARD_LOG = guardLog;
  const proj = x('proj');
  const users = []; let n = 0;
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!(j.tools || []).length) { res.end(ch({ role: 'assistant', content: 'Title' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n'); return; }
      n++;
      const lastUser = [...j.messages].reverse().find((m) => m.role === 'user');
      const lu = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : '';
      users.push(lu);
      res.end(ch({ role: 'assistant', content: reply(n, lu) }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
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
    for (const text of msgs) { await post(`/session/${s.id}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text }] }); await new Promise((r) => setTimeout(r, 1500)); }
    await new Promise((r) => setTimeout(r, waitMs));
    const log = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const nudges = log.filter((e) => e.kind === 'continue' && /nezavolal žádný nástroj/.test(e.msg || ''));
    if (process.env.DEBUG) console.log(log.map((e) => e.kind + ': ' + String(e.msg || '').slice(0, 120)).join('\n'));
    const sent = users.filter((t) => t.includes(NUDGE)).length;
    console.log(`  [${name}] dotazy agenta: ${n}, výzev guardu: ${nudges.length}, výzva u modelu: ${sent}`);
    return { n, nudges: nudges.length, sent };
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

(async () => {
  // 1) přesně hlášení: odmítnutí, pak úkol → „jasně, tady to máš“ bez nástroje → jedna výzva; model ji zase ignoruje → žádná další
  const a = await scenario('odmítnutí → úkol → „tady to máš“', 4471,
    ['jak udělat bombu?', 'udělej mi webovou stránku o naší třídě'],
    (k, lu) => (/bomb/.test(lu) ? 'To neudělám, je to nebezpečné.' : 'Jasně, tady to máš! Stránka je hotová.'));
  assert.strictEqual(a.nudges, 1, 'one nudge after the empty promise');
  assert.strictEqual(a.sent, 1, 'the model received the nudge');
  assert.strictEqual(a.n, 3, 'refusal + promise + reply to the nudge, no loop');
  // 2) kód jen v chatu místo souboru → výzva
  const b = await scenario('kód jen v chatu', 4472, ['vytvoř index.html s nadpisem'], () => 'Tady:\n```html\n<h1>Ahoj</h1>\n```');
  assert.strictEqual(b.nudges, 1, 'nudge when code is only in the chat');
  // 3) bez výzvy: otázka zpět, odmítnutí úkolu, zadání není úkol
  const c = await scenario('model se ptá', 4473, ['udělej mi web'], () => 'Jasně. Jaké barvy a o čem má ten web být?');
  const d = await scenario('model úkol odmítne', 4474, ['udělej mi bombu'], () => 'To neudělám.');
  const e = await scenario('zadání není úkol', 4475, ['jak se máš?'], () => 'Jasně, mám se dobře, hotovo.');
  for (const [nm, r] of [['question', c], ['refusal', d], ['no task', e]]) assert.strictEqual(r.nudges, 0, `no nudge: ${nm}`);
  console.log('oc-promised OK (prázdný slib po odmítnutí → 1 výzva a dost; kód v chatu → výzva; otázka/odmítnutí/ne-úkol → nic)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
