// Nespolehlivý model (za posledních 30 min ≥ 6 pokusů a ≥ 25 % z nich bez odpovědi) jde za spolehlivé, ale před
// modely s vyčerpaným limitem a pomalé. Živě 14. 11. (tier Unlimited): GLM 4.7 Flash první v 85 ze 105 kroků
// s úspěšností 63 % (529 přetížení, visení 45 s, 429) → na krok odpovídalo 6 různých modelů.
'use strict';
const assert = require('assert');
const { OmniRoute } = require('../src/omniroute');

const base = [
  { ref: 'zai/glm-4.7-flash', provider: 'zai', id: 'glm-4.7-flash' },
  { ref: 'zai/glm-4.5-flash', provider: 'zai', id: 'glm-4.5-flash' },
  { ref: 'z-kilo/nemotron', provider: 'kilo', id: 'nemotron' },
  { ref: 'openrouter/nemotron:free', provider: 'openrouter', id: 'nemotron:free' },
];
const mk = () => {
  const o = new OmniRoute({ dataDir: 'x' });
  o.nodeToProvider = new Map([['zai', 'zai'], ['n-kilo', 'kilo'], ['openrouter', 'openrouter']]);
  o.baseLists = new Map([['zdarma-unlimited', base]]);
  return o;
};
const now = Date.now();
let seq = 0;
const row = (provider, model, status, minAgo, duration = 6000) => ({ id: 'r' + (seq++), timestamp: new Date(now - minAgo * 60000).toISOString(), provider, model, status, duration, path: '/chat/completions' });
const order = async (rows) => { const o = mk(); o.api = async () => rows; await o.loadSpeed(); return { o, order: o.arrange(base).map((x) => x.ref) }; };

(async () => {
  // 1) GLM 4.7: 10 pokusů za 20 min, 6× 200, 2× 529, 2× visel (499 po 45 s) = 40 % bez odpovědi → nespolehlivý
  const glm47 = [...[1, 3, 5, 7, 9, 11].map((m) => row('zai', 'glm-4.7-flash', 200, m)), row('zai', 'glm-4.7-flash', 529, 2, 500), row('zai', 'glm-4.7-flash', 529, 6, 500),
    row('zai', 'glm-4.7-flash', 499, 4, 45000), row('zai', 'glm-4.7-flash', 499, 18, 45000)];
  const good = [...[1, 2, 3, 4, 5, 6, 7].map((m) => row('zai', 'glm-4.5-flash', 200, m, 13000)), ...[1, 2, 3].map((m) => row('n-kilo', 'nemotron', 200, m, 4000))];
  let r = await order([...glm47, ...good]);
  assert.deepStrictEqual([...r.o.flaky], ['zai/glm-4.7-flash']);
  assert.deepStrictEqual(r.order, ['zai/glm-4.5-flash', 'z-kilo/nemotron', 'openrouter/nemotron:free', 'zai/glm-4.7-flash'], r.order.join(','));
  assert.strictEqual(r.o.deadModels.size, 0, '2 visení s úspěchem mezi nimi = ne mrtvý');

  // 2) málo pokusů (5) → zůstává v čele; 1 chyba z 10 (10 %) → taky
  r = await order([...glm47.slice(0, 3), row('zai', 'glm-4.7-flash', 529, 2, 500), row('zai', 'glm-4.7-flash', 529, 6, 500)]);
  assert.strictEqual(r.o.flaky.size, 0, 'pod 6 pokusů se nerozhoduje');
  r = await order([...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => row('zai', 'glm-4.7-flash', 200, m)), row('zai', 'glm-4.7-flash', 529, 10, 500)]);
  assert.strictEqual(r.o.flaky.size, 0, '10 % chyb je v pořádku');
  assert.strictEqual(r.order[0], 'zai/glm-4.7-flash');

  // 3) chyby dotazu (400/413) a rozpracované řádky (stav 0) se nepočítají
  r = await order([...[1, 2, 3, 4, 5, 6].map((m) => row('zai', 'glm-4.7-flash', 200, m)), ...[1, 2, 3].map((m) => row('zai', 'glm-4.7-flash', 413, m, 200)), ...[1, 2, 3].map((m) => row('zai', 'glm-4.7-flash', 0, m, 0))]);
  assert.strictEqual(r.o.flaky.size, 0, '413 a stav 0 nejsou chyba modelu');

  // 4) po 30 minutách bez dalších chyb se vrací do čela (zkusí se znovu)
  r = await order(glm47.map((x) => ({ ...x, timestamp: new Date(Date.parse(x.timestamp) - 31 * 60000).toISOString() })));
  assert.strictEqual(r.o.flaky.size, 0);
  assert.strictEqual(r.order[0], 'zai/glm-4.7-flash');

  // 5) většina 429 = „limit“ (ne nespolehlivý), pořadí: spolehlivé → nespolehlivé → limit
  const limited = [1, 2, 3, 4, 5, 6, 7, 8].map((m) => row('openrouter', 'nemotron:free', 429, m, 300));
  r = await order([...glm47, ...good, ...limited]);
  assert.deepStrictEqual([...r.o.limited], ['openrouter/nemotron:free']);
  assert.deepStrictEqual(r.order, ['zai/glm-4.5-flash', 'z-kilo/nemotron', 'zai/glm-4.7-flash', 'openrouter/nemotron:free'], r.order.join(','));
  // 6) jen selhání a žádná odpověď → odsunutý hned po prvním (15. 11.: GLM 4.7 Flash 529 a tři poskytovatelé
  //    Nemotronu 503/504 zůstali v čele do pravidelného přepočtu, první dotazy relace ztratily 84 a 126 s)
  r = await order([row('zai', 'glm-4.7-flash', 529, 1, 500)]);
  assert.deepStrictEqual([...r.o.flaky], ['zai/glm-4.7-flash']);
  assert.deepStrictEqual(r.order, ['zai/glm-4.5-flash', 'z-kilo/nemotron', 'openrouter/nemotron:free', 'zai/glm-4.7-flash'], r.order.join(','));
  // jedno selhání, ale i odpověď → zůstává (rozhoduje až podíl z ≥ 6 pokusů)
  r = await order([row('zai', 'glm-4.7-flash', 529, 2, 500), row('zai', 'glm-4.7-flash', 200, 1)]);
  assert.strictEqual(r.o.flaky.size, 0);
  // stejný model pod dvěma jmény upstreamu (Kilo vrací „nemotron“ i „nemotron:free“) se sčítá dohromady
  const o2 = mk();
  o2.baseLists = new Map([['zdarma-unlimited', [{ ref: 'z-kilo/nvidia/nemotron:free', provider: 'kilo', id: 'nvidia/nemotron:free' }]]]);
  o2.api = async () => [row('n-kilo', 'nvidia/nemotron', 200, 2, 3000), row('n-kilo', 'nvidia/nemotron:free', 429, 1, 300)];
  await o2.loadSpeed();
  assert.strictEqual(o2.flaky.size, 0, 'úspěch pod jedním jménem a 429 pod druhým = ne jen selhání');
  console.log('omni-flaky OK');
})().catch((e) => { console.error(e); process.exit(1); });
