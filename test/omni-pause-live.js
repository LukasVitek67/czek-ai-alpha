// Živě: skutečný OmniRoute (dočasná složka, volný port) + skutečné OVH bez klíče. OVH od listopadu 2026 povolí bez klíče
// 1 dotaz na model a IP za rok („x-ratelimit-limit-year: 1“) a 429 má retry-after do 1. 1. → OmniRoute model zablokuje
// na ~41 dní. Měří: jak dlouhou pauzu OmniRoute udělá, že ji czek-ai (syncCooldowns) vidí, model nedá do závodu, monitor
// ukáže „pauza OmniRoute do …“, a že po reprobeMs pauzu smaže → model znovu závodí; když OVH dál odmítá, pauza je zpět.
// Používá model, který má vyčerpaný roční limit už z měření 20. 11. (OVH_MODEL), takže další dotazy nic nepálí.
// node test/omni-pause-live.js   (OVH_MODEL=… jiný vyčerpaný model, REPROBE_MS=… délka do opakovaného pokusu)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { PROVIDERS } = require('../src/providers');
const { ModelRegistry } = require('../src/agent');
const { OmniRoute, find } = require('../src/omniroute');
const { buildModels, buildAlerts, alertText } = require('../src/monitor');

const OVH_MODEL = process.env.OVH_MODEL || 'nemotron3-nano-30b';
const REPROBE = Number(process.env.REPROBE_MS) || 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!find()) { console.log('OmniRoute není nainstalovaný – přeskočeno'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'czek-omni-pause-'));
  const settings = { providers: Object.fromEntries(PROVIDERS.map((p) => [p.id, { enabled: p.id === 'ovh' }])), customProviders: [], favorites: [], fallback: true, tiers: {} };
  const registry = new ModelRegistry(() => settings);
  const logs = [];
  const eng = new OmniRoute({ dataDir: path.join(root, 'data'), log: (l) => logs.push(l) });
  process.on('exit', () => { try { eng.stop(); } catch {} });
  await eng.start();
  const { models } = await registry.list();
  await eng.sync({ registry, models, settings });
  const node = [...eng.nodeToProvider].find(([, p]) => p === 'ovh')?.[0];
  assert.ok(node, 'uzel OVH v OmniRoute');
  const ref = 'z-ovh/' + OVH_MODEL;
  const key = await eng.ensureKey();
  const ask = async () => {
    const r = await fetch(eng.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: ref, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(60000) });
    return { status: r.status, retryAfter: r.headers.get('retry-after'), body: (await r.text()).slice(0, 400) };
  };
  const cooldowns = async () => ((await eng.api('GET', '/api/resilience/model-cooldowns')).items || []).filter((x) => x.model === OVH_MODEL);
  // syntetické combo: OVH model + dva jiní (jen pro výběr závodníků, nikam se neposílá)
  eng.baseLists.set('zdarma-test', [{ ref, provider: 'ovh', id: OVH_MODEL }, { ref: 'z-kilo/a', provider: 'kilo', id: 'a' }, { ref: 'nvidia/b', provider: 'nvidia', id: 'b' }]);
  eng.slow = new Set();
  eng.reprobeMs = REPROBE;
  const races = () => eng.raceCandidates('zdarma-test', 6, 2).includes(ref);
  assert.ok(races(), 'před 429 závodí');

  // 1. dotaz → OVH 429 → OmniRoute pauza
  const t429 = Date.now();
  const r1 = await ask();
  console.log(`1. dotaz ${ref}: HTTP ${r1.status} ${r1.body.replace(/\s+/g, ' ').slice(0, 160)}`);
  assert.strictEqual(r1.status, 429, 'OVH má limit vyčerpaný (jinak zvol jiný OVH_MODEL)');
  const cd1 = await cooldowns();
  assert.strictEqual(cd1.length, 1, 'OmniRoute model zablokoval: ' + JSON.stringify(cd1));
  const pauseH = cd1[0].remainingMs / 3600e3;
  const until1 = new Date(Date.now() + cd1[0].remainingMs);
  console.log(`   pauza OmniRoute: ${pauseH.toFixed(1)} h (do ${until1.toISOString()}), důvod ${cd1[0].reason}`);
  assert.ok(pauseH > 24, 'pauza z hlavičky OVH je dlouhá (dny)');

  // 2. czek-ai ji vidí: model nezávodí, monitor ji ukáže
  await eng.syncCooldowns();
  const p = eng.paused.get('ovh/' + OVH_MODEL);
  assert.ok(p && Math.abs(p.until - until1.getTime()) < 60000, 'paused do stejného času jako OmniRoute');
  assert.ok(!races(), 'v pauze OmniRoute nezávodí');
  const mm = buildModels({ omniEngine: eng, calls: [], race: null }, new Map(), Date.now()).find((m) => m.model === ref);
  assert.ok(mm && mm.states.includes('paused') && mm.pausedUntil, 'monitor: ' + JSON.stringify(mm));
  const al = buildAlerts({ x: {}, models: [mm], calls: [], sessions: [], guard: [], components: [], rows: [] }, Date.now()).find((a) => a.code === 'omniPaused');
  console.log('   monitor: ' + alertText(al));

  // 3. po reprobeMs czek-ai pauzu smaže → model znovu závodí
  while (races() === false && Date.now() - t429 < REPROBE + 30000) { await sleep(500); await eng.syncCooldowns(); }
  const back = Date.now() - t429;
  assert.ok(races(), 'po reprobeMs znovu závodí');
  assert.strictEqual((await cooldowns()).length, 0, 'pauza v OmniRoute smazaná');
  console.log(`   znovu závodí za ${(back / 1000).toFixed(1)} s od 429 (reprobeMs ${REPROBE / 1000} s; v appce 30 min)`);

  // 4. OVH dál odmítá → OmniRoute pauzu vrátí, czek-ai ji zase vidí
  const r2 = await ask();
  console.log(`2. dotaz po smazání pauzy: HTTP ${r2.status}`);
  const cd2 = await cooldowns();
  await eng.syncCooldowns();
  assert.strictEqual(r2.status, 429);
  assert.strictEqual(cd2.length, 1, 'pauza zpět');
  assert.ok(!races(), 'zase mimo závod');
  const calls = (await eng.api('GET', '/api/usage/call-logs?limit=50')).filter((x) => x.model === OVH_MODEL);
  console.log(`   OmniRoute záznamy volání ${OVH_MODEL}: ${calls.length} (stav ${calls.map((x) => x.status).join(', ')})`);
  console.log('   log czek-ai: ' + logs.filter((l) => /pauz/.test(l)).join(' | '));
  console.log(`omni-pause-live OK (OVH 429 → pauza OmniRoute ${pauseH.toFixed(0)} h; czek-ai: mimo závod, monitor „do ${until1.toISOString().slice(0, 16)}“, znovu závodí po ${(back / 1000).toFixed(0)} s, OVH dál 429 → pauza zpět)`);
  eng.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
