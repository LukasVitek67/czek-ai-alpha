// Živý test OmniRoute jádra: spustí nainstalovaný OmniRoute v dočasné složce, zapíše bezklíčové
// poskytovatele + tierlisty, pošle přes proxy Zdarmy požadavek s nástrojem a vše zase vypne.
// node test/omniroute-live.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { PROVIDERS } = require('../src/providers');
const { ModelRegistry } = require('../src/agent');
const { createProxy, listen } = require('../src/proxy');
const { OmniRoute, find } = require('../src/omniroute');

(async () => {
  if (!find()) { console.log('OmniRoute není nainstalovaný – přeskočeno'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-omni-'));
  const enabled = ['ovh', 'llm7', 'kilo', 'pollinations'];
  const settings = { providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, { enabled: enabled.includes(p.id) }])), customProviders: [], favorites: [], fallback: true, preferFamilies: ['kimi', 'deepseek-v4', 'glm'], tiers: {} };
  const registry = new ModelRegistry(() => settings);
  const eng = new OmniRoute({ dataDir: path.join(root, 'data'), log: (l) => console.log('  ' + l) });
  process.on('exit', () => eng.stop());
  const t0 = Date.now();
  await eng.start();
  console.log(`start ${Date.now() - t0} ms`);
  const { models } = await registry.list();
  const s1 = await eng.sync({ registry, models, settings });
  assert.ok(s1.providers >= 3, 'aspoň 3 bezklíčoví poskytovatelé');
  assert.ok(eng.comboFor('max') === 'zdarma-max', 'combo pro Max');
  const realApi = eng.api.bind(eng);
  let connPuts = 0;
  eng.api = (m, p, b) => { if (m === 'PUT' && p.startsWith('/api/providers/')) connPuts++; return realApi(m, p, b); };
  const s2 = await eng.sync({ registry, models, settings }); // podruhé: nic nového nevznikne
  eng.api = realApi;
  assert.strictEqual(connPuts, 0, 'beze změny klíčů se připojení nepřepisují (OmniRoute by je znovu testoval)');
  const maxCombo = (await eng.api('GET', '/api/combos')).combos.find((c) => c.name === 'zdarma-max');
  assert.strictEqual(maxCombo.strategy, 'priority', 'combo jde v pořadí tierlistu');
  const nodes = (await eng.api('GET', '/api/provider-nodes')).nodes.filter((n) => n.prefix.startsWith('z-'));
  assert.strictEqual(nodes.length, s2.providers, 'synchronizace je idempotentní');
  console.log(`sync ok: ${s2.providers} poskytovatelů, ${s2.combos} combo`);

  const traces = [];
  const server = createProxy({ registry, getSettings: () => settings, omni: () => eng, trace: (e) => traces.push(e) });
  const port = await listen(server, 0);
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'zdarma/max', stream: true, messages: [{ role: 'user', content: 'Přečti soubor a.txt pomocí nástroje read.' }], tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }] }),
  });
  const text = await r.text();
  assert.strictEqual(r.status, 200, text.slice(0, 300));
  assert.ok(/"tool_calls"/.test(text), 'odpověď obsahuje volání nástroje');
  assert.ok(!/"usage"/.test(text), 'usage se klientovi neposílá, když o něj nežádal');
  const t = traces[0];
  assert.ok(t && t.ok && t.via === 'omniroute', 'záznam přes OmniRoute');
  assert.ok(t.model.includes('/'), 'skutečný model, ne jen název combo: ' + t.model);
  console.log(`chat ok přes ${t.model} · nástroje ${t.attempts[0].toolCalls} · rozbité argumenty ${t.attempts[0].badArgs}`);
  // měření rychlosti: skutečné řádky call_logs mají pole, která rebalance čte (model, provider, duration, status, timestamp)
  await new Promise((r) => setTimeout(r, 1500)); // zápis logu doběhne asynchronně
  const rows = await eng.api('GET', '/api/usage/call-logs?limit=300&excludeTests=1');
  const mine = (Array.isArray(rows) ? rows : []).filter((x) => eng.nodeToProvider.has(x.provider));
  assert.ok(mine.length >= 1, 'call_logs obsahují pokus přes uzel Zdarmy');
  const okRow = mine.find((x) => Number(x.status) === 200);
  assert.ok(okRow && typeof okRow.model === 'string' && Number(okRow.duration) > 0 && Number.isFinite(Date.parse(okRow.timestamp)), 'pole model/duration/status/timestamp: ' + JSON.stringify(okRow && { model: okRow.model, status: okRow.status, duration: okRow.duration, timestamp: okRow.timestamp }));
  const rb = await eng.rebalance();
  console.log(`rebalance ok: pomalé ${rb.slow.length ? rb.slow.join(', ') : 'žádné'}, přepsáno ${rb.changed} · změřený ${eng.nodeToProvider.get(okRow.provider)}/${okRow.model} ${okRow.duration} ms`);
  server.close();
  eng.stop();
  await new Promise((res) => setTimeout(res, 800));
  assert.ok(!(await eng.health()), 'OmniRoute po stop() neběží');
  console.log('omniroute-live OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
