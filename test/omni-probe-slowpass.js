'use strict';
// Kontrola čela tierů ve dvou round: 1. round strop 10 s, 2. round (na pozadí) 25 s jen pro modely,
// které do 10 s ne odpověděly. Odpovědí-li v 2. round, nejsou mrtvé – jen pomalé: odsun na konec
// combo (coverage zůstává, závod je nepostaví do první dvojky), místo pauzy 5 min, která by je vyřadila
// z combo i jako náhradníka. Visící model dostává pauzu podle PROBE_PAUSE_MS.
// Měřeno A/B přes skutečný závod (src/race.js) + skutečný OmniRoute proti lokálnímu mocku:
// žádná síť, žádná kvóta, opakovatelné. Použití: node test/omni-probe-slowpass.js
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

// Čelo tieru Max (6 modelů, každý od jiného „poskytovatele“): 1 visící, 1 limit (429),
// 2 pomalé živé (14 s, 18 s = nad strop 1. round), 3 rychlé.
const HEAD = [
  { id: 'hang0', ms: 40000, status: 200, hang: true },
  { id: 'limited', ms: 400, status: 429 },
  { id: 'slow0', ms: 14000, status: 200 },
  { id: 'slow1', ms: 18000, status: 200 },
  { id: 'fast0', ms: 300, status: 200 },
  { id: 'fast1', ms: 380, status: 200 },
  { id: 'fast2', ms: 460, status: 200 },
];
const HANG = new Set(['hang0']);
const LIMITED = new Set(['limited']);
const SLOW = new Set(['slow0', 'slow1']);
const DEAD = new Set(['hang0', 'limited']); // mrtvé pro závod

function makeMock() {
  const hits = {};        // id → počet dotazů
  const probeHits = {};   // id → počet probe dotazů (kontrola posílá max_tokens 16/64, závod v testu 8)
  const raceHits = {};        // id → počet race dotazů (max_tokens 8) – probe dotazy se nepočítí
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
      if (Number(b.max_tokens) >= 16) probeHits[id] = (probeHits[id] || 0) + 1; else raceHits[id] = (raceHits[id] || 0) + 1;
      if (!m) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"unknown"}'); return; }
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

/**
 * onePass = true → ZDARMA_PROBE_SLOW_TIMEOUT_MS=0 (druh round vypnutá, chování před kolo 15).
 * onePass = false → default 25 s (druh round na pozadí).
 */
async function runConfig(label, onePass, steps = 3) {
  const mock = makeMock();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-slow-')));
  const eng = new OmniRoute({ dataDir: path.join(root, 'omniroute'), log: () => {} });
  const raceLog = [];
  const out = { label, slowTimeoutMs: onePass ? 0 : 25000 };
  const prev = process.env.ZDARMA_PROBE_SLOW_TIMEOUT_MS;
  if (onePass) process.env.ZDARMA_PROBE_SLOW_TIMEOUT_MS = '0'; else delete process.env.ZDARMA_PROBE_SLOW_TIMEOUT_MS;
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

    // 1. round
    const p = await eng.probeHeads();
    out.round1 = { probed: p.probed, spanS: s10(p.spanMs), probePaused: p.probePaused || 0, timedOut: p.timedOut || 0,
      dead: Object.entries(p.results || {}).filter(([, s]) => s !== 200).map(([r, s]) => [String(r).split('/').pop(), s || 'timeout']) };
    // start appky nesmí čekání: druh round běží na pozadí
    out.slowPassRunning = !!eng.slowPassing;
    const tAfterFast = Date.now();

    // syncCooldowns() musí přežit lokální pauzy i odsun
    const co = await eng.syncCooldowns();
    out.afterSync = { paused: co.paused, fromProbe: co.fromProbe };

    // závod ještě před dokončení 2. round (startup continueuje,Agent začne pracovat)
    const candBefore = eng.raceCandidates('zdarma-max', 6, 2);
    out.candidatesBeforeSlowPass = { n: candBefore.length, racers: candBefore.racers,
      head: candBefore.slice(0, Math.max(candBefore.racers, 2)),
      deadInHead: candBefore.slice(0, Math.max(candBefore.racers, 2)).filter((r) => DEAD.has(String(r).split('/').pop())).length };

    // 2. round na pozadí – dokončí se, dokud agent pracuje
    await eng.slowPassing;
    out.slowPassExtraS = s10(Date.now() - tAfterFast);
    const idOf = (kk) => String(kk).split('/').pop();
    out.demoted = [...eng.probeSlow.keys()].map(idOf).sort();
    out.stillPaused = HEAD.filter((m) => eng.isPaused({ provider: 'mock' + HEAD.indexOf(m), id: m.id })).map((m) => m.id);
    out.pausedKeys = [...eng.paused.keys()].map(idOf).sort();
    out.probePausedKeys = [...eng.probePaused.keys()].map(idOf).sort();

    const cand = eng.raceCandidates('zdarma-max', 6, 2);
    const arranged = eng.arrange(refs).map((x) => x.id);
    out.candidates = { n: cand.length, racers: cand.racers, head: cand.slice(0, Math.max(cand.racers, 2)),
      deadInHead: cand.slice(0, Math.max(cand.racers, 2)).filter((r) => DEAD.has(String(r).split('/').pop())).length,
      slowInTail: cand.filter((r) => SLOW.has(String(r).split('/').pop())).length,
      usableInCombo: refs.filter((r) => !eng.isPaused(r)).map((r) => r.id).filter((id) => !DEAD.has(id)).length,
      inCombo: arranged.length };

    const proxy = createRaceProxy({
      target: () => eng.url,
      candidates: (model, total, racers) => eng.raceCandidates(model, total, racers) || [],
      n: () => 2, log: (m, d) => raceLog.push(m),
    });
    await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
    const pp = proxy.server.address().port;
    const times = [];
    for (let i = 0; i < steps; i++) {
      const before = Object.values(mock.raceHits).reduce((a, b) => a + b, 0);
      const t = Date.now();
      try {
        const r = await fetch(`http://127.0.0.1:${pp}/v1/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(120000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${eng.apiKey}` },
          body: JSON.stringify({ model: 'zdarma-max', stream: true, max_tokens: 8,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
            tool_choice: 'auto' }),
        });
        const text = await r.text();
        times.push({ step: i + 1, status: r.status, ms: Date.now() - t, error: r.ok ? null : text.slice(0, 200),
          calls: Object.values(mock.hits).reduce((a, b) => a + b, 0) - before });
      } catch (e) {
        times.push({ step: i + 1, status: 0, ms: Date.now() - t, error: e.message });
      }
    }
    proxy.server.close();
    const fails = raceLog.filter((m) => /selhal|vypadl|fail/i.test(m));
    const ms = times.map((x) => x.ms);
    out.race = { timesMs: ms, medianMs: [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)],
      maxMs: Math.max(...ms), sumS: s10(ms.reduce((a, b) => a + b, 0)),
      raceFailures: fails.length, failures: fails.slice(0, 6),
      deadRaceCalls: [...DEAD].reduce((a, id) => a + (mock.raceHits[id] || 0), 0),
      slowRaceCalls: [...SLOW].reduce((a, id) => a + (mock.raceHits[id] || 0), 0),
      raceCalls: Object.values(mock.raceHits).reduce((a, b) => a + b, 0),
      probeCalls: Object.values(mock.probeHits).reduce((a, b) => a + b, 0) };

    // Náklad: 2. round nesmí násobit dotazy – druhá kontrola within SLOW_CHECK_MS už model nezkouší
    const probeBefore = Object.values(mock.probeHits).reduce((a, b) => a + b, 0);
    const r2 = await eng.probeHeads();
    await eng.slowPassing;
    out.secondRoundCost = { probeCallsBefore: probeBefore, probeCallsAfter: Object.values(mock.probeHits).reduce((a, b) => a + b, 0),
      round2Checked: r2.timedOut, probed2: r2.probed, spanS2: s10(r2.spanMs) };
    out.probeCallsByModel = mock.probeHits;
  } catch (e) {
    out.error = String(e.message);
  } finally {
    try { eng.stop(); } catch {}
    try { mock.closeAllConnections(); } catch {}
    mock.close();
    if (prev === undefined) delete process.env.ZDARMA_PROBE_SLOW_TIMEOUT_MS; else process.env.ZDARMA_PROBE_SLOW_TIMEOUT_MS = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
  return out;
}

async function unitChecks() {
  const o = new OmniRoute({ dataDir: '.' });
  o.log = () => {};
  const now = Date.now();
  o.probeSlow.set('p/slowA', { until: now + 30 * 60 * 1000, ms: 18000 });
  o.probeSlow.set('p/expired', { until: now - 1000, ms: 20000 });
  o.slowChecked.set('p/slowA', now - 60 * 60 * 1000);
  const r = { slowActive: o.isSlow({ provider: 'p', id: 'slowA' }), slowExpired: o.isSlow({ provider: 'p', id: 'expired' }),
    demoteKeptAfterSync: null };
  o.api = async () => ({ items: [] });
  const co = await o.syncCooldowns(now);
  r.slowActiveAfterSync = o.isSlow({ provider: 'p', id: 'slowA' });
  r.probeSlowPruned = !o.probeSlow.has('p/expired');
  r.slowCheckedGate = now - (o.slowChecked.get('p/slowA') || 0) < Number(process.env.ZDARMA_PROBE_SLOW_EVERY_MS || 2 * 60 * 60 * 1000);
  return { ...r, paused: co.paused };
}

(async () => {
  const A = await runConfig('1 round (strop 10 s, pomalé = pauza 5 min)', true);
  const B = await runConfig('2 round (10 s + 25 s na pozadí, pomalé = odsun)', false);
  const unit = await unitChecks();
  const res = { when: new Date().toISOString(), node: process.version, A, B, unit,
    deltas: {
      probeSpanS: [A.round1?.spanS, B.round1?.spanS],
      usableInCombo: [A.candidates?.usableInCombo, B.candidates?.usableInCombo],
      slowInRaceTail: [A.candidates?.slowInTail, B.candidates?.slowInTail],
      raceMedianMs: [A.race?.medianMs, B.race?.medianMs],
      raceFailures: [A.race?.raceFailures, B.race?.raceFailures],
      probeCalls: [A.secondRoundCost?.probeCallsBefore, B.secondRoundCost?.probeCallsBefore],
      secondRoundProbeCalls: [A.secondRoundCost?.probeCallsAfter - A.secondRoundCost?.probeCallsBefore,
        B.secondRoundCost?.probeCallsAfter - B.secondRoundCost?.probeCallsBefore],
    } };
  // výchozí výstup do tmp: běh testu nesmí přepsat archivní měření v docs/research (do archivu jen s --out=…)
  const out = arg('out', path.join(os.tmpdir(), 'czek-probe-slowpass.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
  const pass = !A.error && !B.error
    && unit.slowActive && !unit.slowExpired && unit.slowActiveAfterSync && unit.probeSlowPruned
    && (A.candidates?.usableInCombo ?? 0) < (B.candidates?.usableInCombo ?? 0)
    && (A.race?.raceFailures ?? 99) >= (B.race?.raceFailures ?? 99)
    && (B.race?.deadRaceCalls ?? 99) === 0
    && (B.secondRoundCost?.probeCallsAfter ?? 999) - (B.secondRoundCost?.probeCallsBefore ?? 0) <= 7;
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
})();
