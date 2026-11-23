// Pomalé modely na konec combo (8. 11.: NVIDIA GLM/MiniMax/DeepSeek Flash 45–180 s na krok, polovina
// timeout – a s priority v pořadí tierlistu čekal každý krok, než vyprší). Falešné API OmniRoute:
// metadata call_logs + combo; ověřuje měření, pořadí a že se zapisuje jen při změně.
'use strict';
const assert = require('assert');
const { OmniRoute } = require('../src/omniroute');

const now = Date.now();
const ago = (s) => new Date(now - s * 1000).toISOString();
const NV = 'openai-compatible-chat-nvidia';
const KILO = 'openai-compatible-chat-kilo';

const eng = new OmniRoute({ dataDir: 'x', log: () => {} });
eng.ready = true;
eng.nodeToProvider.set(NV, 'nvidia').set(KILO, 'kilo').set('gemini', 'gemini');
const base = [
  { ref: 'z-nvidia/deepseek-ai/deepseek-v4.1-flash', provider: 'nvidia', id: 'deepseek-ai/deepseek-v4.1-flash' },
  { ref: 'z-nvidia/z-ai/glm-5.3-flash', provider: 'nvidia', id: 'z-ai/glm-5.3-flash' },
  { ref: 'z-nvidia/nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia', id: 'nvidia/nemotron-3-ultra-550b-a55b' },
  { ref: 'z-kilo/nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'kilo', id: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { ref: 'gemini/gemini-3-flash-preview', provider: 'gemini', id: 'gemini-3-flash-preview' },
];
eng.baseLists.set('zdarma-max', base);
eng.applied.set('zdarma-max', base.map((x) => x.ref).join('\n'));

let logs = [];
const puts = [];
const reads = [];
eng.api = async (method, p, body) => {
  if (method === 'GET' && p.startsWith('/api/usage/call-logs')) { reads.push(p); return logs; }
  if (method === 'GET' && p === '/api/combos') return { combos: [{ id: 'c1', name: 'zdarma-max' }] };
  if (method === 'PUT') { puts.push({ p, body }); return {}; }
  throw new Error('neočekávané volání ' + method + ' ' + p);
};
const row = (provider, model, status, duration, sAgo, extra = {}) => ({ timestamp: ago(sAgo), provider, model, status, duration, requestSummary: { tajne: 'obsah' }, error: 'x', ...extra });

(async () => {
  logs = [
    // DeepSeek: 2× bez odpovědi (status 0 + 504) z 2 → pomalý
    row(NV, 'deepseek-ai/deepseek-v4.1-flash', 0, 0, 60),
    row(NV, 'deepseek-ai/deepseek-v4.1-flash', 504, 110000, 60),
    // GLM Flash: úspěchy, ale medián ~100 s → pomalý
    row(NV, 'z-ai/glm-5.3-flash', 200, 101900, 300),
    row(NV, 'z-ai/glm-5.3-flash', 200, 95600, 200),
    row(NV, 'z-ai/glm-5.3-flash', 200, 149400, 100),
    // Nemotron NVIDIA: rychlý, jedna chyba z 3 → ne
    row(NV, 'nvidia/nemotron-3-ultra-550b-a55b', 200, 1600, 50),
    row(NV, 'nvidia/nemotron-3-ultra-550b-a55b', 200, 2100, 40),
    row(NV, 'nvidia/nemotron-3-ultra-550b-a55b', 504, 110000, 30),
    // Kilo: upstream vrací model bez ":free" – i tak spárovat; rychlý
    row(KILO, 'nvidia/nemotron-3-ultra-550b-a55b', 200, 3000, 20),
    // Gemini: pomalý, ale před >2 h → mimo okno
    row('gemini', 'gemini-3-flash-preview', 200, 90000, 8000),
    // 402/429 nejsou „pomalé“ (selžou hned)
    row(KILO, 'nvidia/nemotron-3-ultra-550b-a55b:free', 429, 300, 10),
    // řádek celého combo (poskytovatel není uzel Zdarmy) → ignorovat
    row('zdarma-max', 'zdarma-max', 499, 300000, 5),
  ];
  const r1 = await eng.rebalance();
  assert.ok(reads[0].includes('limit=2000') && !reads[0].includes('excludeTests'), 'excludeTests=1 vrací v OmniRoute 3.8.x prázdno');
  assert.deepEqual(r1.slow.sort(), ['nvidia/deepseek-ai/deepseek-v4.1-flash', 'nvidia/z-ai/glm-5.3-flash']);
  assert.equal(r1.changed, 1);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].p, '/api/combos/c1');
  assert.deepEqual(puts[0].body.models, [
    'z-nvidia/nvidia/nemotron-3-ultra-550b-a55b',
    'z-kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
    'gemini/gemini-3-flash-preview',
    'z-nvidia/deepseek-ai/deepseek-v4.1-flash', // pomalé na konci, v pořadí tierlistu
    'z-nvidia/z-ai/glm-5.3-flash',
  ]);
  assert.equal(puts[0].body.strategy, 'priority');
  assert.deepEqual(puts[0].body.config, { maxRetries: 0 });
  assert.equal(eng.comboModels.get('zdarma-max')[0].id, 'nvidia/nemotron-3-ultra-550b-a55b', 'keyForModel vidí nové pořadí');
  assert.equal(eng.slowInfo.get('nvidia/z-ai/glm-5.3-flash').medianMs, 101900);
  assert.ok(!JSON.stringify([...eng.slowInfo]).includes('tajne'), 'obsah požadavků se neukládá');

  // stejné měření → nic se nepřepisuje
  const r2 = await eng.rebalance();
  assert.equal(r2.changed, 0);
  assert.equal(puts.length, 1, 'beze změny pořadí žádný zápis');

  // z okna vypadnou (2 h od posledního řádku, callHist je drží 24 h) → modely se vrátí na místo podle tierlistu
  logs = [];
  eng.callHist = new Map();
  const r3 = await eng.rebalance();
  assert.deepEqual(r3.slow, []);
  assert.equal(r3.changed, 1);
  assert.deepEqual(puts[1].body.models, base.map((x) => x.ref));

  // arrange: synchronizace použije aktuální odsunutí
  eng.slow = new Set(['nvidia/z-ai/glm-5.3-flash']);
  assert.equal(eng.arrange(base).at(-1).id, 'z-ai/glm-5.3-flash');

  // když neběží, nic nedělá
  eng.ready = false;
  const r4 = await eng.rebalance();
  assert.equal(r4.changed, 0);

  console.log('omni-rebalance OK');
})().catch((e) => { console.error(e); process.exit(1); });
