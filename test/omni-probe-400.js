'use strict';
// Kontrola zdraví čela tierů (OmniRoute.probeHeads) na lokálním mocku: 400 na drobný dotaz nesmí hned znamenat
// „mrtvý model“ – reasoning modely odmítají max_tokens 1, přitom v relaci normálně odpovídají. Ověřuje:
//   1) model, který 400 vrací jen na max_tokens 1, se po druhém pokusu (max_tokens 64) bere jako funkční a nedostane pauzu,
//   2) model, který 400 vrací pořád, pauzu dostane a log ukáže tělo chyby (jinak se příčina nedá zjistit),
//   3) zdravý model se zkouší jen jednou,
//   4) model, který na max_tokens 1 mlčí (OpenRouter přes OmniRoute, 25. 11.), odpoví hned na první pokus (kontrola
//      posílá max_tokens 16).
// Žádná síť, žádná kvóta, nikdy nesahá na profil uživatele. Použití: node test/omni-probe-400.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { OmniRoute } = require('../src/omniroute');

const MODELS = {
  reasoner: (b) => (Number(b.max_tokens) < 32
    ? [400, { error: { message: 'max_tokens must be at least 32 for reasoning models' } }]
    : [200, { choices: [{ message: { role: 'assistant', content: 'OK' } }] }]),
  always400: () => [400, { error: { message: 'unknown field thinking_budget' } }],
  healthy: () => [200, { choices: [{ message: { role: 'assistant', content: 'OK' } }] }],
  silentAt1: (b) => (Number(b.max_tokens) <= 1 ? null : [200, { choices: [{ message: { role: 'assistant', content: 'OK' } }] }]),
};
const maxTokensSeen = [];

const hits = {}; // id modelu → kolik dotazů dostal
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch {}
    const id = String(b.model || '').split('/').pop();
    const fn = MODELS[id];
    hits[id] = (hits[id] || 0) + 1;
    maxTokensSeen.push(Number(b.max_tokens));
    const out = fn ? fn(b) : [404, { error: { message: 'unknown model' } }];
    if (!out) return; // mlčí (spojení visí do timeoutu kontroly)
    const [status, body] = out;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-probe400-'));
  const logs = [];
  try {
    const eng = new OmniRoute({ dataDir: dir, log: (l) => logs.push(String(l)) });
    eng.ready = true;
    eng.port = mock.address().port;
    eng.apiKey = 'k'.repeat(32);
    eng.baseLists.set('zdarma-max', [
      { ref: 'p/reasoner', provider: 'p', id: 'reasoner' },
      { ref: 'q/always400', provider: 'q', id: 'always400' },
      { ref: 'r/healthy', provider: 'r', id: 'healthy' },
      { ref: 's/silentAt1', provider: 's', id: 'silentAt1' },
    ]);

    const res = await eng.probeHeads({ combos: ['zdarma-max'], timeoutMs: 3000, slowTimeoutMs: 0, concurrency: 4 });
    assert.strictEqual(res.probed, 4, 'prošly všechny čtyři modely');
    assert.strictEqual(res.results['p/reasoner'], 200, '400 na max_tokens 1 → druhý pokus prošel');
    assert.strictEqual(res.results['q/always400'], 400, 'trvalé 400 zůstává 400');
    assert.strictEqual(res.results['r/healthy'], 200, 'zdravý model 200');
    assert.strictEqual(res.results['s/silentAt1'], 200, 'model mlčící na max_tokens 1 odpoví (kontrola posílá 16)');
    assert.strictEqual(hits.silentAt1, 1, 'silentAt1: jeden pokus');
    assert.ok(maxTokensSeen.every((m) => m >= 16), 'kontrola nikdy neposílá max_tokens pod 16: ' + maxTokensSeen.join(','));
    assert.strictEqual(hits.reasoner, 2, 'reasoner: dva pokusy (max_tokens 16 → 64)');
    assert.strictEqual(hits.always400, 2, 'always400: dva pokusy, pak pauza');
    assert.strictEqual(hits.healthy, 1, 'zdravý model se nezkouší dvakrát');

    const paused = (p, i) => eng.probePaused.has(`${p}/${i}`);
    assert.ok(!paused('p', 'reasoner'), 'model, který 400 vrací jen na drobný dotaz, nedostane pauzu');
    assert.ok(paused('q', 'always400'), 'model s trvalým 400 dostane pauzu');
    assert.ok(!paused('r', 'healthy'), 'zdravý model bez pauzy');

    const joined = logs.join('\n');
    assert.ok(/400 i po druhém pokusu/.test(joined), 'log vypíše 400 s tělem');
    assert.ok(joined.includes('unknown field thinking_budget'), 'v logu je tělo chyby (důvod se dá zjistit)');
    assert.ok(/nefunkční 1/.test(joined), 'v souhrnu je jen skutečně nefunkční model');
    assert.ok(!joined.includes('k'.repeat(32)), 'klíč se do logu nedostane');

    console.log('omni-probe-400 OK (max_tokens 16: model mlčící na 1 odpoví; 400 na drobný dotaz → druhý pokus, pauza jen po trvalém 400, tělo chyby v logu)');
  } finally {
    mock.closeAllConnections?.();
    await new Promise((r) => mock.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
