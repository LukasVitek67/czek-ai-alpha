'use strict';
// Issue #42 (docs/ISSUE-42.md): pokuty za pozdní vrácení.
const test = require('node:test');
const assert = require('node:assert');
const { sample, cli, ISBN } = require('./helpers');

test('returning 3 business days late costs 6 Kč', () => {
  const lib = sample();
  const l = lib.loans.borrow('jn', ISBN.babicka, '2026-01-05'); // termín 2026-01-19 (po)
  const r = lib.loans.giveBack(l.id, '2026-01-22'); // út, st, čt
  assert.strictEqual(r.fine, 6);
  assert.strictEqual(r.loan.id, l.id);
  assert.strictEqual(lib.store.data.loans[0].fine, 6);
});
test('returning on the due date is free', () => {
  const lib = sample();
  const l = lib.loans.borrow('jn', ISBN.babicka, '2026-01-05');
  assert.strictEqual(lib.loans.giveBack(l.id, '2026-01-19').fine, 0);
  assert.deepStrictEqual(cli(lib, ['fines', 'jn']), { code: 0, out: 'Bez dluhů' });
});
test('fines and pay commands', () => {
  const lib = sample();
  const l = lib.loans.borrow('jn', ISBN.babicka, '2026-01-05');
  assert.deepStrictEqual(cli(lib, ['return', l.id, '2026-01-22']), { code: 0, out: `vráceno ${l.id}, pokuta 6 Kč` });
  assert.deepStrictEqual(cli(lib, ['fines', 'jn']), { code: 0, out: 'Babička: 6 Kč\nCelkem: 6 Kč' });
  assert.deepStrictEqual(cli(lib, ['pay', 'jn']), { code: 0, out: 'Zaplaceno 6 Kč' });
  assert.deepStrictEqual(cli(lib, ['fines', 'jn']), { code: 0, out: 'Bez dluhů' });
});
