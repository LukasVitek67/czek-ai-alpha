'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sample, ISBN } = require('./helpers');

test('borrow sets the due date 14 days later', () => {
  const lib = sample();
  const l = lib.loans.borrow('jn', ISBN.babicka, '2026-01-05');
  assert.strictEqual(l.due, '2026-01-19');
  assert.strictEqual(lib.loans.active('jn').length, 1);
});
test('cannot borrow a book with no free copy, unknown member or book', () => {
  const lib = sample();
  lib.loans.borrow('jn', ISBN.babicka, '2026-01-05');
  assert.throws(() => lib.loans.borrow('ak', ISBN.babicka, '2026-01-06'), /není volná/);
  assert.throws(() => lib.loans.borrow('xx', ISBN.rur, '2026-01-06'), /neznámý čtenář xx/);
  assert.throws(() => lib.loans.borrow('ak', '9788020512345', '2026-01-06'), /neznámá kniha/);
});
test('returning marks the loan, frees the copy and cannot happen twice', () => {
  const lib = sample();
  const l = lib.loans.borrow('jn', ISBN.babicka, '2026-01-05');
  lib.loans.giveBack(l.id, '2026-01-10');
  assert.strictEqual(lib.store.data.loans[0].returned, '2026-01-10');
  assert.strictEqual(lib.catalog.available(ISBN.babicka), 1);
  assert.throws(() => lib.loans.giveBack(l.id, '2026-01-11'), /už je vrácená/);
});
test('return before borrow is rejected', () => {
  const lib = sample();
  const l = lib.loans.borrow('jn', ISBN.babicka, '2026-01-05');
  assert.throws(() => lib.loans.giveBack(l.id, '2026-01-04'), /před půjčením/);
});
test('overdue list', () => {
  const lib = sample();
  lib.loans.borrow('jn', ISBN.babicka, '2026-01-05');
  assert.strictEqual(lib.loans.overdue('2026-01-19').length, 0);
  assert.strictEqual(lib.loans.overdue('2026-01-20').length, 1);
});
