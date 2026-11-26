'use strict';
/*
 * Iteration 21: does a slow-pass demotion survive an app restart?
 *
 * Two full lifetimes in one run against a deterministic local mock + real OmniRoute + real race:
 *   lifetime 1: start → probeHeads (round 1, 10 s cap) → agent steps while round 2 runs in background
 *               → round 2 demotes models that only answered after 10 s (slow0 14 s, slow1 18 s)
 *   stop() → lifetime 2 = RESTART (fresh OmniRoute instance, same dataDir)
 * Measured in lifetime 2: are the demotions still there (memory + disk), are the slow models back in
 * the combo head, how many probe calls round 1 spends on them, and how much of the first agent steps
 * is wasted on models that are known to be slow.
 *
 * Run: node test/omni-probe-restart.js        (before/after the patch → compare the printed numbers)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const { OmniRoute } = require(path.join(ROOT, 'src/omniroute'));
const { createRaceProxy } = require(path.join(ROOT, 'src/race'));
process.env.ZDARMA_OMNIROUTE_ROOT ||= path.join(os.homedir(), '.local/share/czek-bench/node_modules/omniroute');

const HEAD = [
  { id: 'hang0', ms: 15000, status: 200, hang: true },   // over the 10 s fast cap → answered only in round 2
  { id: 'limited', ms: 400, status: 429 },               // daily limit
  { id: 'slow0', ms: 14000, status: 200 },               // answers, but only after the 10 s cap
  { id: 'slow1', ms: 18000, status: 200 },               // ditto
  { id: 'fast0', ms: 300, status: 200 },
  { id: 'fast1', ms: 380, status: 200 },
  { id: 'fast2', ms: 460, status: 200 },
];
const SLOW = new Set(['slow0', 'slow1']);
const WASTE = new Set(['hang0', 'slow0', 'slow1']);
const WARM_STEPS = 3;    // agent steps right after startup, before round 2 finishes
const COVERAGE_STEPS = 2; // fast models artificially 429 → backups are used
const GAP_MS = 1200;

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const s10 = (ms) => Math.round(ms / 100) / 10;

function makeMock() {
  const hits = {}, probeHits = {}, raceHits = {};
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      if (!/chat\/completions$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: HEAD.map((m) => ({ id: m.id })) }));
        return;
      }
      const id = String(b.model || '').split('/').pop();
      const m = HEAD.find((x) => x.id === id);
      hits[id] = (hits[id] || 0) + 1;
      if (!b.stream) probeHits[id] = (probeHits[id] || 0) + 1; else raceHits[id] = (raceHits[id] || 0) + 1;
      if (!m) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"unknown"}'); return; }
      if (server.limitFast && /^fast/.test(id)) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'daily limit reached', type: 'rate_limit' } }));
        return;
      }
      if (m.hang) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        setTimeout(() => { try { res.end(); } catch {} }, m.ms);
        return;
      }
      setTimeout(() => {
        if (m.status !== 200) {
          res.writeHead(m.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      }, m.ms);
    });
  });
  server.hits = hits; server.probeHits = probeHits; server.raceHits = raceHits;
  return server;
}

async function setup(eng, port) {
  const refs = [];
  for (let i = 0; i < HEAD.length; i++) {
    const m = HEAD[i];
    const node = (await eng.api('POST', '/api/provider-nodes', {
      type: 'openai-compatible', name: 'czek-ai · mock' + i, prefix: 'mock' + i,
      apiType: 'chat', baseUrl: `http://127.0.0.1:${port}`, chatPath: '/v1/chat/completions',
    })).node;
    if (!node?.id) throw new Error('provider-node: ' + JSON.stringify(node).slice(0, 200));
    await eng.api('POST', '/api/providers', { provider: node.id, apiKey: 'mock-key', name: 'mock' + i, proxyEnabled: false, isActive: true }).catch(() => {});
    await eng.ensureKey();
    await eng.api('POST', '/api/provider-models', {
      provider: node.id, modelId: m.id, modelName: m.id, isFree: true,
      max_input_tokens: 128000, max_output_tokens: 8192,
    }).catch(() => {});
    refs.push({ ref: 'mock' + i + '/' + m.id, provider: 'mock' + i, id: m.id });
  }
  eng.baseLists.set('zdarma-max', refs);
  // OmniRoute persists its own DB across restarts: the combo already exists in lifetime 2
  await eng.api('POST', '/api/combos', { name: 'zdarma-max', displayName: 'Max', description: 'zdarma-tier',
    strategy: 'priority', enabled: true, models: refs.map((r) => r.ref) }).catch(() => {});
  return refs;
}

const idOf = (kk) => String(kk).split('/').pop();

async function lifetime(dir, port, mock, tag) {
  const eng = new OmniRoute({ dataDir: dir, log: () => {} });
  const out = { tag };
  const t0 = Date.now();
  await eng.start();
  out.omniStartS = s10(Date.now() - t0);
  const refs = await setup(eng, port);
  const idOfRef = (r) => r.id;
  // In the real app loadHashes() runs inside the startup sync before any probing;
  // the harness calls it here so the restart actually exercises the disk cache.
  eng.loadHashes();

  // disk state at the beginning of this lifetime
  const syncPath = path.join(dir, 'zdarma-sync.json');
  const sync = fs.existsSync(syncPath) ? JSON.parse(fs.readFileSync(syncPath, 'utf8')) : {};
  out.diskDemotionsAtStart = Object.keys(sync.probeSlow || sync.slow || {}).map(idOf).sort();

  // what the code knows about slow models right after start (before any probing)
  out.restoredSlow = [...eng.probeSlow.keys()].map(idOf).sort();

  const p = await eng.probeHeads();
  out.round1 = { probed: p.probed, spanMs: p.spanMs, timedOut: p.timedOut, probePaused: p.probePaused || 0 };
  const probesBefore = { ...mock.probeHits };

  // agent already works while round 2 runs in background – exactly the startup window
  const proxy = createRaceProxy({
    target: () => eng.url,
    candidates: (model, total, racers) => eng.raceCandidates(model, total, racers) || [],
    n: () => 2, hedgeMs: 0, log: () => {},
  });
  await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
  const pp = proxy.server.address().port;

  const step = async () => {
    const before = { ...mock.raceHits };
    const t = Date.now();
    let status = 0, err = null;
    try {
      const r = await fetch(`http://127.0.0.1:${pp}/v1/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${eng.apiKey}` },
        body: JSON.stringify({ model: 'zdarma-max', stream: true, max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with OK.' }] }),
      });
      status = r.status;
      const text = await r.text();
      if (!r.ok) err = text.slice(0, 200);
    } catch (e) { err = e.message; }
    const calls = {};
    for (const id of HEAD.map((m) => m.id)) {
      const d = (mock.raceHits[id] || 0) - (before[id] || 0);
      if (d > 0) calls[id] = d;
    }
    return { status, ms: Date.now() - t, error: err, calls,
      raceCalls: Object.values(calls).reduce((a, b) => a + b, 0),
      wasteCalls: Object.entries(calls).reduce((a, [id, c]) => a + (WASTE.has(id) ? c : 0), 0) };
  };

  const warm = [];
  for (let i = 0; i < WARM_STEPS; i++) { warm.push(await step()); await new Promise((r) => setTimeout(r, GAP_MS)); }
  out.warm = { timesMs: warm.map((x) => x.ms), medianMs: med(warm.map((x) => x.ms)),
    raceCalls: warm.reduce((a, x) => a + x.raceCalls, 0), wasteCalls: warm.reduce((a, x) => a + x.wasteCalls, 0) };

  const sp = eng.slowPassing ? await eng.slowPassing : null;
  out.round2 = { checked: sp?.checked ?? 0, slowAnswered: sp?.slow ?? 0, demotedInMemory: [...eng.probeSlow.keys()].map(idOf).sort() };
  out.probeHitsSlow = SLOW.size ? [...SLOW].map((id) => mock.probeHits[id] - (probesBefore[id] || 0)) : [];

  const head = eng.arrange(eng.baseLists.get('zdarma-max') || []).slice(0, 6).map((x) => x.id);
  out.headTop6 = head;
  out.slowInHeadTop6 = head.filter((id) => SLOW.has(id)).length;

  // coverage: fast models hit their limit → only the tail (slow/limited) is left; step time shows
  // whether the demoted slow models are still racing as primary candidates
  mock.limitFast = true;
  const cov = [];
  for (let i = 0; i < COVERAGE_STEPS; i++) { cov.push(await step()); await new Promise((r) => setTimeout(r, GAP_MS)); }
  mock.limitFast = false;
  out.coverage = { timesMs: cov.map((x) => x.ms), medianMs: med(cov.map((x) => x.ms)),
    wasteCalls: cov.reduce((a, x) => a + x.wasteCalls, 0), failures: cov.filter((x) => x.status !== 200).length };

  const syncAfter = fs.existsSync(syncPath) ? JSON.parse(fs.readFileSync(syncPath, 'utf8')) : {};
  out.diskDemotionsAtEnd = Object.keys(syncAfter.probeSlow || syncAfter.slow || {}).map(idOf).sort();

  proxy.server.close();
  eng.stop();
  return out;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-restart-'));
  const dir = path.join(root, 'omniroute');
  const mock = makeMock();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;

  const run1 = await lifetime(dir, port, mock, 'run1 (first start)');
  const run2 = await lifetime(dir, port, mock, 'run2 (restart)');

  const checks = {
    demotionsKnownAfterRestart: run2.restoredSlow.length,
    demotionsOnDiskAfterRestart: run2.diskDemotionsAtStart.length,
    slowModelsInHeadTop6: { run1: run1.slowInHeadTop6, run2: run2.slowInHeadTop6 },
    round1ProbeSpanMs: { run1: run1.round1.spanMs, run2: run2.round1.spanMs },
    probeCallsOnSlowModels: { run1: run1.probeHitsSlow, run2: run2.probeHitsSlow },
    warmStepMedianMs: { run1: run1.warm.medianMs, run2: run2.warm.medianMs },
    warmWasteCalls: { run1: run1.warm.wasteCalls, run2: run2.warm.wasteCalls },
    coverageMedianMs: { run1: run1.coverage.medianMs, run2: run2.coverage.medianMs },
    coverageWasteCalls: { run1: run1.coverage.wasteCalls, run2: run2.coverage.wasteCalls },
    PASS: run2.diskDemotionsAtStart.length >= SLOW.size &&
      run2.restoredSlow.length >= SLOW.size &&
      run2.slowInHeadTop6 === 0 &&
      run2.warm.wasteCalls === 0 &&
      run2.round1.spanMs < run1.round1.spanMs,
  };
  console.log(JSON.stringify({ run1, run2, checks }, null, 1));
  mock.close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(checks.PASS ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
