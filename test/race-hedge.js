// Odstupňovaný závod (src/race.js, hedging): krok jde nejdřív jen vedoucímu modelu. Další závodníci startují, až když
// vedoucí do HEDGE ms nezačne odpovídat, nebo hned, když vypadne. Měří i to, o co jde: kolik dotazů stojí jeden krok.
'use strict';
const assert = require('assert');
const http = require('http');
const { createRaceProxy } = require('../src/race');

const sse = (o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
let delays = {};
let hits = [];
const up = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}');
    hits.push({ model: b.model, at: Date.now() });
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
  const mk = (extra) => createRaceProxy({ target: () => target, candidates: () => ['m/a', 'm/b', 'm/c'], n: () => 2, graceMs: 200, firstOutputMs: 3000, sticky: false, ...extra });
  const ask = async (url, i) => {
    const body = JSON.stringify({ model: 'zdarma-max', stream: true, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'úloha ' + i }] });
    const t0 = Date.now();
    const t = await (await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text();
    return { winner: (/od (m\/[abc])/.exec(t) || [])[1], ms: Date.now() - t0 };
  };
  const hedged = mk({ hedgeMs: 400 });
  const url = await hedged.listen(0);

  // 1) vedoucí odpoví rychle (50 ms) → jen 1 dotaz, druhý závodník vůbec nestartuje
  delays = { 'm/a': 50, 'm/b': 50 }; hits = [];
  let r = await ask(url, 1);
  assert.strictEqual(r.winner, 'm/a');
  await new Promise((s) => setTimeout(s, 500));
  assert.deepStrictEqual(hits.map((h) => h.model), ['m/a'], 'healthy leader: one request per step');
  // 2) vedoucí mlčí (2 s) → po HEDGE (400 ms) startuje m/b a vyhraje (vedoucí dostane GRACE, nestihne)
  delays = { 'm/a': 2000, 'm/b': 50 }; hits = [];
  r = await ask(url, 2);
  assert.strictEqual(r.winner, 'm/b');
  const gap = hits[1].at - hits[0].at;
  assert.ok(gap >= 350 && gap < 900, 'second racer starts after the hedge delay: ' + gap + ' ms');
  // 3) vedoucí hned vypadne (429) → další závodník startuje HNED, ne až po HEDGE
  delays = { 'm/a': 'fail', 'm/b': 50 }; hits = [];
  r = await ask(url, 3);
  assert.strictEqual(r.winner, 'm/b');
  assert.ok(hits[1].at - hits[0].at < 250, 'failed leader → next starts immediately: ' + (hits[1].at - hits[0].at) + ' ms');
  // 4) souběžný závod (hedgeMs 0) pro srovnání: vždy 2 dotazy na krok
  const conc = mk({ hedgeMs: 0 });
  const url2 = await conc.listen(0);
  delays = { 'm/a': 50, 'm/b': 50 }; hits = [];
  for (let i = 10; i < 15; i++) await ask(url2, i);
  const concCalls = hits.length;
  hits = [];
  for (let i = 20; i < 25; i++) await ask(url, i);
  await new Promise((s) => setTimeout(s, 500));
  const hedgeCalls = hits.length;
  assert.strictEqual(concCalls, 10, 'concurrent race: 2 requests per step');
  assert.strictEqual(hedgeCalls, 5, 'hedged race with a healthy leader: 1 request per step');
  // 5) adaptivní odstup: bez hedgeMs se učí z času do první odpovědi vedoucího (tady ~50 ms → spodní mez 2 s)
  const adaptive = mk({});
  const url3 = await adaptive.listen(0);
  delays = { 'm/a': 50, 'm/b': 50 };
  for (let i = 30; i < 34; i++) await ask(url3, i);
  delays = { 'm/a': 2600, 'm/b': 50 }; hits = [];
  r = await ask(url3, 40);
  assert.strictEqual(r.winner, 'm/b');
  const g3 = hits[1].at - hits[0].at;
  assert.ok(g3 >= 1900 && g3 < 2600, 'learned hedge = lower bound 2 s for a fast leader: ' + g3 + ' ms');
  assert.ok(hedged.stats.calls < conc.stats.calls * 2, 'stats count requests');
  up.closeAllConnections?.(); up.close();
  console.log(`race-hedge OK (zdravý vedoucí 1 dotaz na krok místo 2: ${hedgeCalls} vs ${concCalls} za 5 kroků; mlčící vedoucí → druhý po ${gap} ms; vypadlý → hned; naučený odstup ${g3} ms)`);
  process.exit(0);
})().catch((e) => { console.error('race-hedge FAILED:', e.message); process.exit(1); });
