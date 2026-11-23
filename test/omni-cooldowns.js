// Pauzy modelů v OmniRoute (OmniRoute.syncCooldowns + src/race.js + monitor): po 429 OmniRoute drží model v pauze
// podle poskytovatele (20. 11. 2026: OVH bez klíče retry-after do 1. 1. = 41 dní, Gemini 3 Flash retryDelay 10 h).
// czek-ai pauzy čte z /api/resilience/model-cooldowns: model v pauze nezávodí (ani jako náhradník), vidění ho přeskočí,
// monitor ukáže „pauza OmniRoute do …“ a upozornění; pauzu, kterou vidí 30 min, v OmniRoute smaže → model znovu závodí
// (když poskytovatel dál odmítá, OmniRoute ho zablokuje znovu). Závod bere reset_seconds z chyby model_cooldown.
// node test/omni-cooldowns.js
'use strict';
const assert = require('assert');
const http = require('http');
const { OmniRoute } = require('../src/omniroute');
const { createRaceProxy, cooldownResetMs } = require('../src/race');
const { buildModels, buildAlerts, alertText } = require('../src/monitor');

const H = 3600e3;
const OVH = 'openai-compatible-chat-d6217228';
const base = [
  { ref: 'z-ovh/DeepSeek-V4.1-Flash-1017', provider: 'ovh', id: 'DeepSeek-V4.1-Flash-1017' },
  { ref: 'gemini/gemini-3-flash-preview', provider: 'gemini', id: 'gemini-3-flash-preview' },
  { ref: 'z-kilo/nemotron:free', provider: 'kilo', id: 'nemotron:free' },
  { ref: 'nvidia/kimi', provider: 'nvidia', id: 'kimi' },
  { ref: 'groq/gpt-oss', provider: 'groq', id: 'gpt-oss' },
];

(async () => {
  // ---- 1. synchronizace pauz, závodníci, vidění, opakovaný pokus
  const o = new OmniRoute({ dataDir: '.' });
  const logs = [];
  o.log = (l) => logs.push(l);
  o.nodeToProvider = new Map([[OVH, 'ovh'], ['gemini', 'gemini'], ['kilo-gateway', 'kilo'], ['nvidia', 'nvidia'], ['groq', 'groq']]);
  o.baseLists = new Map([
    ['zdarma-max', base],
    ['qwen3-vl-30b-a3b', [{ ref: 'z-ovh/qwen3-vl-30b-a3b', provider: 'ovh', id: 'qwen3-vl-30b-a3b' }]],
    ['gemini-3-flash-preview', [base[1], { ref: 'openrouter/gemini-3-flash-preview', provider: 'openrouter', id: 'gemini-3-flash-preview' }]],
  ]);
  o.slow = new Set();
  let t = Date.now(); // raceCandidates porovnává se skutečným časem
  const omniPause = new Map(); // klíč uzel|model → do kdy (jako paměť OmniRoute)
  const deleted = [];
  omniPause.set(`${OVH}|DeepSeek-V4.1-Flash-1017`, t + 985 * H);
  omniPause.set(`${OVH}|qwen3-vl-30b-a3b`, t + 985 * H);
  omniPause.set('gemini|gemini-3-flash-preview', t + 37331e3);
  omniPause.set('kilo-gateway|nemotron:free', t + 20e3); // krátké 429 – běžný provoz
  o.api = async (method, p, body) => {
    assert.ok(p.startsWith('/api/resilience/model-cooldowns'), p);
    if (method === 'DELETE') { deleted.push(body); omniPause.delete(`${body.provider}|${body.model}`); return { ok: true, removed: true }; }
    return { items: [...omniPause].map(([k, until]) => { const [provider, model] = k.split('|'); return { provider, model, connectionId: 'c', reason: 'rate_limited', remainingMs: until - t, failureCount: 1 }; }).filter((x) => x.remainingMs > 0) };
  };
  const before = o.raceCandidates('zdarma-max', 6, 2);
  assert.ok(before.includes('z-ovh/DeepSeek-V4.1-Flash-1017'), 'bez synchronizace OVH závodí (0.15.24)');
  const s1 = await o.syncCooldowns(t);
  assert.strictEqual(s1.paused, 4);
  assert.ok(o.isPaused(base[0], t) && o.isPaused(base[1], t) && o.isPaused(base[2], t));
  assert.strictEqual(o.paused.get('ovh/DeepSeek-V4.1-Flash-1017').until, t + 985 * H);
  assert.strictEqual(o.paused.get('ovh/DeepSeek-V4.1-Flash-1017').ref, 'z-ovh/DeepSeek-V4.1-Flash-1017', 'ref uzlu jako v combo');
  assert.strictEqual(o.paused.get('gemini/gemini-3-flash-preview').ref, 'gemini/gemini-3-flash-preview', 'ref nativního poskytovatele');
  assert.strictEqual(o.paused.get('ovh/DeepSeek-V4.1-Flash-1017').reprobeAt, t + 30 * 60e3, 'dlouhá pauza: czek-ai ji zkusí znovu za 30 min');
  assert.strictEqual(o.paused.get('kilo/nemotron:free').reprobeAt, null, 'krátká pauza vyprší sama');
  const c1 = o.raceCandidates('zdarma-max', 6, 2);
  assert.deepStrictEqual([...c1], ['nvidia/kimi', 'groq/gpt-oss'], 'v pauze OmniRoute nezávodí ani jako náhradník: ' + c1.join(','));
  assert.ok(o.comboPaused('qwen3-vl-30b-a3b', t), 'vidění: Qwen VL jen u OVH → přeskočit');
  assert.ok(!o.comboPaused('gemini-3-flash-preview', t), 'vidění: Gemini Flash má ještě OpenRouter → zkusit');
  assert.ok(logs.some((l) => /ovh\/DeepSeek-V4\.1-Flash-1017 v pauze 985 h/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /nemotron/.test(l)), 'krátké 429 do logu ne');

  // za 25 min: krátká pauza Kilo vypršela → Kilo zpět; dlouhé dál
  t += 25 * 60e3;
  await o.syncCooldowns(t);
  assert.ok(!o.paused.has('kilo/nemotron:free') && !o.pausedSince.has('kilo/nemotron:free'));
  assert.ok(o.raceCandidates('zdarma-max', 6, 2).includes('z-kilo/nemotron:free'));
  assert.strictEqual(deleted.length, 0);

  // za 30 min od prvního pohledu: dlouhé pauzy czek-ai smaže → model znovu závodí
  t += 5 * 60e3;
  const s2 = await o.syncCooldowns(t);
  assert.deepStrictEqual(s2.reprobed.sort(), ['gemini/gemini-3-flash-preview', 'ovh/DeepSeek-V4.1-Flash-1017', 'ovh/qwen3-vl-30b-a3b']);
  assert.deepStrictEqual(deleted.map((d) => d.provider + '|' + d.model).sort(), ['gemini|gemini-3-flash-preview', `${OVH}|DeepSeek-V4.1-Flash-1017`, `${OVH}|qwen3-vl-30b-a3b`], 'DELETE s id uzlu OmniRoute');
  assert.strictEqual(o.paused.size, 0);
  const c2 = o.raceCandidates('zdarma-max', 6, 2);
  assert.ok(c2.includes('z-ovh/DeepSeek-V4.1-Flash-1017') && c2.includes('gemini/gemini-3-flash-preview'), 'po 30 min znovu závodí: ' + c2.join(','));
  assert.ok(logs.some((l) => /pauza ovh\/DeepSeek-V4\.1-Flash-1017 smazána po 30 min/.test(l)));

  // poskytovatel dál odmítá → OmniRoute pauzu vrátí → czek-ai ji bere jako novou (další pokus za 30 min)
  omniPause.set(`${OVH}|DeepSeek-V4.1-Flash-1017`, t + 984 * H);
  await o.syncCooldowns(t + 1000);
  assert.strictEqual(o.paused.get('ovh/DeepSeek-V4.1-Flash-1017').reprobeAt, t + 1000 + 30 * 60e3);
  // restart OmniRoute (paměť pauz prázdná) → czek-ai pauzy zapomene
  omniPause.clear();
  await o.syncCooldowns(t + 2000);
  assert.strictEqual(o.paused.size, 0);
  assert.strictEqual(o.pausedSince.size, 0);

  // ---- 2. závod: reset_seconds z chyby model_cooldown
  assert.strictEqual(cooldownResetMs('{"error":{"message":"All credentials for model x are cooling down","type":"rate_limit_error","code":"model_cooldown","model":"x","reset_seconds":3543201}}'), 3543201e3);
  assert.strictEqual(cooldownResetMs({ message: 'cooling', code: 'model_cooldown', reset_seconds: 20 }), 20e3);
  assert.strictEqual(cooldownResetMs('{"error":{"message":"API rate limit exceeded"}}'), null);
  assert.strictEqual(cooldownResetMs('není JSON'), null);
  const reqs = [];
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const m = JSON.parse(b).model;
      reqs.push(m);
      if (m === 'z-ovh/long') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3543201' }); res.end(JSON.stringify({ error: { message: 'All credentials for model long are cooling down', type: 'rate_limit_error', code: 'model_cooldown', model: 'long', reset_seconds: 3543201 } })); return; }
      if (m === 'gemini/short') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ error: { message: 'All credentials for model short are cooling down', type: 'rate_limit_error', code: 'model_cooldown', model: 'short', reset_seconds: 20 } }) + '\n\n'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${fake.address().port}`;
  const proxy = createRaceProxy({ target: () => target, n: () => 2, graceMs: 50, candidates: () => Object.assign(['z-ovh/long', 'gemini/short', 'z-kilo/ok'], { racers: 2 }) });
  const url = await proxy.listen(0);
  const r = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'zdarma-max', stream: true, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] }) });
  const txt = await r.text();
  assert.ok(/ok/.test(txt), txt);
  const now = Date.now();
  const coolLong = proxy.cool.get('z-ovh/long') - now;
  const coolShort = proxy.cool.get('gemini/short') - now;
  assert.ok(coolLong > 9.5 * 60e3 && coolLong <= 10 * 60e3, 'dlouhá pauza OmniRoute: paměť závodu 10 min (dál syncCooldowns), ne 90 s: ' + coolLong);
  assert.ok(coolShort > 18e3 && coolShort <= 20e3, 'krátká pauza OmniRoute: jen reset_seconds (20 s), ne 90 s: ' + coolShort);
  await proxy.close(); fake.close();

  // ---- 3. monitor: stav „pauza OmniRoute do …“, upozornění, i model bez volání za hodinu
  const tm = Date.parse('2026-11-20T23:50:00Z');
  const eng = { baseLists: o.baseLists, nodeToProvider: o.nodeToProvider, deadProviders: new Set(), deadModels: new Set(), limited: new Set(), flaky: new Set(), slow: new Set(),
    paused: new Map([['ovh/qwen3-vl-30b-a3b', { until: Date.parse('2026-12-31T23:00:00Z'), reason: 'rate_limited', since: tm, reprobeAt: tm + 30 * 60e3 }],
      ['gemini/gemini-3-flash-preview', { until: tm + 5 * 60e3, reason: 'rate_limit_exceeded', since: tm, reprobeAt: null }],
      ['ovh/nemotron3-nano-30b', { ref: 'z-ovh/nemotron3-nano-30b', until: tm + 900 * H, reason: 'rate_limited', since: tm, reprobeAt: tm + 30 * 60e3 }]]) };
  // model mimo combo s řádkem volání OmniRoute (429) → jeden řádek, stav pauza
  const omniRows = new Map([['r1', { id: 'r1', at: tm - 60e3, provider: OVH, model: 'nemotron3-nano-30b', requested: 'z-ovh/nemotron3-nano-30b', status: 429, duration: 400, error: 'cooling down' }]]);
  const models = buildModels({ omniEngine: eng, calls: [], race: null }, omniRows, tm);
  const nn = models.filter((m) => /nemotron3-nano-30b/.test(m.model));
  assert.strictEqual(nn.length, 1, 'model mimo combo jen jednou: ' + nn.map((m) => m.model).join(','));
  assert.deepStrictEqual([nn[0].model, nn[0].states, nn[0].fail], ['z-ovh/nemotron3-nano-30b', ['paused'], 1]);
  const q = models.find((m) => m.model === 'z-ovh/qwen3-vl-30b-a3b');
  assert.ok(q, 'model v pauze je v tabulce i bez volání: ' + models.map((m) => m.model).join(','));
  assert.deepStrictEqual(q.states, ['paused']);
  assert.strictEqual(q.pausedUntil, Date.parse('2026-12-31T23:00:00Z'));
  assert.strictEqual(q.reprobeAt, tm + 30 * 60e3);
  assert.strictEqual(q.pausedReason, 'rate_limited');
  const alerts = buildAlerts({ x: {}, models, calls: [], sessions: [], guard: [], components: [], rows: [] }, tm);
  const pa = alerts.filter((a) => a.code === 'omniPaused');
  assert.deepStrictEqual(pa.map((a) => a.params.model).sort(), ['z-ovh/nemotron3-nano-30b', 'z-ovh/qwen3-vl-30b-a3b'], 'upozornění jen na dlouhé pauzy (Gemini 5 min ne)');
  assert.ok(pa.every((a) => a.level === 'info'));
  pa.sort((a, b) => (a.params.model < b.params.model ? 1 : -1));
  assert.match(alertText(pa[0]), /z-ovh\/qwen3-vl-30b-a3b: OmniRoute ho po limitu poskytovatele drží v pauze do (1\. 1\. 2027|31\. 12\.) \d\d:00 \(rate_limited\); czek-ai ho do závodu nedá, znovu zkusí v/);
  console.log(`omni-cooldowns OK (pauzy OVH 985 h / Gemini 10 h mimo závod a vidění, po 30 min znovu závodí, závod: paměť ${Math.round(coolLong / 60e3)} min / ${Math.round(coolShort / 1e3)} s místo 90 s, monitor: ${alertText(pa[0])})`);
})().catch((e) => { console.error(e); process.exit(1); });
