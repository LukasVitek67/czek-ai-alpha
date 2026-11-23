// Průvodce klíči (src/wizard.js): kroky = skuteční poskytovatelé s klíčem, texty v obou jazycích, kdy se otevře sám.
'use strict';
const assert = require('assert');
const W = require('../src/wizard');
const { PROVIDERS } = require('../src/providers');
const I18N = require('../src/i18n');

const D = I18N._dict;
const ids = W.STEPS.map((s) => s.id);
assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate steps');
for (const id of ids) {
  const p = PROVIDERS.find((x) => x.id === id);
  assert.ok(p, `${id}: provider exists`);
  assert.ok(p.needsKey, `${id}: guide only for providers that need a key`);
  assert.match(p.keyUrl, /^https:\/\//, `${id}: sign-up page`);
  for (const k of ['why', 'how']) assert.ok(D[`wiz.${id}.${k}`], `${id}: text wiz.${id}.${k}`);
  const [cs, en] = D[`wiz.${id}.how`];
  assert.strictEqual(cs.split('|').length, en.split('|').length, `${id}: same number of how-to steps in cs and en`);
}
// poskytovatelé s limitem na IP (bez klíče) v průvodci nejsou: ve škole sdílí jednu IP celá třída
for (const id of ['kilo', 'pollinations', 'ovh', 'llm7']) assert.ok(!ids.includes(id), `${id} not in the guide`);
assert.ok(W.STEPS.find((s) => s.id === 'gemini').adult, 'Gemini carries the under-18 note');

assert.strictEqual(W.needsWizard({ providers: {} }), true, 'no keys → guide opens');
assert.strictEqual(W.needsWizard({ providers: { nvidia: { key: 'k' } } }), false, 'a guide key → no auto-open');
assert.strictEqual(W.needsWizard({ providers: { groq: { key: 'k' } } }), true, 'only a key outside the guide → still opens');
assert.strictEqual(W.needsWizard({ providers: {}, wizardDone: true }), false, 'closed with Done → never again');
assert.strictEqual(W.keyed({ providers: { nvidia: { hasKey: true }, gemini: { key: 'k' }, groq: { key: 'k' } } }), 2, 'counts guide keys (masked or real)');
assert.strictEqual(W.firstOpen({ providers: { nvidia: { key: 'k' } } }), 1, 'starts at the first step without a key');
assert.strictEqual(W.firstOpen({ providers: Object.fromEntries(ids.map((i) => [i, { key: 'k' }])) }), ids.length, 'all keys → summary');
console.log(`wizard OK (${ids.length} kroků: ${ids.join(', ')})`);
