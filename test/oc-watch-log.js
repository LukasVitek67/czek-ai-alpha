// Hlídač OpenCode: do logu jen přechod stavu (ok ↔ bez modelů), ne každý poll s jinou chybou.
// Sebe-audit 23. 11.: při výpadku sítě se text chyby měnil pollem po pollu → „bez modelů" zapsáno 1046×.
'use strict';
const assert = require('assert');
const { stateKey, stateText } = require('../src/ocWatch');

// stabilní klíč ignoruje text chyby
assert.strictEqual(stateKey({ ok: false, error: 'ENOTFOUND api.z.ai' }), 'bez modelů');
assert.strictEqual(stateKey({ ok: false, error: 'ENOTFOUND api.groq.com' }), 'bez modelů');
assert.strictEqual(stateKey({ ok: true, models: 194 }), 'ok 194');
assert.strictEqual(stateKey({ ok: true, models: 55 }), 'ok 55');
// text pro log si chybu nechává
assert.ok(stateText({ ok: false, error: 'ENOTFOUND api.z.ai' }).includes('api.z.ai'), 'log ukáže chybu');
assert.strictEqual(stateText({ ok: true, models: 3 }), 'ok 3');

// stejná dedup podmínka jako main.js watchInstances
function countLogs(results) {
  const last = new Map();
  let logs = 0;
  for (const r of results) {
    const key = stateKey(r);
    if (r.healed || last.get('d') !== key) { logs++; last.set('d', key); }
  }
  return logs;
}

// 1000× bez modelů, pokaždé jiná chyba (výpadek sítě) → 1 zápis (dřív 1000)
const offline = Array.from({ length: 1000 }, (_, i) => ({ ok: false, error: 'ENOTFOUND host-' + i }));
assert.strictEqual(countLogs(offline), 1, 'opakované „bez modelů" s měnící se chybou = 1 zápis');
// logují se jen přechody ok → bez modelů → ok
assert.strictEqual(countLogs([{ ok: true, models: 5 }, { ok: true, models: 5 }, { ok: false, error: 'x' }, { ok: false, error: 'y' }, { ok: true, models: 5 }]), 3, 'jen přechody');
// znovu-načtení (healed) se zaloguje i při stejném stavu
assert.strictEqual(countLogs([{ ok: false, error: 'a' }, { ok: false, error: 'a', healed: true }]), 2, 'healed se loguje vždy');

console.log('oc-watch-log OK (1000 pollů „bez modelů" s měnící se chybou → 1 zápis místo 1000; logují se jen přechody a znovu-načtení)');
