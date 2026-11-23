// Modely s vyčerpaným limitem (většina odpovědí 429) jdou za fungující, ale před pomalé a mrtvé.
// Živě 8. 11. na Mid: Codestral 45/53 × 429, Gemma 35/35 × 429, Kilo auto 43/45 OK.
'use strict';
const assert = require('assert');
const { OmniRoute } = require('../src/omniroute');
const o = new OmniRoute({ dataDir: '.' });
o.nodeToProvider = new Map([['n-mi', 'mistral'], ['n-or', 'openrouter'], ['n-ovh', 'ovh'], ['n-kilo', 'kilo'], ['n-hf', 'huggingface']]);
const base = [
  { ref: 'z-huggingface/qwen', provider: 'huggingface', id: 'qwen' },
  { ref: 'z-ovh/qwen27', provider: 'ovh', id: 'qwen27' },
  { ref: 'z-mistral/codestral', provider: 'mistral', id: 'codestral' },
  { ref: 'z-openrouter/gemma', provider: 'openrouter', id: 'gemma' },
  { ref: 'z-kilo/auto', provider: 'kilo', id: 'auto' },
];
o.baseLists = new Map([['zdarma-mid', base]]);
const now = Date.now();
const rows = [];
const add = (provider, model, status, n, duration = 2000) => { for (let i = 0; i < n; i++) rows.push({ timestamp: new Date(now - 60e3 - i * 1000).toISOString(), provider, model, status, duration }); };
add('n-mi', 'codestral', 429, 9); add('n-mi', 'codestral', 200, 1); // 90 % 429 → limit
add('n-or', 'gemma', 429, 6); // 100 % → limit
add('n-kilo', 'auto', 429, 1); add('n-kilo', 'auto', 200, 8); // občasné 429 → fungující
add('n-ovh', 'qwen27', 429, 2); // jen 2 pokusy: na „limit“ málo dat, ale samá selhání → za fungující (nespolehlivý)
add('n-hf', 'qwen', 402, 1); // mrtvý účet
o.api = async () => rows;
(async () => {
  const slow = await o.speedStats(now);
  assert.strictEqual(slow.size, 0);
  assert.deepStrictEqual([...o.limited].sort(), ['mistral/codestral', 'openrouter/gemma']);
  o.slow = new Set();
  const order = o.arrange(base).map((x) => x.ref);
  assert.deepStrictEqual(order, ['z-kilo/auto', 'z-ovh/qwen27', 'z-mistral/codestral', 'z-openrouter/gemma'], order.join(',')); // mrtvý HF (402) ven; OVH jen selhal → za Kilo
  // pomalý má přednost před „limitem“: model, který je pomalý, nejde mezi omezené
  o.slow = new Set(['mistral/codestral']);
  const order2 = o.arrange(base).map((x) => x.ref);
  assert.deepStrictEqual(order2, ['z-kilo/auto', 'z-ovh/qwen27', 'z-openrouter/gemma', 'z-mistral/codestral'], order2.join(','));
  console.log('omni-limited OK');
})().catch((e) => { console.error(e); process.exit(1); });
