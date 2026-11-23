// Vlastní směrování: model, který nezačne posílat data do FIRST_BYTE_MS, se utne, dostane pauzu 15 min
// a odpoví další. Udržovací komentáře (": PROCESSING") limit neprodlužují. Živě 8. 11.: NVIDIA DeepSeek
// V4.1 Flash zdržel krok agenta o 150 s.
'use strict';
process.env.ZDARMA_FIRST_BYTE_MS = '1500';
const http = require('http');
const assert = require('assert');
const { createProxy, listen } = require('../src/proxy');
const { PROVIDERS } = require('../src/providers');
const { streamChat } = require('../src/llm');

(async () => {
  const hangs = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b);
      if (j.model === 'silent') { hangs.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); return; } // hlavičky, žádná data
      if (j.model === 'keepalive') { // jen komentáře
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const t = setInterval(() => res.write(': PROCESSING\n\n'), 300);
        res.on('close', () => clearInterval(t));
        hangs.push(res); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // pomalý, ale živý model: první data hned, pak 2 s pauza (delší než FIRST_BYTE_MS) – nesmí se utnout
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'O' } }] })}\n\n`);
      setTimeout(() => res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'K' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`), 2000);
    });
  });
  const upPort = await listen(up, 0);
  const url = `http://127.0.0.1:${upPort}/v1/chat/completions`;

  // streamChat přímo: komentáře limit neprodlouží
  const t0 = Date.now();
  await assert.rejects(streamChat({ url, headers: {}, body: { model: 'keepalive', messages: [] }, firstByteMs: 1500, timeoutMs: 60000 }), (e) => e.kind === 'timeout');
  assert.ok(Date.now() - t0 < 4000, 'keepalive comments must not extend the first-byte limit');

  const base = PROVIDERS.find((p) => p.id === 'kilo');
  const prov = { ...base, baseUrl: `http://127.0.0.1:${upPort}/v1`, chatUrl: undefined, chatUrlFor: undefined, headers: () => ({}) };
  const models = ['silent', 'keepalive', 'good'].map((id) => ({ key: `kilo/${id}`, id, provider: 'kilo', usable: true, tools: true }));
  const cooled = new Map();
  const registry = {
    textMode: new Set(), list: async () => ({ models }),
    provider: () => ({ p: prov, key: '', enabled: true }), providers: () => [], autoOrder: (ms) => ms,
    coolingInfo: (k) => cooled.get(k) || null, isCooling(k) { return !!this.coolingInfo(k); },
    cool: (k, ms, why) => cooled.set(k, { until: Date.now() + ms, reason: why }),
  };
  const server = createProxy({ registry, getSettings: () => ({ fallback: true, tiers: {} }) });
  const port = await listen(server, 0);
  const t1 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'zdarma/auto', messages: [{ role: 'user', content: 'x' }] }) });
  const j = await r.json();
  const ms = Date.now() - t1;
  assert.strictEqual(r.status, 200, JSON.stringify(j).slice(0, 300));
  assert.strictEqual(j.choices[0].message.content, 'OK');
  assert.strictEqual(r.headers.get('x-zdarma-model'), 'kilo/good');
  assert.ok(ms < 9000, `took ${ms} ms`);
  for (const k of ['kilo/silent', 'kilo/keepalive']) {
    const c = cooled.get(k);
    assert.ok(c && c.until - Date.now() > 14 * 60e3, `${k} paused 15 min: ${JSON.stringify(c)}`);
  }
  for (const h of hangs) try { h.destroy(); } catch {}
  server.close(); up.close();
  console.log(`first-byte OK (${ms} ms)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
