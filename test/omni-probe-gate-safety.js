'use strict';
// Jistka gatingu kontroly čela tierů (probeHeads). Dvě věci, které šli dohromady:
//  1) KLÍČE DOKLADů: gate čte okAt/failAt pod klíč `${provider}/${id}` z combo; doklad ze
//     skutečných kroků agenta se zapisoval pod klíč derived from OmniRoute's provider node.
//     When OmniRoute reports a node id the node map does not know (sync not finished, node added
//     by hand), the řádka se vyhodila → failAt zůstal prázdný → gate probejne model, který už selhal.
//     Fix: providerOfModel(model) – poskytovatel podle modelového jména (unique hit, otherwise null).
//  2) PROBE_SKIP_MAX (=3): po 3 vynechaných kole se čela svolá znovu. Bez stropu by
//     "čerstvý doklad" (2 h) znamenal, že čelo never dostalo kontrolu – tichě mrtvý model by
//     zůstal v čele combo a závod by do něj sálal dotazy.
// 5 ramen, each = fresh OmniRoute + fresh mock (real race proxy). No network, no keys, repeatable.
// Použití: node test/omni-probe-gate-safety.js [--out=docs/research/loop-czek-perf/results/probe-gate-safety-<date>.json]
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

// Čelo tieru Max (strop RACE_TOP = 6). „die0“ zemře uprostřed rep → mock z něj vrací 503.
const HEAD = [
  { id: 'fast0', ms: 300, status: 200 },
  { id: 'fast1', ms: 360, status: 200 },
  { id: 'fast2', ms: 420, status: 200 },
  { id: 'fast3', ms: 300, status: 200 },
  { id: 'fast4', ms: 340, status: 200 },
  { id: 'die0', ms: 320, status: 200 },
];
const GAP_MS = Number(process.env.ZDARMA_TEST_GAP_MS || 350);
const ROUNDS = 6;
const FRESH = 2 * 60 * 60 * 1000;

function makeMock() {
  const probeHits = {}, raceHits = {};
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
      if (Number(b.max_tokens) >= 16) probeHits[id] = (probeHits[id] || 0) + 1; else raceHits[id] = (raceHits[id] || 0) + 1;
      if (!m) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"unknown"}'); return; }
      if (server.dead && id === 'die0') {
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
  server.probeHits = probeHits; server.raceHits = raceHits;
  return server;
}

async function runArm(cfg) {
  const mock = makeMock();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-safety-')));
  const logs = [];
  const eng = new OmniRoute({ dataDir: path.join(root, 'omniroute'), log: (m) => logs.push(m) });
  const env = {
    ZDARMA_PROBE_FRESH_MS: String(cfg.freshMs),
    ZDARMA_PROBE_SKIP_MAX: String(cfg.skipMax),
    ZDARMA_MODEL_FALLBACK: cfg.fallback,
    ZDARMA_PROBE_FAIL_ON_ZERO: cfg.failOnZero ? '1' : '0',
  };
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  let proxy = null;
  try {
    const t0 = Date.now();
    await eng.start();
    const out = { arm: cfg.name, freshMs: cfg.freshMs, skipMax: cfg.skipMax, fallback: cfg.fallback, nodeMap: cfg.nodeMap, failOnZero: !!cfg.failOnZero };
    out.omniStartS = s10(Date.now() - t0);

    const refs = [];
    for (let i = 0; i < HEAD.length; i++) {
      const m = HEAD[i];
      const node = (await eng.api('POST', '/api/provider-nodes', {
        type: 'openai-compatible', name: 'czek-ai · mock' + i, prefix: 'mock' + i,
        apiType: 'chat', baseUrl: `http://127.0.0.1:${port}`, chatPath: '/v1/chat/completions',
      })).node;
      if (!node?.id) throw new Error('provider-node: ' + JSON.stringify(node).slice(0, 200));
      if (cfg.nodeMap) eng.nodeToProvider.set(node.id, 'mock' + i); // real life: filled by sync
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
      n: () => HEAD.length, hedgeMs: 0, log: (m) => raceLog.push(m),
    });
    await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
    const pp = proxy.server.address().port;

    const probeTotal = () => Object.values(mock.probeHits).reduce((a, b) => a + b, 0);
    const probeDie = () => mock.probeHits.die0 || 0;
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
        raceCalls: Object.values(calls).reduce((a, b) => a + b, 0), dieCalls: calls.die0 || 0 };
      steps.push(st);
      return st;
    };
    const rounds = [], roundCalls = [];
    const round = async (n) => {
      const mark = probeTotal();
      const p = await eng.probeHeads();
      rounds.push({ round: n, probed: p.probed, skipped: p.skipped || 0, spanMs: p.spanMs });
      roundCalls.push(probeTotal() - mark);
      return p;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // kolo 1 = start appky: okAt prázdný → probejne ALL
    await round(1);
    await eng.syncCooldowns();
    // agent worked: kroky + rebalance = doklad odpovědi ze skutečných kroků
    for (let i = 0; i < 4; i++) { await step(); await sleep(GAP_MS); }
    await eng.rebalance();
    out.okAtAfterSteady = eng.okAt.size;
    out.failAtAfterSteady = eng.failAt.size;
    out.recoveredRows = eng.speedDiag?.recovered || 0;   // řádky saved jen благодаря fallback
    out.skippedRows = Object.values(eng.speedDiag?.skipped || {}).reduce((a, b) => a + b, 0);

    await round(2);
    const killAt = Date.now();
    mock.dead = true;                                  // model uprostřed rep zemře
    for (let i = 0; i < 3; i++) { await step(); await sleep(GAP_MS); }
    await eng.rebalance();
    const failAt = eng.failAt.get('mock5/die0');
    out.failAtDieAgeMs = failAt ? Date.now() - failAt : null;

    await round(3);
    out.probeCallsToDieAfterKill = probeDie();
    out.headAfterRound3 = eng.arrange(eng.baseLists.get('zdarma-max')).slice(0, 6).map((x) => x.id);
    out.diePausedAfterRound3 = eng.isPaused({ provider: 'mock5', id: 'die0' });
    const dieRows = (await eng.api('GET', '/api/usage/call-logs?limit=300'))
      .filter((r) => String(r.model || '').includes('die0'));
    out.dieLogRows = dieRows.slice(-4).map((r) => ({ provider: r.provider, model: r.model, status: r.status }));
    out.dieNon200Rows = dieRows.filter((r) => Number(r.status) !== 200)
      .map((r) => ({ status: Number(r.status), duration: Number(r.duration) || 0, provider: r.provider }));
    // rebalance po probe: doklad selhání (503) musí být spárovaný s combo-ref; bez fallback se
    // řádky s poskytovatelem „openai-compatible-chat-<uuid>“ zahodí → failAt zůstává prázdný
    await eng.rebalance();
    out.pairOkRows = eng.speedDiag?.okPairs || 0;   // řádky sparované jen dzięki jménu modelu
    out.pairFailRows = eng.speedDiag?.failPairs || 0;
    out.unpairedRows = Object.values(eng.speedDiag?.skipped || {}).reduce((a, b) => a + b, 0);
    out.failAtAfterProbe = eng.failAt.size;

    // histogram stavů: doklad, že řádky se stavem 0 („No HTTP response observed“) jsou běžné i u
    // zdravých modelů čela – gate nesmí z nich dělat doklad selhání
    const hist = {};
    const rows = await eng.api('GET', '/api/usage/call-logs?limit=300');
    for (const r of rows) hist[String(r.status)] = (hist[String(r.status)] || 0) + 1;
    out.statusHistogram = hist;
    // kolik řádků stavu 0 visí na ZDRAVÝCH modelech čela – to jsou ty, které by gate jako selhání读取
    out.zeroRowsOnHealthyHeads = rows.filter((r) => Number(r.status) === 0
      && HEAD.some((h) => h.id !== 'die0' && String(r.model || '').includes(h.id))).length;

    let detectMs = null;
    for (let i = 0; i < 4; i++) {
      const st = await step();
      if (!st.dieCalls && detectMs === null) detectMs = Date.now() - killAt;
      await sleep(GAP_MS);
    }
    out.detectMs = detectMs;

    // kolo 4..6: measuring PROBE_SKIP_MAX (stale „alive“ proof must be re-verified)
    for (let n = 4; n <= ROUNDS; n++) {
      await round(n);
      await step(); await sleep(GAP_MS);
    }
    out.rounds = rounds;
    out.roundProbeCalls = roundCalls;
    out.probeCallsTotal = probeTotal();
    out.probedRounds = rounds.filter((r) => r.probed > 0).map((r) => r.round);
    const pr = out.probedRounds;
    out.maxProbeStalenessRounds = pr.length > 1 ? Math.max(...pr.map((r, i) => (i + 1 < pr.length ? pr[i + 1] - r : 0)), ROUNDS - pr[pr.length - 1]) : ROUNDS;
    out.dieRaceCallsAfterKill = steps.filter((s) => s.at >= killAt).reduce((a, s) => a + s.dieCalls, 0);
    out.failuresAfterKill = steps.filter((s) => s.at >= killAt && s.status !== 200).length;
    out.raceCallsTotal = steps.reduce((a, s) => a + s.raceCalls, 0);
    out.stepMsMedian = med(steps.map((s) => s.ms));
    out.probeGateLog = logs.filter((m) => /kontrola zdraví/.test(m)).map((m) => m.slice(0, 200));
    out.wallS = s10(Date.now() - t0);
    return out;
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (proxy?.server) { try { proxy.server.closeAllConnections(); } catch {} try { proxy.server.close(); } catch {} }
    try { eng.stop(); } catch {}
    try { mock.closeAllConnections(); } catch {}
    mock.close();
    // OmniRoute po stop() ještě chvíli dopisuje (záznamy zrušených streamů kontroly) → mazat s opakováním, ne shodit test
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {}
  }
}

(async () => {
  const arms = [
    { name: 'A-ungated (baseline)', freshMs: 0, skipMax: 3, fallback: '1', nodeMap: true },
    { name: 'B-gated, node map ok (real life)', freshMs: FRESH, skipMax: 3, fallback: '1', nodeMap: true },
    { name: 'C-gated, no node map, no fallback (BEFORE fix)', freshMs: FRESH, skipMax: 3, fallback: '0', nodeMap: false },
    { name: 'D-gated, no node map, fallback ON (AFTER fix)', freshMs: FRESH, skipMax: 3, fallback: '1', nodeMap: false },
    { name: 'E-gated, skip cap 999 (valve OFF)', freshMs: FRESH, skipMax: 999, fallback: '1', nodeMap: false },
    // F/G: knob ZDARMA_PROBE_FAIL_ON_ZERO – what if OmniRoute rows with status 0 counted as a failure proof?
    { name: 'F-gated + status 0 as failure (node map ok)', freshMs: FRESH, skipMax: 3, fallback: '1', nodeMap: true, failOnZero: true },
    { name: 'G-gated + status 0 as failure (no node map)', freshMs: FRESH, skipMax: 3, fallback: '1', nodeMap: false, failOnZero: true },
  ];
  const res = { when: new Date().toISOString(), node: process.version, mock: true, head: HEAD.map((h) => h.id), rounds: ROUNDS };
  for (const cfg of arms) res[cfg.name[0]] = { arm: cfg.name, ...await runArm(cfg) };

  const [A, B, C, D, E, F, G] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((k) => res[k]);
  res.gates = {
    // 1) doklad (ok) se sparuje i bez node mapy – thanks to the model name; without the fallback the
    // rows are dropped and failAt stays empty (measured: C 0 paired / 80 dropped, D 17 paired / 0 dropped)
    evidencePairedViaModelName: D.pairOkRows >= 1 && C.pairOkRows === 0 && C.unpairedRows >= 1 && D.unpairedRows === 0,
    unpairedWithoutFallback: C.unpairedRows >= 1 && D.unpairedRows === 0,
    // 2) gate re-probe model, whose last proof is a failure
    deadModelReprobed: D.probeCallsToDieAfterKill >= 1,
    // 3) gating still saves quota vs ungated
    probesDownVsUngated: D.probeCallsTotal <= A.probeCallsTotal,
    // 4) detection of the silent death not worse than ungated
    detectionNotWorse: (D.detectMs ?? 1e9) <= (A.detectMs ?? 1e9) + 3000,
    // 5) no user-visible failures added
    failuresNotWorse: D.failuresAfterKill <= A.failuresAfterKill,
    // 6) skip cap bounds staleness: with cap 999 the head is never re-verified
    capBoundsStaleness: D.maxProbeStalenessRounds < E.maxProbeStalenessRounds,
    capCostsProbes: D.probeCallsTotal > E.probeCallsTotal,
    // 7) status 0 rows are common on HEALTHY heads → they cannot be a failure proof for free
    status0RowsOnHealthyHeads: B.zeroRowsOnHealthyHeads >= 1,
    // 8) flipping the knob costs probes and writes failAt on healthy heads (measured F vs B)
    status0AsFailureCostsProbes: F.probeCallsTotal > B.probeCallsTotal,
    status0AddsFalseFailAt: F.failAtAfterProbe > B.failAtAfterProbe,
    // 9) ...and buys nothing: death detection and user-visible failures stay within noise
    status0DetectWithinNoise: Math.abs((F.detectMs ?? 0) - (B.detectMs ?? 0)) <= 500,
    status0FailuresUnchanged: F.failuresAfterKill === B.failuresAfterKill,
    // 10) silent death of a head model is caught by the race proxy, not by failAt rows from the call log
    // (499 < 30 s and status 0 rows are deliberately not failure evidence)
    silentDeathCaughtByRace: D.dieRaceCallsAfterKill === 0 && (D.detectMs ?? 1e9) <= 5000,
  };
  res.pass = Object.values(res.gates).every(Boolean);
  const out = arg('out', path.join(ROOT, 'docs/research/loop-czek-perf/results/probe-gate-safety-2026-11-23.json'));
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(JSON.stringify({
    probeCalls: { A: A.probeCallsTotal, B: B.probeCallsTotal, C: C.probeCallsTotal, D: D.probeCallsTotal, E: E.probeCallsTotal, F: F.probeCallsTotal, G: G.probeCallsTotal },
    zeroRowsOnHealthyHeads: { B: B.zeroRowsOnHealthyHeads, D: D.zeroRowsOnHealthyHeads, F: F.zeroRowsOnHealthyHeads, G: G.zeroRowsOnHealthyHeads },
    probedRounds: { B: B.probedRounds, D: D.probedRounds, E: E.probedRounds, F: F.probedRounds, G: G.probedRounds },
    dieNon200Rows: { B: B.dieNon200Rows, F: F.dieNon200Rows },
    stepMsMedian: { A: A.stepMsMedian, B: B.stepMsMedian, D: D.stepMsMedian, F: F.stepMsMedian },
    detectMs: { A: A.detectMs, B: B.detectMs, D: D.detectMs, F: F.detectMs },
    failuresAfterKill: { A: A.failuresAfterKill, B: B.failuresAfterKill, D: D.failuresAfterKill, F: F.failuresAfterKill },
    failAtAfterProbe: { B: B.failAtAfterProbe, D: D.failAtAfterProbe, F: F.failAtAfterProbe },
    pairRows: { C: [C.pairOkRows, C.pairFailRows, C.unpairedRows], D: [D.pairOkRows, D.pairFailRows, D.unpairedRows], F: [F.pairOkRows, F.pairFailRows, F.unpairedRows] },
    gates: res.gates, pass: res.pass,
  }, null, 2));
  process.exit(res.pass ? 0 : 1);
})();
