// Mrtví poskytovatelé a modely: 402/401/403 = celý účet, 404 = jen ten model, 2× visel = ten model → VEN z combo
// (na konci se pořád zkoušely); úspěch je uzdraví; když jsou mrtví všichni, tier zůstane.
'use strict';
const assert = require('assert');
const { OmniRoute } = require('../src/omniroute');
const o = new OmniRoute({ dataDir: '.' });
o.nodeToProvider = new Map([['n-hf', 'huggingface'], ['n-nv', 'nvidia'], ['n-kilo', 'kilo']]);
o.baseLists = new Map([['zdarma-max', [
  { ref: 'z-huggingface/kimi', provider: 'huggingface', id: 'kimi' },
  { ref: 'z-nvidia/kimi-k3.1-pro', provider: 'nvidia', id: 'kimi-k3.1-pro' },
  { ref: 'z-huggingface/deepseek', provider: 'huggingface', id: 'deepseek' },
  { ref: 'z-nvidia/nemotron', provider: 'nvidia', id: 'nemotron' },
  { ref: 'z-kilo/nemotron', provider: 'kilo', id: 'nemotron' },
]]]);
const now = Date.now();
const iso = (ago) => new Date(now - ago).toISOString();
const d = o.deadFrom([
  { timestamp: iso(60e3), provider: 'n-hf', model: 'kimi', status: 402 },
  { timestamp: iso(50e3), provider: 'n-nv', model: 'kimi-k3.1-pro', status: 404 },
  { timestamp: iso(40e3), provider: 'n-nv', model: 'nemotron', status: 200 },
  { timestamp: iso(73 * 3600e3), provider: 'n-kilo', model: 'nemotron', status: 402 }, // 402 starší než 3 dny
], now);
assert.deepStrictEqual([...d.deadProviders], ['huggingface']);
assert.deepStrictEqual([...d.deadModels], ['nvidia/kimi-k3.1-pro']);
o.deadProviders = d.deadProviders; o.deadModels = d.deadModels; o.slow = new Set();
const order = o.arrange(o.baseLists.get('zdarma-max')).map((x) => x.ref);
assert.deepStrictEqual(order, ['z-nvidia/nemotron', 'z-kilo/nemotron'], order.join(','));
// všichni mrtví → tier nezůstane prázdný
const allDead = o.arrange([{ ref: 'z-huggingface/kimi', provider: 'huggingface', id: 'kimi' }]).map((x) => x.ref);
assert.deepStrictEqual(allDead, ['z-huggingface/kimi']);
// úspěch po chybě model uzdraví
const d2 = o.deadFrom([{ timestamp: iso(30e3), provider: 'n-nv', model: 'kimi-k3.1-pro', status: 404 }, { timestamp: iso(10e3), provider: 'n-nv', model: 'kimi-k3.1-pro', status: 200 }], now);
assert.strictEqual(d2.deadModels.size, 0);
// dvakrát po sobě 504 po ≥ 30 s → mrtvý; jednou nebo krátký 0 (duplikátní řádek OmniRoute) ne; úspěch uzdraví
o.baseLists.get('zdarma-max').push({ ref: 'z-nvidia/deepseek', provider: 'nvidia', id: 'deepseek' });
const hang = (ago, st = 504, ms = 110000) => ({ timestamp: iso(ago), provider: 'n-nv', model: 'deepseek', status: st, duration: ms });
assert.strictEqual(o.deadFrom([hang(90e3), hang(89e3, 0, 0)], now).deadModels.has('nvidia/deepseek'), false);
assert.strictEqual(o.deadFrom([hang(90e3), hang(60e3)], now).deadModels.has('nvidia/deepseek'), true);
assert.strictEqual(o.deadFrom([hang(90e3), hang(60e3), { timestamp: iso(30e3), provider: 'n-nv', model: 'deepseek', status: 200, duration: 3000 }], now).deadModels.has('nvidia/deepseek'), false);
// 499 po 45 s (náš FETCH_TIMEOUT_MS, OmniRoute „Request aborted“) = taky visel – živě 14× DeepSeek 13.–14. 11.
assert.strictEqual(o.deadFrom([hang(90e3, 499, 45056), hang(60e3, 499, 45056)], now).deadModels.has('nvidia/deepseek'), true);
assert.strictEqual(o.deadFrom([hang(90e3, 499, 800), hang(60e3, 499, 900)], now).deadModels.has('nvidia/deepseek'), false); // krátké přerušení (uživatel zastavil) ne
// visí dál bez úspěchu → ven na déle: 2× = 20 min, 3× = 2 h, 4× = 12 h (živě 14. 11.: DeepSeek 39× visel, 0× odpověděl)
const H = 3600e3;
const isDead = (rows) => o.deadFrom(rows, now).deadModels.has('nvidia/deepseek');
assert.strictEqual(isDead([hang(2 * H, 499, 45000), hang(H, 499, 45000)]), false, '2× a poslední před hodinou → zase se zkusí');
assert.strictEqual(isDead([hang(3 * H, 499, 45000), hang(2 * H, 499, 45000), hang(H, 499, 45000)]), true, '3× po sobě → 2 h ven');
assert.strictEqual(isDead([hang(6 * H, 499, 45000), hang(5 * H, 499, 45000), hang(4 * H, 499, 45000)]), false, '3× a poslední před 4 h → zkusí se');
assert.strictEqual(isDead([hang(9 * H, 499, 45000), hang(8 * H, 499, 45000), hang(7 * H, 499, 45000), hang(6 * H, 499, 45000)]), true, '4× po sobě → 12 h ven');
assert.strictEqual(isDead([hang(23 * H, 499, 45000), hang(22 * H, 499, 45000), hang(21 * H, 499, 45000), hang(13 * H, 499, 45000)]), false, '4× ale poslední před 13 h → zkusí se');
const ok = (ago) => ({ timestamp: iso(ago), provider: 'n-nv', model: 'deepseek', status: 200, duration: 5000 });
assert.strictEqual(isDead([hang(4 * H, 499, 45000), hang(3 * H, 499, 45000), ok(2 * H), hang(H, 499, 45000)]), false, 'úspěch řadu vynuluje (GLM 4.7 Flash: visí občas, jinak odpovídá)');
// 402/404 dál jen 6 h (delší historie je jen pro visení)
assert.strictEqual(o.deadFrom([{ timestamp: iso(8 * H), provider: 'n-nv', model: 'kimi-k3.1-pro', status: 404 }], now).deadModels.size, 0);
// poskytovatel, který mapa uzlů nezná (sync se nedokončil): nativní jméno nebo jméno z combo se pořád počítá
const bare = new OmniRoute({ dataDir: '.' });
bare.nodeToProvider = new Map(); // prázdná mapa
bare.baseLists = o.baseLists;
assert.strictEqual(bare.providerOf('nvidia'), 'nvidia', 'nativní jméno z NATIVE');
assert.strictEqual(bare.providerOf('opencode-zen'), 'opencode', 'OmniRoute jméno nativního → id Zdarmy');
assert.strictEqual(bare.providerOf('huggingface'), 'huggingface');
assert.strictEqual(bare.providerOf('openai-compatible-chat-neznamy'), null, 'cizí uzel zůstává nespárovaný');
const dBare = bare.deadFrom([
  { timestamp: iso(60e3), provider: 'nvidia', model: 'kimi-k3.1-pro', status: 404 },
  { timestamp: iso(50e3), provider: 'huggingface', model: 'kimi', status: 402 },
], now);
assert.ok(dBare.deadModels.has('nvidia/kimi-k3.1-pro'), 'nvidia 404 se počítá i bez mapy uzlů');
assert.ok(dBare.deadProviders.has('huggingface'), 'huggingface 402 se počítá i bez mapy uzlů');

// paměť 24 h: API vrátí jen posledních 500 volání; když řádky DeepSeeku vypadnou, pořád je venku
(async () => {
  const o2 = new OmniRoute({ dataDir: '.' });
  o2.nodeToProvider = o.nodeToProvider; o2.baseLists = o.baseLists;
  let rows = [hang(9 * H, 499, 45000), hang(8 * H, 499, 45000), hang(7 * H, 499, 45000), hang(6 * H, 499, 45000)].map((r, i) => ({ ...r, id: 'h' + i }));
  o2.api = async () => rows;
  await o2.speedStats(now);
  assert.ok(o2.deadModels.has('nvidia/deepseek'));
  rows = [{ id: 'x1', timestamp: iso(60e3), provider: 'n-kilo', model: 'nemotron', status: 200, duration: 3000 }];
  await o2.speedStats(now);
  assert.ok(o2.deadModels.has('nvidia/deepseek'), 'still out after its rows left the API window');

  // stabilita „pomalý“: jeden 45s úspěch z dvou nepřehodí model (dřív ano, glm-4.7-flash bliklo každé 2 min);
  // ≥3 úspěchy s mediánem nad SLOW_MS ano. Dotaz jde bez excludeTests (ten OmniRoute vrací prázdný) a testovací řádky se vyřadí.
  const o3 = new OmniRoute({ dataDir: '.' });
  o3.nodeToProvider = new Map([['n-nv', 'nvidia']]);
  o3.baseLists = new Map([['zdarma-max', [{ ref: 'z-nvidia/glm', provider: 'nvidia', id: 'glm' }]]]);
  const ok = (ago, ms) => ({ id: 'ok' + ago + ms, timestamp: iso(ago), provider: 'n-nv', model: 'glm', status: 200, duration: ms });
  const test = { id: 'tst', timestamp: iso(5e3), path: '/api/providers/test', provider: 'n-nv', model: 'connection-test', status: 200, duration: 90000 };
  let apiRows = [ok(60e3, 45000), test];
  const calls = [];
  o3.api = async (m, p) => { calls.push(p); return apiRows; };
  let slowNow = await o3.speedStats(now);
  assert.ok(calls[0] === '/api/usage/call-logs?limit=2000', calls[0]); // první dotaz po startu sahá hlouběji, další 500
  assert.strictEqual(slowNow.size, 0, 'jeden pomalý úspěch → ne');
  assert.strictEqual(o3.speedDiag.skipped && Object.keys(o3.speedDiag.skipped).length, 0);
  apiRows = [ok(60e3, 45000), ok(50e3, 150000), ok(40e3, 50000)]; // 3 úspěchy, medián 50 s
  slowNow = await o3.speedStats(now);
  assert.ok(slowNow.has('nvidia/glm'), 'tři úspěchy s mediánem 50 s → pomalý');
  // OmniRoute vrátí jen nové řádky: starší úspěchy zůstanou v callHist (2 h okno), takže se stav nepřepne
  apiRows = [];
  slowNow = await o3.speedStats(now);
  assert.ok(slowNow.has('nvidia/glm'), 'vypadlé řádky z API nepřepnou stav');
  // nespárovaný poskytovatel → počítá se do diagnostiky, nic se nevynechá potichu
  o3.nodeToProvider = new Map();
  o3.baseLists = new Map();
  apiRows = [{ id: 'u1', timestamp: iso(30e3), provider: 'openai-compatible-chat-zz', model: 'x', status: 404 }];
  await o3.speedStats(now);
  assert.strictEqual(o3.speedDiag.skipped['openai-compatible-chat-zz'], 1);
  assert.strictEqual(o3.speedDiag.skipped['n-nv'], 3, 'řádky z callHist bez mapy se počítají také');
  console.log('omni-dead OK');
})().catch((e) => { console.error(e); process.exitCode = 1; });
// 402 (bez kreditu) platí 3 dny, 404 jen 6 h
{
  const H = 3600e3;
  const d402 = o.deadFrom([{ timestamp: iso(30 * H), provider: 'n-hf', model: 'kimi', status: 402 }], now);
  assert.ok(d402.deadProviders.has('huggingface'), '402 před 30 h pořád mrtvý (kredit se sám neobnoví)');
  const d404 = o.deadFrom([{ timestamp: iso(8 * H), provider: 'n-nv', model: 'kimi-k3.1-pro', status: 404 }], now);
  assert.strictEqual(d404.deadModels.size, 0, '404 před 8 h se zkusí znovu');
}
// nový klíč (dobitý kredit): dřívější 402 poskytovatele už neplatí
{
  const H = 3600e3;
  o.keyChangedAt = new Map([['huggingface', now - 2 * H]]);
  const dk = o.deadFrom([{ timestamp: iso(30 * H), provider: 'n-hf', model: 'kimi', status: 402 }], now);
  assert.ok(!dk.deadProviders.has('huggingface'), '402 starší než změna klíče neplatí');
  const dk2 = o.deadFrom([{ timestamp: iso(1 * H), provider: 'n-hf', model: 'kimi', status: 402 }], now);
  assert.ok(dk2.deadProviders.has('huggingface'), '402 po změně klíče platí');
  o.keyChangedAt = new Map();
}
