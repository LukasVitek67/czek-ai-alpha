'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sample, cli, ISBN } = require('./helpers');

test('add-member and add-book', () => {
  const lib = sample();
  assert.deepStrictEqual(cli(lib, ['add-member', 'pd', 'Petr', 'Dvořák']), { code: 0, out: 'přidán čtenář Petr Dvořák (pd)' });
  assert.deepStrictEqual(cli(lib, ['add-book', '9788020512345', 'Krakatit', 'Karel Čapek', '3']), { code: 0, out: 'přidána kniha Krakatit (9788020512345)' });
});
test('search shows free copies', () => {
  const lib = sample();
  cli(lib, ['borrow', 'jn', ISBN.mloci]);
  assert.deepStrictEqual(cli(lib, ['search', 'mloky']), { code: 0, out: 'Válka s mloky – Karel Čapek (1/2 volných)' });
  assert.deepStrictEqual(cli(lib, ['search', 'xyz']), { code: 0, out: 'nic nenalezeno' });
});
test('borrow and return through the CLI', () => {
  const lib = sample();
  const b = cli(lib, ['borrow', 'jn', ISBN.babicka]);
  assert.strictEqual(b.code, 0);
  const id = /půjčeno (\S+),/.exec(b.out)[1];
  assert.match(b.out, /vrátit do 2026-01-19/);
  assert.deepStrictEqual(cli(lib, ['return', id, '2026-01-12']), { code: 0, out: `vráceno ${id}` });
});
test('overdue report', () => {
  const lib = sample();
  cli(lib, ['borrow', 'ak', ISBN.saturnin]);
  assert.deepStrictEqual(cli(lib, ['overdue', '2026-01-25']), { code: 0, out: 'ak: Saturnin (termín 2026-01-19)' });
});
test('errors: code 1 with a Czech message, wrong usage code 2', () => {
  const lib = sample();
  assert.deepStrictEqual(cli(lib, ['borrow', 'xx', ISBN.rur]), { code: 1, out: 'neznámý čtenář xx' });
  assert.strictEqual(cli(lib, ['nic']).code, 2);
  assert.strictEqual(cli(lib, ['borrow', 'jn']).code, 2);
});
test('file store persists', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { createLibrary } = require('../src');
  const { createFileStore } = require('../src/storage/fileStore');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'knihovna-')), 'data.json');
  const a = createLibrary(createFileStore(file));
  a.members.addMember({ id: 'jn', name: 'Jan' });
  const b = createLibrary(createFileStore(file));
  assert.strictEqual(b.members.getMember('jn').name, 'Jan');
});
