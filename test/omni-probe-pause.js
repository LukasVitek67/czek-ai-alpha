'use strict';
// Kontrola pauz, které zapisuje kontrola čela tierů (probeHeads) – že syncCooldowns() je nepřepíše a
// že mrtvý model pak nezávodí. Dřív: OmniRoute zapisuje cooldown jen u některých selhání
// (timeout ani většina 429 se do /api/resilience/model-cooldowns nedostane) → syncCooldowns() postavil
// `paused` = new Map() a mrtvý model se vrátil do čela combo i do závodu.
// Měřeno A/B přes skutečný závod (src/race.js) proti skutečnému OmniRoute s lokálním mockem:
// žádná síť, žádná kvóta, opakovatelné. Použití: node test/omni-probe-pause.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const { OmniRoute } = require(path.join(ROOT, 'src/omniroute'));
const { createRaceProxy } = require(path.join(ROOT, 'src/race'));
process.env.ZDARMA_OMNIROUTE_ROOT ||= path.join(os.homedir(), '.local/share/czek-bench/node_modules/omniroute');

const SECRET = /(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|hf_[A-Za-z0-9_-]{8,})/g;
const arg = (n, d) => { const eq = process.argv.find((a) => a.startsWith('--' + n + '=')); return eq ? eq.split('=')[1] : d; };
const s10 = (ms) => Math.round(ms / 100) / 10;

// Čelo tieru Max (6 modelů, každý od jiného "poskytovatele" – raceCandidates vyžaduje diverzitu):
// 2 visící, 1 limit (429), 1 pomalý (12 s = nad strop kontrolu 10 s), 3 rychlé.
// Pořadí = přesně to, jak by modely zůstaly v čele combo, když pauza nevydrží.
const HEAD = [
  { id: 'hang0', ms: 60000, status: 200, hang: true },
  { id: 'limited', ms: 400, status: 429 },
  { id: 'slow0', ms: 12000, status: 200 },
  { id: 'fast0', ms: 300, status: 200 },
  { id: 'fast1', ms: 380, status: 200 },
  { id: 'fast2', ms: 460, status: 200 },
];
const DEAD = new Set(['hang0', 'limited', 'slow0']);

function makeMock() {
  const hits = {};
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      if (!/chat\/completions$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: HEAD.map((m) => ({ id: m.id })) }));
        return;
      }
      const id = String(b.model || '').split('/').pop();
      const m = HEAD.find((x) => x.id === id);
      hits[id] = (hits[id] || 0) + 1;
      if (!m) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"unknown"}'); return; }
      if (m.hang) { // visí: headers sent, žádný data – OmniRoute si model odsunuje sám (readiness timeout)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        setTimeout(() => { try { res.end(); } catch {} }, m.ms);
        return;
      }
      setTimeout(() => {
        if (m.status !== 200) {
          res.writeHead(m.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      }, m.ms);
    });
  });
  server.hits = hits;
  return server;
}

/** Setup: OmniRoute + mock + 6 providerů + combo zdarma-max. probePauseEnv = hodnota ZDARMA_PROBE_PAUSE. */
async function runConfig(label, probePauseEnv, steps = 3) {
  const mock = makeMock();
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-pause-')));
  const eng = new OmniRoute({ dataDir: path.join(root, 'omniroute'), log: () => {} });
  const raceLog = [];
  const out = { label, ZDARMA_PROBE_PAUSE: probePauseEnv };
  const prevEnv = process.env.ZDARMA_PROBE_PAUSE;
  if (probePauseEnv === undefined) delete process.env.ZDARMA_PROBE_PAUSE; else process.env.ZDARMA_PROBE_PAUSE = probePauseEnv;
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
    // combo registrujeme jako appka (sync): fallback „dotaz na celé combo“ existuje, jako v live
    await eng.api('POST', '/api/combos', { name: 'zdarma-max', displayName: 'Max', description: 'zdarma-tier',
      strategy: 'priority', enabled: true, models: refs.map((r) => r.ref) });

    // 1) kontrola čela tierů – volání jako v src/main.js po startu
    const p = await eng.probeHeads();
    out.probe = { probed: p.probed, spanS: s10(p.spanMs), probePaused: p.probePaused || 0,
      statuses: p.results, dead: Object.entries(p.results || {}).filter(([, s]) => s !== 200).map(([r, s]) => [r.split('/')[1], s]) };

    // 2) syncCooldowns(): OmniRoute sestavuje `paused` znovu; lokální pauzy z probe musí přežit
    const co = await eng.syncCooldowns();
    out.afterSync = { paused: co.paused, fromProbe: co.fromProbe,
      stillPaused: HEAD.filter((m) => eng.isPaused({ provider: 'mock' + HEAD.indexOf(m), id: m.id })).map((m) => m.id) };

    // 3) závod: kdo skutečně nastoupí do první dvojky
    const cand = eng.raceCandidates('zdarma-max', 6, 2);
    out.candidates = { n: cand.length, racers: cand.racers, head: cand.slice(0, Math.max(cand.racers, 2)),
      deadInHead: cand.slice(0, Math.max(cand.racers, 2)).filter((r) => DEAD.has(String(r).split('/').pop())).length };

    const proxy = createRaceProxy({
      target: () => eng.url,
      candidates: (model, total, racers) => eng.raceCandidates(model, total, racers) || [],
      n: () => 2, log: (m, d) => raceLog.push(m),
    });
    await new Promise((r) => proxy.server.listen(0, '127.0.0.1', r));
    const pp = proxy.server.address().port;
    const times = [];
    for (let i = 0; i < steps; i++) {
      const before = Object.entries(mock.hits).reduce((a, [, v]) => a + v, 0);
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
        times.push({ step: i + 1, status: r.status, ms: Date.now() - t,
          error: r.ok ? null : text.slice(0, 200), calls: Object.entries(mock.hits).reduce((a, [, v]) => a + v, 0) - before });
      } catch (e) {
        times.push({ step: i + 1, status: 0, ms: Date.now() - t, error: e.message });
      }
    }
    proxy.server.close();
    const fails = raceLog.filter((m) => /selhal|vypadl|fail/i.test(m));
    const ms = times.map((x) => x.ms);
    const deadHits = [...DEAD].reduce((a, id) => a + (mock.hits[id] || 0), 0);
    out.race = { steps: times, timesMs: ms, medianMs: ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)],
      maxMs: Math.max(...ms), sumS: s10(ms.reduce((a, b) => a + b, 0)),
      raceFailures: fails.length, failures: fails.slice(0, 8), deadUpstreamCalls: deadHits,
      totalUpstreamCalls: Object.values(mock.hits).reduce((a, b) => a + b, 0), stats: proxy.stats };
  } catch (e) {
    out.error = String(e.message);
  } finally {
    try { eng.stop(); } catch {}
    mock.close();
    if (prevEnv === undefined) delete process.env.ZDARMA_PROBE_PAUSE; else process.env.ZDARMA_PROBE_PAUSE = prevEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
  return out;
}

// Unit: pauza z probeHeads nesmí přepíšit dlouhou pauzu OmniRoute, musí vypršet a musí se zapisovat
async function unitChecks() {
  const o = new OmniRoute({ dataDir: '.' });
  o.log = () => {};
  // OmniRoute cooldown API bez startu: simulace – delší pauza OmniRoute musí vyhrát, probe ji nesmí zkrátit
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  o.api = async () => ({ items: [{ provider: 'p', model: 'long', remainingMs: HOUR, reason: '429', failureCount: 3 }] });
  o.pausedSince.set('p/long', now);
  o.probePaused.set('p/long', { until: now + 5 * 60 * 1000, status: 0, ref: 'x/long', since: now });
  o.probePaused.set('p/expired', { until: now - 1000, status: 429, ref: 'x/expired', since: now - 5000 });
  o.probePaused.set('p/new', { until: now + 20 * 60 * 1000, status: 429, ref: 'x/new', since: now });
  const r = await o.syncCooldowns(now);
  return {
    omniRoutePauseWins: Math.abs(o.paused.get('p/long').until - (now + HOUR)) < 1000,
    localPausesKept: r.fromProbe === 1,
    expiredProbeDropped: !o.paused.has('p/expired') && !o.probePaused.has('p/expired'),
    newProbePauseLogged: o.paused.get('p/new')?.reason === 'kontrola čela (429)',
    isPausedStill: o.isPaused({ provider: 'p', id: 'long' }),
    probePauseFromTimeoutKept: Math.abs((o.probePaused.get('p/long')?.until || 0) - (now + 5 * 60 * 1000)) < 1000,
  };
}

(async () => {
  const A = await runConfig('A: pauzy z kontrolu čela se nezapisují (ZDARMA_PROBE_PAUSE=0 – stav před)', '0');
  const B = await runConfig('B: pauzy z kontrolu čela vydrží (default)', undefined);
  const unit = await unitChecks();
  const res = { at: new Date().toISOString(), head: HEAD.map((m) => m.id), dead: [...DEAD], unit, A, B,
    delta: { raceFailures: (A.race?.raceFailures ?? 0) - (B.race?.raceFailures ?? 0),
      medianStepMs: (A.race?.medianMs ?? 0) - (B.race?.medianMs ?? 0),
      sumS: (A.race?.sumS ?? 0) - (B.race?.sumS ?? 0),
      deadInRaceHead: (A.candidates?.deadInHead ?? 0) - (B.candidates?.deadInHead ?? 0),
      deadUpstreamCalls: (A.race?.deadUpstreamCalls ?? 0) - (B.race?.deadUpstreamCalls ?? 0) } };
  // výchozí výstup do tmp: běh testu nesmí přepsat archivní měření v docs/research (do archivu jen s --out=…)
  const out = arg('out', path.join(os.tmpdir(), 'czek-probe-pause.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const json = JSON.stringify(res, null, 2).replace(SECRET, '***');
  fs.writeFileSync(out, json);
  console.log(json);
  const pass = unit.omniRoutePauseWins && unit.localPausesKept && unit.expiredProbeDropped && unit.newProbePauseLogged &&
    (A.candidates?.deadInHead ?? 0) >= 1 && (B.candidates?.deadInHead ?? 0) === 0 && (B.race?.raceFailures ?? 1) === 0;
  console.log('\n' + (pass ? 'PASS' : 'CHECK') + ' – mrtvé modely v první dvojce závodu: A ' + (A.candidates?.deadInHead ?? '?') +
    ' → B ' + (B.candidates?.deadInHead ?? '?') + '; selhaní v závodě: A ' + (A.race?.raceFailures ?? '?') + ' → B ' + (B.race?.raceFailures ?? '?') +
    '; median krok: A ' + (A.race?.medianMs ?? '?') + ' ms → B ' + (B.race?.medianMs ?? '?') + ' ms; dotazy na mrtvé modely: A ' +
    (A.race?.deadUpstreamCalls ?? '?') + ' → B ' + (B.race?.deadUpstreamCalls ?? '?'));
  console.log('saved:', out);
  process.exit(pass ? 0 : 1);
})();
