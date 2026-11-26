'use strict';
// Kontrola čela tierů (probeHeads) jede každých 30 min. Model, který v posledních
// PROBE_FRESH_MS (2 h) dokázal odpovědět – ať už probe dotazem nebo skutečným krokem agenta –
// nemusí dokazovat, že żyje. Gating skippuje jen modely, u kterých je poslední doklad úspěch;
// model, který naposledy selhal, se probejne vždy.
//
// A/B je izolované: each rep = fresh OmniRoute + fresh mock. Měřeno přes skutečný závod
// (src/race.js) + skutečný OmniRoute proti lokálnímu mocku: žádná síť, žádná kvóta, opakovatelné.
// Použití: node test/omni-probe-gate.js [--out=...]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const { OmniRoute } = require(path.join(ROOT, 'src/omniroute'));
const { createRaceProxy } = require(path.join(ROOT, 'src/race'));
process.env.ZDARMA_OMNIROUTE_ROOT ||= path.join(os.homedir(), '.local/share/czek-bench/node_modules/omniroute');

const arg = (n, d) => { const eq = process.argv.find((a) => a.startsWith('--' + n + '=')); return eq ? eq.split('=')[1] : d; };
const s10 = (ms) => Math.round(ms / 100) / 10;
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

// Čelo tieru Max: 6 modelů (strop RACE_TOP = 6). Jeden z nich („die0“) uprostřed rep
// zemře – mock z něj začne vracet 503. Rest are healthy and fast.
const HEAD = [
  { id: 'fast0', ms: 300, status: 200 },
  { id: 'fast1', ms: 360, status: 200 },
  { id: 'fast2', ms: 420, status: 200 },
  { id: 'fast3', ms: 300, status: 200 },
  { id: 'fast4', ms: 340, status: 200 },
  { id: 'die0', ms: 320, status: 200 },
];
const GAP_MS = 500;          // pause between agent steps
const ROUNDS = 4;            // probe rounds: 1 at start, then 3 „background“ rounds

function makeMock() {
  const hits = {}, probeHits = {}, raceHits = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
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
      if (Number(b.max_tokens) >= 16) probeHits[id] = (probeHits[id] || 0) + 1; else raceHits[id] = (raceHits[id] || 0) + 1;
      if (!m) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"unknown"}'); return; }
      if (server.dead && id === 'die0') {
        server.deadHits = (server.deadHits || 0) + 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model unavailable', type: 'server_error' } }));
        return;
      }
      setTimeout(() => {
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

async function runRep(freshMs) {
  const mock = makeMock();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-gate-')));
  const logs = [];
  const eng = new OmniRoute({ dataDir: path.join(root, 'omniroute'), log: (m) => logs.push(m) });
  const out = { freshMs };
  const prev = process.env.ZDARMA_PROBE_FRESH_MS;
  process.env.ZDARMA_PROBE_FRESH_MS = String(freshMs);
  let proxy = null;
  try {
    const t0 = Date.now();
    await eng.start();
    out.omniStartS = s10(Date.now() - t0);

    const refs = [];
    for (let i = 0; i < HEAD.length; i++) {
      const m = HEAD[i];
      const node = (await eng.api('POST', '/api/provider-nodes', {
        type: 'openai-compatible', name: 'czek-ai · mock' + i, prefix: 'mock' + i,
        apiType: 'chat', baseUrl: `http://127.0.0.1:${port}`, chatPath: '/v1/chat/completions',
      })).node;
      if (!node?.id) throw new Error('provider-node: ' + JSON.stringify(node).slice(0, 200));
      await eng.api('POST', '/api/providers', { provider: node.id, apiKey: 'mock-key', name: 'mock' + i, proxyEnabled: false, isActive: true });
      await eng.ensureKey();
      await eng.api('POST', '/api/provider-models', {
        provider: node.id, modelId: m.id, modelName: m.id, isFree: true,
        max_input_tokens: 128000, max_output_tokens: 8192,
      });
      refs.push({ ref: 'mock' + i + '/' + m.id, provider: 'mock' + i, id: m.id });
    }
    eng.baseLists.set('zdarma-max', refs);
    await eng.api('POST', '/api/combos', { name: 'zdarma-max', displayName: 'Max', description: 'zdarma-tier',
      strategy: 'priority', enabled: true, models: refs.map((r) => r.ref) });

    const raceLog = [];
    proxy = createRaceProxy({
      target: () => eng.url,
      candidates: (model, total, racers) => eng.raceCandidates(model, total, racers) || [],
      n: () => HEAD.length, log: (m) => raceLog.push(m),
    });
    await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
    const pp = proxy.server.address().port;

    const probeTotal = () => Object.values(mock.probeHits).reduce((a, b) => a + b, 0);
    const steps = [];
    const step = async () => {
      const before = { ...mock.raceHits };
      const t = Date.now();
      let status = 0, err = null;
      try {
        const r = await fetch(`http://127.0.0.1:${pp}/v1/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(120000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${eng.apiKey}` },
          body: JSON.stringify({ model: 'zdarma-max', stream: true, max_tokens: 8,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
            tool_choice: 'auto' }),
        });
        status = r.status;
        const text = await r.text();
        if (!r.ok) err = text.slice(0, 200);
      } catch (e) { err = e.message; }
      const calls = {};
      for (const id of Object.keys(mock.raceHits)) {
        const d = (mock.raceHits[id] || 0) - (before[id] || 0);
        if (d > 0) calls[id] = d;
      }
      const st = { at: t, status, ms: Date.now() - t, error: err, calls,
        raceCalls: Object.values(calls).reduce((a, b) => a + b, 0),
        dieCalls: calls.die0 || 0 };
      steps.push(st);
      return st;
    };
    const round = async (n) => {
      const mark = probeTotal();
      const p = await eng.probeHeads();
      out.rounds.push({ round: n, probed: p.probed, skipped: p.skipped || 0, spanMs: p.spanMs, probePaused: p.probePaused || 0 });
      out.roundProbeCalls.push(probeTotal() - mark);
      return p;
    };
    out.rounds = []; out.roundProbeCalls = [];

    // 1. round = start appky (okAt je prázdný → probejne ALL)
    await round(1);
    await eng.syncCooldowns();

    // agent worked: steps + rebalance = doklad odpovědi ze skutečných kroků
    const steady = [];
    for (let i = 0; i < 4; i++) { steady.push(await step()); await new Promise((r) => setTimeout(r, GAP_MS)); }
    await eng.rebalance();
    out.okAtAfterSteady = eng.okAt.size;
    out.failAtAfterSteady = eng.failAt.size;

    // 2. round: healthy models have fresh proof
    await round(2);

    // model uprostřed rep zemře
    const killAt = Date.now();
    mock.dead = true;
    for (let i = 0; i < 3; i++) { await step(); await new Promise((r) => setTimeout(r, GAP_MS)); }
    await eng.rebalance();
    out.failAtDie = eng.failAt.get('mock5/die0') ? Date.now() - killAt : null;
    await round(3);
    await eng.syncCooldowns();
    await eng.rebalance();
    out.failAtAfterRound3 = [...eng.failAt.entries()].map(([k, v]) => [k, Date.now() - v]);
    out.dieLogRows = (await eng.api('GET', '/api/usage/call-logs?limit=300'))
      .filter((r) => String(r.model || '').includes('die0'))
      .slice(-6).map((r) => ({ provider: r.provider, model: r.model, status: r.status, duration: r.duration }));

    let detectMs = null;
    for (let i = 0; i < 4; i++) {
      const st = await step();
      if (!st.dieCalls && detectMs === null) detectMs = Date.now() - killAt;
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    out.detectMs = detectMs;
    out.dieRaceCallsAfterKill = steps.filter((s) => s.at >= killAt).reduce((a, s) => a + s.dieCalls, 0);
    out.failuresAfterKill = steps.filter((s) => s.at >= killAt && s.status !== 200).length;
    out.probeCallsTotal = probeTotal();
    out.raceCallsTotal = steps.reduce((a, s) => a + s.raceCalls, 0);
    out.stepMsMedian = med(steps.map((s) => s.ms));
    out.probeGateLog = logs.filter((m) => /kontrola zdraví/.test(m)).map((m) => m.slice(0, 240));
    return out;
  } finally {
    if (prev === undefined) delete process.env.ZDARMA_PROBE_FRESH_MS; else process.env.ZDARMA_PROBE_FRESH_MS = prev;
    try { eng.stop(); } catch {}
    try { mock.closeAllConnections(); } catch {}
    mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const A = await runRep(0);          // no gating (each round re-probes the whole head)
  const B = await runRep(2 * 60 * 60 * 1000); // gating: shipped default 2 h
  const res = {
    when: new Date().toISOString(), node: process.version, mock: true,
    A: { arm: 'A-ungated (ZDARMA_PROBE_FRESH_MS=0)', ...A },
    B: { arm: 'B-gated (default 2 h)', ...B },
    deltas: {
      probeCalls: A.probeCallsTotal - B.probeCallsTotal,
      probeCallsPct: A.probeCallsTotal ? Math.round((A.probeCallsTotal - B.probeCallsTotal) / A.probeCallsTotal * 100) : 0,
      detectMs: (B.detectMs ?? 0) - (A.detectMs ?? 0),
      failures: B.failuresAfterKill - A.failuresAfterKill,
      stepMsMedian: B.stepMsMedian - A.stepMsMedian,
    },
    gates: {
      probesDown: B.probeCallsTotal <= A.probeCallsTotal / 2,
      detectionNotWorse: (B.detectMs ?? 0) <= (A.detectMs ?? 0) + 3000,
      failuresNotWorse: B.failuresAfterKill <= A.failuresAfterKill,
      round3ProbesSmall: B.rounds[2].probed <= 2,
    },
  };
  res.pass = Object.values(res.gates).every(Boolean);
  const out = arg('out', path.join(ROOT, 'docs/research/loop-czek-perf/results/probe-gate-2026-11-23.json'));
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(JSON.stringify({ rounds: { A: res.A.rounds, B: res.B.rounds }, probeCalls: { A: res.A.probeCallsTotal, B: res.B.probeCallsTotal }, detectMs: { A: res.A.detectMs, B: res.B.detectMs }, failures: { A: res.A.failuresAfterKill, B: res.B.failuresAfterKill }, stepMsMedian: { A: res.A.stepMsMedian, B: res.B.stepMsMedian }, gates: res.gates, pass: res.pass }, null, 2));
  process.exit(0);
})();
