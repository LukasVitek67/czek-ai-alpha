// Závod (src/race.js): když všichni závodníci i celé combo narazí na limit („cooling down“, 429), dostane OpenCode
// srozumitelnou českou hlášku s odkazem na Průvodce klíči (status zůstává). Jiné chyby jdou dál beze změny.
'use strict';
const assert = require('assert');
const http = require('http');
const { createRaceProxy, friendlyNoQuota } = require('../src/race');
const I18N = require('../src/i18n');

const t = (k, v) => I18N.t(k, v);
// jednotkově
const cool = JSON.stringify({ error: { message: 'All credentials for model zdarma-max are cooling down', type: 'rate_limit_error', reset_seconds: 150 } });
const a = JSON.parse(friendlyNoQuota(429, cool, 'zdarma-max', 2, t));
assert.match(a.error.message, /vyčerpaný limit/);
assert.match(a.error.message, /Průvodce klíči/);
assert.match(a.error.message, /asi za 3 min/);
assert.strictEqual(a.error.type, 'czek_no_free_quota');
const b = JSON.parse(friendlyNoQuota(429, cool, 'zdarma-max', 0, t));
assert.match(b.error.message, /celá třída/, 'no keys → explains the shared IP limit');
assert.strictEqual(friendlyNoQuota(400, JSON.stringify({ error: { message: 'messages: invalid tool schema' } }), 'zdarma-max', 1, t), null, 'other errors unchanged');
assert.ok(friendlyNoQuota(402, '{"error":{"message":"Insufficient credits"}}', 'zdarma-high', 1, t), '402 counts');

// celá cesta: falešný OmniRoute vrací 429 na všechno
(async () => {
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(cool); });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${up.address().port}`;
  const proxy = createRaceProxy({ target: () => target, candidates: () => ['m1', 'm2', 'm3'], n: () => 2, keyedCount: () => 0, graceMs: 50, firstOutputMs: 2000 });
  const url = await proxy.listen(0);
  const body = JSON.stringify({ model: 'zdarma-max', stream: true, messages: [{ role: 'user', content: 'ahoj' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
  const r = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const j = await r.json();
  assert.strictEqual(r.status, 429, 'status kept (OpenCode/guard still see a rate limit)');
  assert.match(j.error.message, /Průvodce klíči/);
  assert.match(j.error.message, /celá třída/);
  // dotaz mimo chat (např. /v1/models) jde dál beze změny
  const m = await fetch(url + '/v1/models');
  assert.strictEqual(m.status, 429);
  assert.match(await m.text(), /cooling down/);
  // Windows: `process.exit()` během zavírání socketů spadl na libuv asertaci (UV_HANDLE_CLOSING) → test hlásil
  // 127 až po „OK“. Zavřít spojení a nechat proces dojet (undici pustí keep-alive sockety sám).
  up.closeAllConnections?.();
  await proxy.close();
  up.close();
  console.log('race-quota OK (hláška s průvodcem klíči, status 429 zachován, jiné chyby beze změny)');
})().catch((e) => { console.error('race-quota FAILED:', e.message); process.exit(1); });
