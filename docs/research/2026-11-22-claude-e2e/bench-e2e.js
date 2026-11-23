// End-to-end agent benchmark on Linux: plain OpenCode 1.19.5 + ONE direct free model on a real coding task with hidden
// tests (test/fixtures/feature: implement 3 modules from README, 15 tests; or bugfix: 8 tests). Port of the "plain" mode of
// docs/research/2026-11-19-audit/scripts/bench-ab.js (that one is hardwired to the Windows home PC).
//
//   node bench-e2e.js <provider> <model> <outdir> [feature|bugfix|project]
//   provider: groq | mistral | zai | openrouter | gemini | nvidia | github  (keys from private/keys.json)
//   env: OPENCODE_BIN (default ~/.local/share/czek-bench/.../opencode), BENCH_LIMIT_MIN (default 15), BENCH_CTX, BENCH_OUT
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '../../..');
const [provId, modelId, out, fixtureArg] = process.argv.slice(2);
if (!provId || !modelId || !out) { console.error('usage: node bench-e2e.js <provider> <model> <outdir> [feature|bugfix|project]'); process.exit(2); }
const FIXTURE = ['bugfix', 'project'].includes(fixtureArg) ? fixtureArg : 'feature';
const TASK = FIXTURE === 'project'
  ? 'Projekt znamky (README.md) je nedodělaný: chybí funkce ve více modulech, je v něm chyba a příkazová řádka neumí vše. Dodělej a oprav zdrojáky ve složce src/ přesně podle README.md tak, aby `npm test` prošel celý. Testy (složka test/) neměň. Na konci spusť npm test a ověř, že vše prochází.'
  : FIXTURE === 'feature'
  ? 'Moduly ve složce src/ jsou prázdné. Implementuj je podle README.md a testů ve složce test/ tak, aby `npm test` prošel celý. Testy neměň. Na konci spusť npm test a ověř, že vše prochází.'
  : 'V tomhle projektu neprocházejí testy (npm test). Najdi a oprav chyby ve zdrojácích ve složce src/ tak, aby prošly všechny testy. Testy (složka test/) neměň. Na konci spusť npm test a ověř, že vše prochází.';
const LIMIT_MS = Number(process.env.BENCH_LIMIT_MIN || 15) * 60000;
const BASE = {
  groq: 'https://api.groq.com/openai/v1', mistral: 'https://api.mistral.ai/v1', zai: 'https://api.z.ai/api/paas/v4',
  openrouter: 'https://openrouter.ai/api/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  nvidia: 'https://integrate.api.nvidia.com/v1', github: 'https://models.github.ai/inference',
  kilo: 'https://api.kilo.ai/api/gateway', pollinations: 'https://text.pollinations.ai/openai',
};
const NO_KEY = new Set(['kilo', 'pollinations']);   // anonymous free tiers
const OPENCODE = process.env.OPENCODE_BIN || path.join(os.homedir(), '.local/share/czek-bench/node_modules/opencode-linux-x64/bin/opencode');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const dbg = (m) => process.env.BENCH_DEBUG && console.error(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const f of fs.readdirSync(a, { withFileTypes: true })) { if (f.isDirectory()) copyDir(path.join(a, f.name), path.join(b, f.name)); else fs.copyFileSync(path.join(a, f.name), path.join(b, f.name)); } };
const hashDir = (d) => require('crypto').createHash('sha256').update(fs.readdirSync(d).sort().map((f) => f + fs.readFileSync(path.join(d, f), 'utf8')).join('|')).digest('hex');

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const key = JSON.parse(fs.readFileSync(path.join(repo, 'private/keys.json'), 'utf8')).providers[provId] || (NO_KEY.has(provId) ? 'none' : null);
  if (!BASE[provId] || !key) throw new Error(`unknown provider or no key: ${provId}`);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'czek-e2e-')));
  const proj = path.join(root, 'app');
  copyDir(path.join(repo, 'test/fixtures', FIXTURE), proj);
  const testHash = hashDir(path.join(proj, 'test'));
  const x = (k) => { const d = path.join(root, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = { ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'), OPENCODE_DISABLE_AUTOUPDATE: '1' };
  delete env.OPENCODE_CONFIG_DIR;
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
  const ctx = Number(process.env.BENCH_CTX || 131072), outTok = Number(process.env.BENCH_OUT || 16384);
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { one: { npm: '@ai-sdk/openai-compatible', name: `${provId} direct`, options: { baseURL: BASE[provId], ...(key === 'none' ? {} : { apiKey: key }) },
      models: { [modelId]: { name: modelId, tool_call: true, limit: { context: ctx, output: outTok } } } } },
    model: `one/${modelId}`, small_model: `one/${modelId}`, snapshot: false, autoupdate: false,
    permission: require(path.join(repo, 'src/opencode')).FULL_AUTO,
  }, null, 1));
  const port = 4600 + Math.floor(Math.random() * 300);
  const child = spawn(OPENCODE, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env, stdio: 'ignore', detached: true });
  const kill = async () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await wait(1000); };
  const base = `http://127.0.0.1:${port}`; const model = { providerID: 'one', modelID: modelId };
  dbg('serve spawned'); for (let i = 0; i < 160; i++) { try { if ((await fetch(base + '/', { signal: AbortSignal.timeout(3000) })).status) break; } catch {} await wait(250); } dbg('serve up');
  const q = '?directory=' + encodeURIComponent(proj);
  const res = { provider: provId, model: modelId, fixture: FIXTURE, at: new Date().toISOString() };
  try {
    const s = await (await fetch(base + '/session' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) })).json(); dbg('session ' + s.id);
    const t1 = Date.now(); let timedOut = false, answered = false;
    // send the task (node:http, no timeout; the reply only comes when the agent is done) and POLL the session state
    const body = JSON.stringify({ model, parts: [{ type: 'text', text: TASK }] });
    const req = require('http').request(base + `/session/${s.id}/message` + q, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => { r.resume(); r.on('end', () => { answered = true; }); });
    req.on('error', () => { answered = true; });
    req.end(body);
    const get = async (p, ms = 15000) => { try { return await (await fetch(base + p + q, { signal: AbortSignal.timeout(ms) })).json(); } catch { return null; } };
    let idleSeen = 0;
    while (!answered) {
      await wait(5000);
      if (Date.now() - t1 > LIMIT_MS) { timedOut = true; break; }
      const st = await get('/session/status');
      const mine = st && st[s.id];
      idleSeen = (!mine || mine.type === 'idle') && Date.now() - t1 > 20000 ? idleSeen + 1 : 0;
      dbg(`poll ${mine ? mine.type : 'none'} idle=${idleSeen} ${mine && mine.type !== 'busy' ? JSON.stringify(mine).slice(0, 200) : ''}`);
      if (mine && mine.type === 'retry') res.lastRetry = JSON.stringify(mine).replace(/(sk-|gsk_|AIza|nvapi-)[A-Za-z0-9_-]{8,}/g, '***').slice(0, 400);
      if (idleSeen >= 3) break;   // idle for 15 s: done even if the HTTP reply got lost
    }
    req.destroy();
    if (timedOut) await fetch(base + `/session/${s.id}/abort` + q, { method: 'POST', signal: AbortSignal.timeout(15000) }).catch(() => {});
    res.wallS = Math.round((Date.now() - t1) / 100) / 10; res.timedOut = timedOut;
    dbg('fetching messages'); const msgs = (await get(`/session/${s.id}/message`, 60000)) || []; dbg('messages ' + msgs.length);
    const asst = msgs.filter((m) => m.info.role === 'assistant');
    const tools = asst.flatMap((m) => m.parts.filter((p) => p.type === 'tool'));
    const by = {}; for (const t of tools) by[t.tool] = (by[t.tool] || 0) + 1;
    const stepMs = asst.map((m) => (m.info.time?.completed || 0) - (m.info.time?.created || 0)).filter((v) => v > 0).sort((a, b) => a - b);
    res.partTypes = asst.flatMap((m) => m.parts.map((p) => p.type)).reduce((a, t) => { a[t] = (a[t] || 0) + 1; return a; }, {});
    res.texts = asst.flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text)).filter(Boolean).slice(-3).map((t) => t.replace(/\s+/g, ' ').slice(0, 300));
    res.finishes = asst.map((m) => m.info.finish || (m.info.error ? 'ERR' : '?')).reduce((a, f) => { a[f] = (a[f] || 0) + 1; return a; }, {});
    res.steps = asst.length; res.tools = by; res.toolErrors = tools.filter((t) => t.state?.status === 'error').length;
    res.stepMedianS = stepMs.length ? Math.round(stepMs[Math.floor((stepMs.length - 1) / 2)] / 100) / 10 : null;
    res.tokens = asst.reduce((a, m) => { const t = m.info.tokens || {}; a.in += t.input || 0; a.out += t.output || 0; a.reasoning += t.reasoning || 0; return a; }, { in: 0, out: 0, reasoning: 0 });
    res.errors = asst.filter((m) => m.info.error).map((m) => JSON.stringify(m.info.error).replace(/(sk-|gsk_|AIza|nvapi-|ghp_|hf_)[A-Za-z0-9_-]{8,}/g, '***').slice(0, 220)).slice(0, 4);
    dbg('tests'); const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: proj, encoding: 'utf8', timeout: 120000 }); dbg('tests done');
    const o = (t.stdout || '') + (t.stderr || '');
    res.testsPass = Number((/# pass (\d+)/.exec(o) || [])[1] || 0); res.testsFail = Number((/# fail (\d+)/.exec(o) || [])[1] || 0);
    res.testsUntouched = hashDir(path.join(proj, 'test')) === testHash;
    res.success = t.status === 0 && res.testsFail === 0 && res.testsPass > 0 && res.testsUntouched;
  } catch (e) { res.error = String(e.message || e).slice(0, 300); }
  await kill();
  const file = path.join(out, `e2e-${FIXTURE}-${provId}-${modelId.replace(/[^\w.-]+/g, '_')}${process.env.BENCH_TAG ? '-' + process.env.BENCH_TAG : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ provider: provId, model: modelId, success: res.success, tests: `${res.testsPass}/${res.testsPass + res.testsFail}`, wallS: res.wallS, steps: res.steps, toolErrors: res.toolErrors, tokens: res.tokens, errors: res.errors?.length ? res.errors[0].slice(0, 120) : undefined, error: res.error }));
  fs.rmSync(root, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
