// Proxy doplní reasoning_effort "high" krokům agenta (s nástroji) na tierlistech/auto, jen u poskytovatelů,
// kteří ho přijmou; bez nástrojů (názvy chatů) a s vlastní hodnotou od klienta nic nemění.
'use strict';
const http = require('http');
const assert = require('assert');
const { createProxy, listen } = require('../src/proxy');
const { PROVIDERS } = require('../src/providers');

(async () => {
  const seen = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b); seen.push(j);
      if (j.model === 'strict' && 'reasoning_effort' in j) { res.writeHead(422, { 'content-type': 'application/json' }); res.end('{"error":{"message":"extra fields not permitted"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] }));
    });
  });
  const upPort = await listen(up, 0);
  const base = PROVIDERS.find((p) => p.id === 'kilo');
  const mk = (id) => ({ ...base, id, baseUrl: `http://127.0.0.1:${upPort}/v1`, chatUrl: undefined, chatUrlFor: undefined, headers: () => ({}) });
  let models = [];
  const registry = {
    textMode: new Set(), list: async () => ({ models }),
    provider: (id) => ({ p: mk(id), key: id === 'kilo' ? '' : 'k', enabled: true }), providers: () => [], autoOrder: (ms) => ms,
    coolingInfo: () => null, isCooling: () => false, cool: () => {},
  };
  const server = createProxy({ registry, getSettings: () => ({ fallback: true, tiers: {} }) });
  const port = await listen(server, 0);
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }];
  const call = async (body) => (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

  models = [{ key: 'kilo/nemo', id: 'nemo', provider: 'kilo', usable: true, tools: true }];
  await call({ model: 'zdarma/auto', tools, messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(seen.at(-1).reasoning_effort, 'high', 'agent step on auto → high');
  await call({ model: 'zdarma/auto', messages: [{ role: 'user', content: 'title' }] });
  assert.ok(!('reasoning_effort' in seen.at(-1)), 'no tools (title) → untouched');
  await call({ model: 'zdarma/auto', tools, reasoning_effort: 'low', messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(seen.at(-1).reasoning_effort, 'low', 'client value kept');

  models = [{ key: 'mistral/strict', id: 'strict', provider: 'mistral', usable: true, tools: true }];
  const r = await call({ model: 'zdarma/auto', tools, messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(r.choices?.[0]?.message?.content, 'OK', JSON.stringify(r).slice(0, 200));
  assert.ok(!('reasoning_effort' in seen.at(-1)), 'provider outside the allowlist gets no reasoning_effort');

  server.close(); up.close();
  console.log('proxy-effort OK');
})().catch((e) => { console.error(e); process.exit(1); });
