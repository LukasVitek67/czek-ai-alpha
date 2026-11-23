// Živý test nových poskytovatelů (síť): seznamy modelů a volání přes proxy, včetně nástroje.
// node test/providers-live.js            – bezklíčoví (OVHcloud, LLM7, Kilo) + veřejné seznamy
'use strict';
const assert = require('assert');
const http = require('http');
const { PROVIDERS, chatUrlOf } = require('../src/providers');
const { ModelRegistry } = require('../src/agent');
const { createProxy, listen } = require('../src/proxy');

const P = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

// Cloudflare: klíč "Account ID:token" → adresa a hlavička
const cf = P.cloudflare;
assert.equal(chatUrlOf(cf, 'abc123:tok'), 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/chat/completions');
assert.deepEqual(cf.headers('abc123:tok'), { Authorization: 'Bearer tok' });
assert.equal(chatUrlOf(P.groq, 'x'), 'https://api.groq.com/openai/v1/chat/completions');
assert.equal(chatUrlOf(P.pollinations, ''), 'https://text.pollinations.ai/openai');

const post = (port, body) => new Promise((resolve, reject) => {
  const req = http.request({ port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, model: res.headers['x-zdarma-model'], text: t }));
  });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});
const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

(async () => {
  for (const id of ['ovh', 'llm7', 'kilo', 'unorouter', 'zai']) {
    const list = await P[id].listModels('');
    console.log(`${id}: ${list.length} modelů · ${list.slice(0, 6).map((m) => m.id).join(', ')}`);
    assert.ok(list.length > 0, id);
  }

  // Proxy jen s jedním poskytovatelem: odpověď + volání nástroje
  for (const [id, model] of [['ovh', 'gpt-oss-120b'], ['llm7', 'gpt-oss:20b'], ['kilo', null]]) {
    const settings = { providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, { enabled: p.id === id }])), customProviders: [], favorites: [], fallback: true };
    const registry = new ModelRegistry(() => settings);
    const server = createProxy({ registry, getSettings: () => settings });
    const port = await listen(server, 0);
    const { models } = await registry.list();
    const pick = model ? `${id}/${model}` : registry.autoOrder(models)[0]?.key;
    const t0 = Date.now();
    const r = await post(port, { model: pick, messages: [{ role: 'user', content: 'What is the weather in Prague? Use the tool.' }], tools: TOOLS });
    let calls = [];
    try { calls = JSON.parse(r.text).choices?.[0]?.message?.tool_calls || []; } catch {}
    console.log(`${id}: HTTP ${r.status} · ${r.model} · ${Date.now() - t0} ms · nástroj: ${calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(', ') || '—'}${r.status !== 200 ? ' · ' + r.text.slice(0, 200) : ''}`);
    server.close();
  }
  console.log('providers-live hotovo');
})().catch((e) => { console.error(e); process.exit(1); });
