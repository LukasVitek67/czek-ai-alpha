// Test tierlistů: kontext modelů a tierlistu (automaticky / vlastní), zařazení podle síly.
'use strict';
// Pevná data měření (src/model-evidence.json se mění týdenním přeměřením a test by pak blokoval jeho commit – 25. 11. se to stalo).
process.env.CZEK_EVIDENCE_FILE = require('path').join(__dirname, 'fixtures', 'model-evidence-tiers.json');
const assert = require('assert');
const t = require('../src/tiers');
const { providerBlock } = require('../src/opencode');

// známý kontext: údaj poskytovatele má přednost, jinak podle rodiny, jinak null
assert.equal(t.knownContext({ id: 'x', context: 8192 }), 8192);
assert.equal(t.knownContext({ id: 'gemini-2.5-flash' }), 1048576);
assert.equal(t.knownContext({ id: 'openai-fast' }), 131072);
assert.equal(t.knownContext({ id: 'moonshotai/kimi-k2-instruct' }), 262144);
assert.equal(t.knownContext({ id: 'codestral-latest' }), 256000);
assert.equal(t.knownContext({ id: 'neznamy-model' }), null);

// kontext tierlistu = medián známých (ne minimum), meze 16k–96k (strop kvůli compaction), bez údajů 32k
const models = [
  { key: 'a', id: 'gpt-oss-120b', usable: true, context: 131072 },
  { key: 'b', id: 'small', usable: true, context: 8192 },
  { key: 'c', id: 'gemini-2.5-pro', usable: true },
  { key: 'd', id: 'neznamy', usable: true },
];
assert.equal(t.tierContext(['a', 'b', 'c'], models), 96000, 'jeden malý model nestáhne celý tierlist; strop 96k');
assert.equal(t.tierContext(['e'], [{ key: 'e', id: 'x', context: 65536 }]), 65536, 'pod stropem medián beze změny');
assert.equal(t.tierContext(['d'], models), 32000);
assert.equal(t.tierContext(['b'], models), 16000, 'spodní mez');

// výchozí automaticky, vlastní hodnota z editoru přebije, neplatná = automaticky
const reg = { autoOrder: (ms) => ms.filter((m) => m.usable && m.tools !== false), isUncensored: () => false };
const s = { tiers: t.sanitize({ 'c-x': { name: 'X', models: ['a', 'b', 'c'] }, max: { context: 50000 }, high: { context: 'abc' }, mid: { context: 999 } }) };
assert.equal(s.tiers.max.context, 50000);
assert.ok(!('context' in s.tiers.high) && !('context' in s.tiers.mid), 'neplatné hodnoty se zahodí');
const ov = t.overview(models, s, reg);
const x = ov.find((o) => o.id === 'c-x');
assert.equal(x.context, 96000); assert.equal(x.contextAuto, 96000); assert.equal(x.contextOverride, null);
const max = ov.find((o) => o.id === 'max');
assert.equal(max.context, 50000, 'vlastní limit'); assert.ok(max.auto, 'vlastní limit nemění automatické modely');

// a do OpenCode se zapíše
const block = providerBlock(4545, models, { tiers: ov, onlyTiers: true });
assert.equal(block.models['c-x'].limit.context, 96000);
assert.equal(t.overview(models, { tiers: t.sanitize({ max: { context: 262144 } }) }, reg).find((o) => o.id === 'max').context, 262144, 'ruční hodnota strop nemá');
assert.equal(block.models.max.limit.context, 50000);
assert.ok(!('a' in block.models), 'jen tierlisty');

// Max s reálnými názvy z NVIDIA: změřený model (PROVEN: Nemotron 3 Ultra) vede, za ním preferované rodiny
// (Kimi K2.6, DeepSeek V4), GLM Flash patří do High. Od 22. 11. 2026 preferované rodiny nepřebijí změřené modely
// (docs/research/2026-11-22-claude-e2e: s Kimi/DeepSeek v čele závod zkoušel nefunkční modely, 320 s místo 100 s).
{
  const { ModelRegistry } = require('../src/agent');
  const settings = { favorites: [], preferFamilies: ['kimi', 'deepseek-v4', 'glm'], tiers: {} };
  const reg = new ModelRegistry(() => settings);
  const nv = ['openai/gpt-oss-120b', 'deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.6', 'nvidia/nemotron-3-ultra-550b-a55b']
    .map((id) => ({ key: `nvidia/${id}`, id, provider: 'nvidia', usable: true, tools: true }));
  const maxOrder = t.order('max', nv, settings, reg).map((m) => m.id);
  assert.equal(maxOrder[0], 'nvidia/nemotron-3-ultra-550b-a55b', maxOrder.join(','));
  assert.equal(maxOrder[1], 'moonshotai/kimi-k2.6', maxOrder.join(','));
  assert.equal(maxOrder[2], 'deepseek-ai/deepseek-v4.1-flash');
  assert.ok(!maxOrder.slice(0, 3).includes('z-ai/glm-5.3-flash'), 'GLM Flash není v Max');
  assert.equal(t.classify({ id: 'z-ai/glm-5.3-flash' }), 'high');
  // Kimi K3.1 Pro (build.nvidia.com, chybí ve veřejném /v1/models → extraModels) vede preferované rodiny před K2.6
  // (hned za změřeným Nemotronem)
  const k31 = { key: 'nvidia/moonshotai/kimi-k3.1-pro', id: 'moonshotai/kimi-k3.1-pro', provider: 'nvidia', usable: true, tools: true, context: 1048576 };
  const max2 = t.order('max', [...nv, k31], settings, reg).map((m) => m.id);
  assert.equal(max2[1], 'moonshotai/kimi-k3.1-pro', max2.join(','));
  assert.equal(max2[2], 'moonshotai/kimi-k2.6');
  // slabší starší modely, které podle usage.json nesly nejvíc práce v High, patří do Mid
  for (const id of ['Meta-Llama-3_3-70B-Instruct', 'meta/llama-3.3-70b-instruct', 'codestral-2508', 'codestral-latest', 'Qwen2.5-VL-72B-Instruct', 'meta-llama/llama-4-maverick', 'mixtral-8x22b'])
    assert.equal(t.classify({ id }), 'mid', id);
  for (const [id, tier] of [['meta/llama-3.1-405b-instruct', 'max'], ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'max'], ['z-ai/glm-5.3-flash', 'high'], ['nvidia/nemotron-3.5-super-vl', 'high'], ['gemini-3-flash-preview', 'max'], ['gemini-3.6-flash', 'max'], ['gemini-3.1-flash-lite', 'low'], ['minimaxai/minimax-m3.1-flash', 'high'], ['llama-3.1-8b-instant', 'low']])
    assert.equal(t.classify({ id }), tier, id);
  // modely nových free routerů (8. 11. 2026) a oprava „7b“ uvnitř čísla
  for (const [id, tier] of [
    ['qwen3.8-27b', 'mid'], ['Qwen3.6-27B', 'mid'], ['qwen2.5-coder-7b', 'low'], ['llama-3.1-8b-instruct', 'low'], ['gemma3-270m:free', 'low'],
    ['poolside/laguna-xs.2', 'low'], ['nvidia/nemotron-3-ultra-550b-a55b', 'max'], ['nvidia/nemotron-3-super-120b-a12b', 'high'],
    ['deepseek/deepseek-v4.1-flash-free', 'max'], ['z-ai/glm-5.3-flash-free', 'high'], ['minimax-m3.1-flash:free', 'high'], ['kimi-k2.7-code', 'max'],
    ['mistralai/devstral-medium', 'max'], ['novita/inclusionai/ling-3.0-tiny', 'low'],
  ]) assert.equal(t.classify({ id }), tier, id);
  const nvProv = require('../src/providers').PROVIDERS.find((p) => p.id === 'nvidia');
  assert.ok(nvProv.extraModels.some((m) => m.id === 'moonshotai/kimi-k3.1-pro'), 'NVIDIA nabízí Kimi K3.1 Pro');
}
console.log('tiers OK');

// změřené free modely (bugfix benchmark 8. 11.) patří do Max a mají přednost před neověřenými
{
  assert.equal(t.classify({ id: 'stealth/glyph-cluster' }), 'max');
  assert.equal(t.classify({ id: 'reflection/beam-free' }), 'max');
  const { scoreModel } = require('../src/providers');
  assert.ok(scoreModel({ id: 'stealth/glyph-cluster', tools: true }) > scoreModel({ id: 'some/unknown-model', tools: true }), 'ověřený model před neověřeným');

  // Sjednocení stejných modelů napříč poskytovateli + držení jednoho poskytovatele do vyčerpání kreditu
  const { ModelRegistry } = require('../src/agent');
  const reg2 = new ModelRegistry(() => ({ favorites: ['nvidia/moonshotai/kimi-k3.1-pro'], preferFamilies: ['kimi'] }));
  const sample = [
    { key: 'nvidia/moonshotai/kimi-k3.1-pro', id: 'moonshotai/kimi-k3.1-pro', provider: 'nvidia', providerName: 'NVIDIA', usable: true, tools: true },
    { key: 'huggingface/moonshotai/Kimi-K3', id: 'moonshotai/Kimi-K3', provider: 'huggingface', providerName: 'Hugging Face', usable: true, tools: true },
    { key: 'novita/moonshotai/kimi-k3.1-pro', id: 'moonshotai/kimi-k3.1-pro', provider: 'novita', providerName: 'Novita', usable: false, tools: true },
  ];
  const united = t.uniteModels(sample, { favorites: ['nvidia/moonshotai/kimi-k3.1-pro'] }, reg2);
  assert.equal(united.length, 1);
  assert.equal(united[0].slug, 'kimi-k3');
  assert.deepEqual(united[0].providers, ['NVIDIA', 'Hugging Face']);
  assert.deepEqual(united[0].lockedProviders.map((p) => p.id), ['novita']);
  // Drží se připnutého poskytovatele, dokud má kredit/limit; po vyčerpání přepne na dalšího se stejným modelem
  reg2.noteUnitedSuccess('huggingface/moonshotai/Kimi-K3');
  assert.equal(reg2.unitedOrder('kimi-k3', sample)[0].key, 'huggingface/moonshotai/Kimi-K3');
  reg2.cool('huggingface/moonshotai/Kimi-K3', 60000, 'vyčerpaná kvóta');
  assert.equal(reg2.unitedOrder('kimi-k3', sample)[0].key, 'nvidia/moonshotai/kimi-k3.1-pro');
  console.log('tiers proven OK');
}
