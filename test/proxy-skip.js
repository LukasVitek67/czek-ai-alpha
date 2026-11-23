// Přeskočené modely (pauza po limitu) nesmí spotřebovat pokusy: 20 modelů s pauzou a za nimi fungující.
// Živý záznam 8. 11. 13:09: 20 modelů HF s pauzou vyčerpalo 15 pokusů, na Kilo Nemotron nedošlo.
'use strict';
const http = require('http');
const assert = require('assert');
const { createProxy, listen } = require('../src/proxy');
const { PROVIDERS } = require('../src/providers');

(async () => {
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] })); }); });
  const upPort = await listen(up, 0);
  const base = PROVIDERS.find((p) => p.id === 'kilo');
  const prov = { ...base, baseUrl: `http://127.0.0.1:${upPort}/v1`, chatUrl: undefined, chatUrlFor: undefined, headers: () => ({}) };
  const models = [];
  for (let i = 0; i < 20; i++) models.push({ key: `huggingface/m${i}`, id: `m${i}`, provider: 'huggingface', usable: true, tools: true });
  models.push({ key: 'kilo/good', id: 'good', provider: 'kilo', usable: true, tools: true });
  const cooldown = new Map([['provider:huggingface', { until: Date.now() + 3600e3, reason: 'quota' }]]);
  const registry = {
    textMode: new Set(), cooldown,
    list: async () => ({ models }),
    provider: (id) => (id === 'kilo' ? { p: prov, key: '', enabled: true } : { p: { ...prov, id }, key: 'k', enabled: true }),
    providers: () => [],
    autoOrder: (ms) => ms,
    coolingInfo: (k) => cooldown.get(k) || cooldown.get('provider:' + String(k).split('/')[0]) || null,
    isCooling(k) { return !!this.coolingInfo(k); },
    cool: () => {},
  };
  const server = createProxy({ registry, getSettings: () => ({ fallback: true, tiers: {} }) });
  const port = await listen(server, 0);
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'zdarma/auto', messages: [{ role: 'user', content: 'x' }] }) });
  const j = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(j).slice(0, 300));
  assert.strictEqual(j.choices[0].message.content, 'OK');
  assert.strictEqual(r.headers.get('x-zdarma-model'), 'kilo/good');
  server.close(); up.close();
  console.log('proxy-skip OK');
})().catch((e) => { console.error(e); process.exit(1); });
