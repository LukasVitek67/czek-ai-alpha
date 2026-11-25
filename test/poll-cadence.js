// Kadence pollingu okna OpenCode (src/pollCadence.js): jak často se ptát na oc:active / oc:limits a kdy vůbec ne.
// Nález sebe-auditu 23. 11.: oc:active 22 417 + oc:limits 6 426 opakovaných volání za 6 dní.
'use strict';
const assert = require('assert');
const { activeCadence, limitsCadence, ACTIVE_MS, IDLE_MS, HIDDEN_MS, LIMITS_MS } = require('../src/pollCadence');

// oc:active – viditelné okno
assert.deepStrictEqual(activeCadence(false, true), { poll: true, delay: ACTIVE_MS }, 'model volá → rychlý odpočet');
assert.deepStrictEqual(activeCadence(false, false), { poll: true, delay: IDLE_MS }, 'nic se neděje → 2,5 s');
// oc:active – skryté okno se neptá
assert.deepStrictEqual(activeCadence(true, true), { poll: false, delay: HIDDEN_MS }, 'skryté okno: neptat se ani když běží');
assert.deepStrictEqual(activeCadence(true, false), { poll: false, delay: HIDDEN_MS }, 'skryté okno: neptat se');
// oc:limits – 8 s, skryté neptat
assert.deepStrictEqual(limitsCadence(false), { poll: true, delay: LIMITS_MS }, 'limity 8 s');
assert.deepStrictEqual(limitsCadence(true), { poll: false, delay: LIMITS_MS }, 'skryté okno: limity neptat');

// rozumné hodnoty: rychlý < pomalý < limity; limity dřív 3 s → teď 8 s
assert.ok(ACTIVE_MS < IDLE_MS && IDLE_MS < LIMITS_MS, 'odstupňované');
assert.strictEqual(LIMITS_MS, 8000, 'limity 8 s');

// preloady běží v sandboxu: require jen 'electron' (25. 11.: require('./pollCadence') v ocPreload.js → preload nefungoval)
const fs = require('fs'); const path = require('path');
for (const f of fs.readdirSync(path.join(__dirname, '../src')).filter((f) => /[pP]reload\.js$/.test(f))) {
  const src = fs.readFileSync(path.join(__dirname, '../src', f), 'utf8');
  const bad = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).filter((m) => m !== 'electron');
  assert.deepStrictEqual(bad, [], `${f}: sandboxed preload may only require electron`);
}
// kopie v ocPreload.js = stejná čísla jako src/pollCadence.js
const oc = fs.readFileSync(path.join(__dirname, '../src/ocPreload.js'), 'utf8');
for (const [k, v] of Object.entries({ ACTIVE_MS, IDLE_MS, HIDDEN_MS, LIMITS_MS })) assert.ok(new RegExp(`${k} = ${v}\\b`).test(oc), `ocPreload ${k} = ${v}`);

// odhad: limity 3 s → 8 s = ~62 % méně dotazů; skryté okno = 0 dotazů obou kanálů
const before = 3600 / 3, after = 3600 / (LIMITS_MS / 1000);
console.log(`poll-cadence OK (limity: ${before}/h → ${after.toFixed(0)}/h = -${Math.round((1 - after / before) * 100)} %; skryté okno = 0 dotazů)`);
