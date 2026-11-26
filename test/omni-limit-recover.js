'use strict';
// Model v „limitu“ (většina 429 za 2 h) se sám vrátí do čela, když se mu limit obnoví (src/omniroute.js speedStats +
// probeHeads). 26. 11.: Kilo ERNIE odpovídal 200 za 0,85 s a czek-ai ho držela v limitu na 14. místě – kontrola zdraví
// zkouší jen čelo, takže úspěch, který by limit zrušil, neměl odkud přijít. Ověřuje:
//  1) novější úspěch než poslední 429 → už ne limit (speedStats),
//  2) kontrola zdraví zkusí model v limitu, jehož poslední 429 je starší než 10 min, i když není v čele; 200 → limit pryč,
//     model zpět na své místo v čele,
//  3) model s čerstvým 429 (< 10 min) kontrola nezkouší (nepálí kvótu dokola).
// Bez sítě, lokální mock. node test/omni-limit-recover.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OmniRoute } = require('../src/omniroute');

const hits = {};
const mock = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}'); const id = String(b.model || '').split('/').pop();
    hits[id] = (hits[id] || 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
});

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-limrec-'));
  try {
    const now = Date.now();
    const rows = [];
    const add = (provider, model, status, n, agoMs) => { for (let i = 0; i < n; i++) rows.push({ timestamp: new Date(now - agoMs - i * 1000).toISOString(), provider, model, status, duration: 900 }); };
    add('n-or', 'ernie', 429, 6, 30 * 60e3);   // limit vyčerpán před půl hodinou
    add('n-gm', 'gemma', 429, 6, 2 * 60e3);    // limit vyčerpán před 2 min
    add('n-mi', 'codestral', 429, 6, 40 * 60e3); add('n-mi', 'codestral', 200, 1, 5 * 60e3); // pak zase odpověděl
    add('n-kilo', 'auto', 200, 5, 60e3);

    const o = new OmniRoute({ dataDir: dir, log: () => {} });
    o.nodeToProvider = new Map([['n-or', 'openrouter'], ['n-gm', 'gemini'], ['n-mi', 'mistral'], ['n-kilo', 'kilo']]);
    const base = [
      { ref: 'z-openrouter/ernie', provider: 'openrouter', id: 'ernie' },
      { ref: 'z-gemini/gemma', provider: 'gemini', id: 'gemma' },
      { ref: 'z-mistral/codestral', provider: 'mistral', id: 'codestral' },
      { ref: 'z-kilo/auto', provider: 'kilo', id: 'auto' },
    ];
    o.baseLists = new Map([['zdarma-max', base]]);
    o.api = async () => rows;
    await o.speedStats(now);

    // 1) codestral má novější 200 než poslední 429 → není v limitu
    assert.deepStrictEqual([...o.limited].sort(), ['gemini/gemma', 'openrouter/ernie'], [...o.limited].join(','));
    assert.deepStrictEqual(o.arrange(base).map((x) => x.id), ['codestral', 'auto', 'ernie', 'gemma'], 'limit za fungující');

    // 2) + 3) kontrola zdraví jen čela (k=1): ernie (429 před 30 min) se zkusí navíc, gemma (před 2 min) ne
    o.ready = true; o.port = mock.address().port; o.apiKey = 'k'.repeat(32);
    o.syncCooldowns = async () => {};
    const r = await o.probeHeads({ combos: ['zdarma-max'], k: 1, timeoutMs: 2000, slowTimeoutMs: 0, concurrency: 4, force: true });
    assert.strictEqual(r.results['z-openrouter/ernie'], 200, 'model v limitu s 429 starším než 10 min se zkusil');
    assert.ok(!('z-gemini/gemma' in r.results), 'čerstvý limit se nezkouší');
    assert.ok(!hits.gemma, 'gemma bez dotazu');
    assert.ok(!o.limited.has('openrouter/ernie'), 'úspěch kontroly zrušil limit');
    assert.deepStrictEqual(o.arrange(base).map((x) => x.id), ['ernie', 'codestral', 'auto', 'gemma'], 'ernie zpět na svém místě v čele');

    // 4) další statistika z logů (OmniRoute zapíše úspěch kontroly) limit znovu nezapne
    rows.push({ timestamp: new Date().toISOString(), provider: 'n-or', model: 'ernie', status: 200, duration: 800 });
    await o.speedStats(Date.now());
    assert.ok(!o.limited.has('openrouter/ernie'), 'po novém úspěchu v logu zůstává mimo limit');
    assert.ok(o.limited.has('gemini/gemma'), 'gemma dál v limitu');
    console.log('omni-limit-recover OK (obnovený limit: model zpět v čele hned po úspěchu kontroly; čerstvý limit se nezkouší)');
  } finally {
    mock.closeAllConnections?.(); await new Promise((r) => mock.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
