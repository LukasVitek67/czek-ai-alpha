// Test proxy proti falešnému upstreamu: střídání po 429, textový protokol nástrojů, SSE, zabezpečení.
'use strict';
const http = require('http');
const assert = require('assert');
const { ModelRegistry } = require('../src/agent');
const { PROVIDERS } = require('../src/providers');
const { createProxy, listen, sanitize, parseTextCalls } = require('../src/proxy');

const seen = [];
const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
  res.end('data: [DONE]\n\n');
};
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [] }));
  const b = JSON.parse(raw);
  seen.push(b);
  if (b.model === 'bad-coder') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Rate limit exceeded"}}'); }
  if (b.model === 'notools') {
    if (b.tools) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"This model does not support tools"}}'); }
    return sse(res, [{ choices: [{ delta: { content: 'Zjistím to.\n<tool_call>{"name": "get_weather", "arguments": {"city": "Praha"}}</tool_call>' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  }
  if (b.tools) {
    return sse(res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Brno"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]);
  }
  res.setHeader('x-ratelimit-limit-requests', '1000');
  res.setHeader('x-ratelimit-remaining-requests', '997');
  res.setHeader('x-ratelimit-reset-requests', '2m10s');
  sse(res, [{ choices: [{ delta: { reasoning_content: 'hm' } }] }, { choices: [{ delta: { content: 'ah' } }] }, { choices: [{ delta: { content: 'oj' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }]);
});

const post = (port, body, headers = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
    let t = '';
    res.on('data', (c) => (t += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
  });
  req.on('error', reject);
  req.end(data);
});
const parseSSE = (t) => t.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

(async () => {
  // unit
  const s = sanitize([{ role: 'system', content: 'A' }, { role: 'system', content: [{ type: 'text', text: 'B' }] }, { role: 'user', content: [{ type: 'text', text: 'ahoj' }] }]);
  assert.deepEqual(s, [{ role: 'system', content: 'A\n\nB' }, { role: 'user', content: 'ahoj' }]);
  const pc = parseTextCalls('ok <tool_call>{"name":"functions.read","arguments":{"filePath":"a"}}</tool_call>', ['read', 'write']);
  assert.equal(pc.toolCalls[0].function.name, 'read'); assert.equal(pc.content, 'ok');

  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const settings = {
    providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, { enabled: false }])),
    customProviders: [{ id: 'mock', name: 'Mock', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, models: 'bad-coder good notools', key: '' }],
    favorites: [], fallback: true,
  };
  const registry = new ModelRegistry(() => settings);
  const logs = [];
  const { Usage } = require('../src/usage');
  const usage = new Usage(null);
  const server = createProxy({ registry, getSettings: () => settings, onLog: (e) => logs.push(e), version: 'test', usage });
  const port = await listen(server, 0);

  // modely
  const models = await new Promise((r) => http.get({ port, path: '/v1/models' }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => r(JSON.parse(t))); }));
  const ids = models.data.map((m) => m.id);
  assert.ok(ids.includes('auto') && ids.includes('auto-unfiltered') && ids.includes('mock/good'), ids.join(','));

  // B: auto bez streamu → bad-coder 429 → good
  let r = await post(port, { model: 'zdarma/auto', messages: [{ role: 'system', content: 'S1' }, { role: 'system', content: 'S2' }, { role: 'user', content: 'ahoj' }] });
  assert.equal(r.status, 200, r.text);
  let j = JSON.parse(r.text);
  assert.equal(j.choices[0].message.content, 'ahoj');
  assert.equal(j.choices[0].message.reasoning_content, 'hm');
  assert.equal(r.headers['x-zdarma-model'], 'mock/good');
  assert.ok(registry.isCooling('mock/bad-coder'), 'bad-coder má pauzu');
  assert.equal(seen[seen.length - 1].messages[0].content, 'S1\n\nS2', 'system zprávy sloučené');
  console.log('B ok: rotace po 429');

  // C: stream s nástroji
  r = await post(port, { model: 'auto', stream: true, stream_options: { include_usage: true }, tools: TOOLS, messages: [{ role: 'user', content: 'počasí v Brně' }] });
  let ev = parseSSE(r.text);
  const tcs = ev.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(tcs.length, 1); assert.equal(tcs[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(tcs[0].function.arguments), { city: 'Brno' });
  assert.equal(ev.find((e) => e.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
  assert.equal(ev[ev.length - 1].usage.total_tokens, 15);
  assert.equal(ev[0].choices[0].delta.role, 'assistant');
  assert.ok(r.text.trim().endsWith('data: [DONE]'));
  console.log('C ok: stream + tool_calls + usage');

  // D: model bez nástrojů → textový protokol
  seen.length = 0;
  r = await post(port, { model: 'mock/notools', stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'počasí v Praze' }, { role: 'assistant', content: '', tool_calls: [{ id: 'x1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Plzeň"}' } }] }, { role: 'tool', tool_call_id: 'x1', content: 'slunečno' }, { role: 'user', content: 'a v Praze?' }] });
  ev = parseSSE(r.text);
  const tc2 = ev.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(tc2.length, 1, r.text); assert.equal(tc2[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(tc2[0].function.arguments), { city: 'Praha' });
  const content2 = ev.map((e) => e.choices?.[0]?.delta?.content || '').join('');
  assert.equal(content2, 'Zjistím to.', 'blok <tool_call> je z textu vyříznutý');
  const textReq = seen[seen.length - 1];
  assert.ok(!textReq.tools, 'textový režim neposílá tools');
  assert.ok(textReq.messages[0].content.includes('get_weather') && textReq.messages.some((m) => m.content.includes('<tool_result name="get_weather">')), JSON.stringify(textReq.messages).slice(0, 400));
  assert.ok(registry.textMode.has('mock/notools'));
  console.log('D ok: textový protokol nástrojů');

  // E/F: zabezpečení
  r = await post(port, { model: 'auto', messages: [{ role: 'user', content: 'x' }] }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await new Promise((resolve) => { const q = http.request({ port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'text/plain' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); q.end('{}'); });
  assert.equal(r, 415);
  console.log('E/F ok: Origin a Content-Type');

  // G: nic nezbývá → chyba, kterou klient NEopakuje (ne 429/5xx – OpenCode by jinak opakoval donekonečna
  // a relace by zůstala „pracuje“)
  settings.fallback = false;
  r = await post(port, { model: 'mock/bad-coder', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 400, r.text);
  assert.ok(r.status !== 429 && r.status < 500);
  assert.match(JSON.parse(r.text).error.message, /bad-coder/);
  console.log('G ok: chyba, když nic nezbývá (neopakovatelná)');

  // G2: model se uvolní do pár sekund → proxy sama počká a odpoví
  settings.fallback = true;
  registry.cooldown.clear();
  settings.tiers = require('../src/tiers').sanitize({ 'c-jeden': { name: 'Jeden', models: ['mock/good'] } });
  registry.cool('mock/good', 1500, 'test');
  const tw = Date.now();
  r = await post(port, { model: 'c-jeden', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, r.text);
  assert.ok(Date.now() - tw >= 1200, 'počkala na konec pauzy');
  delete settings.tiers;
  console.log(`G2 ok: krátká pauza – proxy počkala ${Date.now() - tw} ms a odpověděla`);

  // H: tierlisty – vlastní pořadí, rotace v něm, záložní tierlist
  const tiers = require('../src/tiers');
  settings.fallback = true;
  registry.cooldown.clear();
  settings.tiers = tiers.sanitize({
    'c-test': { name: 'Test', models: ['mock/bad-coder', 'mock/notools', 'neexistuje/x'], fallback: 'c-zaloha' },
    'c-zaloha': { name: 'Záloha', models: ['mock/good'] },
  });
  assert.ok(tiers.isTier('c-test', settings) && tiers.isTier('max', settings) && !tiers.isTier('nic', settings));
  const ord = tiers.order('c-test', (await registry.list()).models, settings, registry).map((m) => `${m.key}@${m.tier}`);
  assert.deepEqual(ord, ['mock/bad-coder@c-test', 'mock/notools@c-test', 'mock/good@c-zaloha'], 'neexistující model se přeskočí, pak záloha');
  r = await post(port, { model: 'zdarma/c-test', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers['x-zdarma-model'], 'mock/notools', 'bad-coder (429) přeskočen, další v tierlistu');
  registry.cooldown.clear();
  settings.tiers['c-test'].models = ['mock/bad-coder'];
  r = await post(port, { model: 'c-test', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.headers['x-zdarma-model'], 'mock/good', 'po vyčerpání tierlistu záložní tierlist');
  const ml = await new Promise((res2) => http.get({ port, path: '/v1/models' }, (q) => { let t = ''; q.on('data', (c) => (t += c)); q.on('end', () => res2(JSON.parse(t))); }));
  assert.ok(['max', 'high', 'mid', 'low', 'unfiltered', 'c-test'].every((id) => ml.data.some((m) => m.id === id)), 'tierlisty v /v1/models');
  console.log('H ok: tierlisty');

  // I: využití limitů
  const snap = usage.snapshot(registry);
  const mp = snap.providers.find((p) => p.id === 'mock');
  assert.ok(mp && mp.requests >= 6 && mp.errors >= 2, JSON.stringify(mp).slice(0, 300));
  const good = mp.models.find((m) => m.key === 'mock/good');
  assert.equal(good.rate.reqRemaining, 997); assert.equal(good.rate.reqLimit, 1000); assert.equal(good.rate.reqReset, '2m10s');
  assert.ok(good.tokensIn >= 20);
  const bad = mp.models.find((m) => m.key === 'mock/bad-coder');
  assert.equal(bad.lastError.kind, 'rate');
  assert.ok(bad.cooling && bad.cooling.until > Date.now(), 'pauza je vidět');
  console.log('I ok: využití limitů');

  assert.ok(logs.length >= 4 && logs.some((l) => !l.ok));
  server.close(); mock.close();
  console.log('proxy OK');
})().catch((e) => { console.error(e); process.exit(1); });
