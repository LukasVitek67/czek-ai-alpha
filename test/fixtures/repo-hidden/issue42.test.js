'use strict';
// Skryté testy issue #42 (agent je nevidí, přidají se až při vyhodnocení).
const test = require('node:test');
const assert = require('node:assert');
const { sample, cli, ISBN } = require('./helpers');

const late = (lib, member, isbn, from, back) => { const l = lib.loans.borrow(member, isbn, from); return lib.loans.giveBack(l.id, back); };

test('weekends and holidays are not counted', () => {
  assert.strictEqual(late(sample(), 'jn', ISBN.rur, '2026-01-02', '2026-01-19').fine, 2); // termín pá 16. 1. → po 19. 1.
  assert.strictEqual(late(sample(), 'jn', ISBN.rur, '2026-10-13', '2026-10-29').fine, 2); // 28. 10. svátek
});
test('fine is capped at 100 Kč per loan', () => {
  assert.strictEqual(late(sample(), 'jn', ISBN.rur, '2026-02-02', '2026-05-29').fine, 100);
});
test('outstanding lists unpaid fines sorted by return date, pay marks them paid', () => {
  const lib = sample();
  late(lib, 'jn', ISBN.saturnin, '2026-01-05', '2026-01-23'); // 4 dny = 8 Kč, vráceno 23. 1.
  late(lib, 'jn', ISBN.babicka, '2026-01-05', '2026-01-22'); // 6 Kč, vráceno 22. 1.
  late(lib, 'ak', ISBN.rur, '2026-01-05', '2026-01-22');
  const o = lib.fines.outstanding('jn');
  assert.deepStrictEqual(o.items.map((x) => [x.title, x.fine]), [['Babička', 6], ['Saturnin', 8]]);
  assert.strictEqual(o.total, 14);
  assert.strictEqual(lib.fines.pay('jn'), 14);
  assert.ok(lib.store.data.loans.filter((l) => l.memberId === 'jn').every((l) => l.finePaid === true));
  assert.strictEqual(lib.fines.outstanding('jn').total, 0);
  assert.strictEqual(lib.fines.outstanding('ak').total, 6, 'other members unaffected');
});
test('debt of exactly 50 Kč still allows borrowing, more blocks it', () => {
  const lib = sample();
  late(lib, 'jn', ISBN.babicka, '2026-03-02', '2026-04-22'); // 25 pracovních dní = 50 Kč
  assert.ok(lib.loans.borrow('jn', ISBN.saturnin, '2026-04-23'));
  late(lib, 'jn', ISBN.rur, '2026-01-02', '2026-01-19'); // + 2 Kč
  assert.throws(() => lib.loans.borrow('jn', ISBN.mloci, '2026-04-24'), /^Error: čtenář jn dluží 52 Kč – nejdřív zaplatit$/);
  assert.deepStrictEqual(cli(lib, ['borrow', 'jn', ISBN.mloci]), { code: 1, out: 'čtenář jn dluží 52 Kč – nejdřív zaplatit' });
  lib.fines.pay('jn');
  assert.ok(lib.loans.borrow('jn', ISBN.mloci, '2026-04-24'), 'after paying the member can borrow again');
});
test('unknown member in fines and pay', () => {
  const lib = sample();
  assert.deepStrictEqual(cli(lib, ['fines', 'xx']), { code: 1, out: 'neznámý čtenář xx' });
  assert.deepStrictEqual(cli(lib, ['pay', 'xx']), { code: 1, out: 'neznámý čtenář xx' });
});
test('search ignores diacritics and case in both directions', () => {
  const lib = sample();
  assert.deepStrictEqual(lib.catalog.findBooks('capek').map((b) => b.title), ['R.U.R.', 'Válka s mloky']);
  assert.deepStrictEqual(lib.catalog.findBooks('ČAPEK').map((b) => b.title), ['R.U.R.', 'Válka s mloky']);
  assert.deepStrictEqual(cli(lib, ['search', 'babicka']), { code: 0, out: 'Babička – Božena Němcová (1/1 volných)' });
});
