// Pojistka proti zamrznutí (screenshot 8. 11.: seznam úkolů „0 z 4“ stál, OmniRoute čekal na mlčící model):
// když OmniRoute nezačne odpovídat, nebo uprostřed odpovědi zmlkne, klient (OpenCode) dostane konec s chybou.
'use strict';
process.env.ZDARMA_OMNI_FIRST_MS = '1500';
process.env.ZDARMA_OMNI_IDLE_MS = '1500';
const http = require('http');
const assert = require('assert');
const { createProxy, listen } = require('../src/proxy');

(async () => {
  let mode = 'silent';
  const up = http.createServer((req, res) => {
    req.resume();
    if (mode === 'silent') return; // nikdy neodpoví
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Začínám' }, finish_reason: null }] })}\n\n`);
    // …a pak ticho
  });
  const upPort = await listen(up, 0);
  const eng = { url: `http://127.0.0.1:${upPort}`, comboFor: () => 'zdarma-max', modelKeyFrom: () => null, keyForModel: () => null };
  const registry = { textMode: new Set(), list: async () => ({ models: [] }), provider: () => null, providers: () => [], autoOrder: () => [], isCooling: () => false, coolingInfo: () => null, cool: () => {} };
  const server = createProxy({ registry, getSettings: () => ({ tiers: {} }), omni: () => eng });
  const port = await listen(server, 0);
  const ask = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'zdarma/max', stream: true, messages: [{ role: 'user', content: 'x' }] }) });

  let t0 = Date.now();
  const r1 = await ask();
  const b1 = await r1.text();
  assert.equal(r1.status, 400, 'nezačal odpovídat → 400 (OpenCode neopakuje)');
  assert.ok(/nezačal odpovídat/.test(b1), b1);
  assert.ok(Date.now() - t0 < 6000, 'skončilo rychle');

  mode = 'stall';
  t0 = Date.now();
  const r2 = await ask();
  assert.equal(r2.status, 200);
  const b2 = await r2.text();
  assert.ok(/Začínám/.test(b2), 'začátek odpovědi prošel');
  assert.ok(/přestal odpovídat/.test(b2) && /\[DONE\]/.test(b2), 'ticho uprostřed → chyba + [DONE]: ' + b2.slice(-200));
  assert.ok(Date.now() - t0 < 6000, 'skončilo rychle');

  server.close(); up.closeAllConnections?.(); up.close();
  console.log('omni-timeout OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
