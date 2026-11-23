// Věrnost vítězi (src/race.js): model, který vyhrál předchozí krok TÉŽE konverzace, dostane v dalším kroku přednost
// (první místo → GRACE), takže konverzaci vede jeden model. Jiná konverzace věrnost nezdědí; vypadlý model ji ztratí.
'use strict';
const assert = require('assert');
const http = require('http');
const { createRaceProxy } = require('../src/race');

const sse = (o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
let delays = {};
const up = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}');
    const d = delays[b.model];
    if (d === 'fail') { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"rate limit"}}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
    const t = setTimeout(() => {
      res.write(sse({ choices: [{ index: 0, delta: { content: 'od ' + b.model } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })); res.end(sse('[DONE]'));
    }, d ?? 50);
    res.on('close', () => clearTimeout(t));
  });
});

(async () => {
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${up.address().port}`;
  const proxy = createRaceProxy({ target: () => target, candidates: () => ['m/a', 'm/b', 'm/c'], n: () => 2, graceMs: 300, firstOutputMs: 3000, hedgeMs: 0 });
  const url = await proxy.listen(0);
  const ask = async (first, step) => {
    const body = JSON.stringify({ model: 'zdarma-max', stream: true, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: first }, ...Array.from({ length: step }, (_, i) => ({ role: 'assistant', content: 'krok ' + i }))] });
    const r = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const t = await r.text();
    return (/od (m\/[abc])/.exec(t) || [])[1];
  };
  // krok 1 konverzace X: m/a (1. v pořadí) začne pozdě (po GRACE) → vyhraje m/b
  delays = { 'm/a': 1000, 'm/b': 50 };
  assert.strictEqual(await ask('úloha X', 0), 'm/b');
  // krok 2 téže konverzace: m/a by teď začala dřív (50 ms) než m/b (150 ms), ale m/b je vítěz předchozího kroku →
  // je první a GRACE čeká na ni
  delays = { 'm/a': 50, 'm/b': 150 };
  assert.strictEqual(await ask('úloha X', 1), 'm/b', 'winner of the previous step of the same conversation keeps the lead');
  // jiná konverzace věrnost nezdědí → běžné pořadí
  assert.strictEqual(await ask('úloha Y', 0), 'm/a', 'another conversation uses the normal order');
  // vítěz vypadne (429, pak 90 s na pauze) → vyhraje druhý a věrnost přejde na něj
  delays = { 'm/a': 50, 'm/b': 'fail', 'm/c': 400 };
  assert.strictEqual(await ask('úloha X', 2), 'm/a');
  delays = { 'm/a': 150, 'm/b': 50, 'm/c': 50 };
  assert.strictEqual(await ask('úloha X', 3), 'm/a', 'loyalty moved to the new winner (m/c starts first but m/a leads)');
  assert.ok(proxy.stats.sticky >= 2, 'sticky reorders counted: ' + proxy.stats.sticky);
  // vypnutá věrnost (A/B): krok 2 vyhraje rychlejší start
  const off = createRaceProxy({ target: () => target, candidates: () => ['m/a', 'm/b'], n: () => 2, graceMs: 300, firstOutputMs: 3000, sticky: false, hedgeMs: 0 });
  const url2 = await off.listen(0);
  const ask2 = async (first, step) => {
    const body = JSON.stringify({ model: 'zdarma-max', stream: true, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: first }, ...Array.from({ length: step }, (_, i) => ({ role: 'assistant', content: 'krok ' + i }))] });
    const t = await (await fetch(url2 + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text();
    return (/od (m\/[ab])/.exec(t) || [])[1];
  };
  delays = { 'm/a': 1000, 'm/b': 50 };
  assert.strictEqual(await ask2('úloha Z', 0), 'm/b');
  delays = { 'm/a': 50, 'm/b': 150 };
  assert.strictEqual(await ask2('úloha Z', 1), 'm/a', 'without loyalty the normal order wins');
  up.close();
  console.log(`race-sticky OK (vítěz kroku vede další krok téže konverzace, jiná konverzace normálně, po výpadku přejde věrnost; přeřazení ${proxy.stats.sticky}×)`);
  process.exit(0);
})().catch((e) => { console.error('race-sticky FAILED:', e.message); process.exit(1); });
