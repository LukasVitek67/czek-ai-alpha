'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sample, ISBN } = require('./helpers');

test('adding a book validates ISBN, title and copies', () => {
  const lib = sample();
  assert.throws(() => lib.catalog.addBook({ isbn: '9788020403224', title: 'X' }), /neplatné ISBN/);
  assert.throws(() => lib.catalog.addBook({ isbn: '978-80-7108-123-4', title: ' ' }), /název/);
  assert.throws(() => lib.catalog.addBook({ isbn: ISBN.mloci, title: 'Znovu' }), /už v katalogu/);
});
test('ISBN with dashes is normalized', () => {
  const lib = sample();
  assert.strictEqual(lib.catalog.getBook('978-80-2040-322-3').title, 'Válka s mloky');
});
test('search by title or author, case insensitive, sorted by title', () => {
  const lib = sample();
  assert.deepStrictEqual(lib.catalog.findBooks('válka').map((b) => b.title), ['Válka s mloky']);
  assert.deepStrictEqual(lib.catalog.findBooks('KAREL').map((b) => b.title), ['R.U.R.', 'Válka s mloky']);
  assert.deepStrictEqual(lib.catalog.findBooks('nic takového'), []);
});
test('available copies', () => {
  const lib = sample();
  assert.strictEqual(lib.catalog.available(ISBN.mloci), 2);
  lib.loans.borrow('jn', ISBN.mloci, '2026-01-05');
  assert.strictEqual(lib.catalog.available(ISBN.mloci), 1);
});
