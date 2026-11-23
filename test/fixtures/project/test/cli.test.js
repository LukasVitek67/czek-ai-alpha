'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');
const { run } = require('../src/cli');

const fresh = () => { const store = createStore(); store.addStudent('jn', 'Jan Novák'); return store; };

test('add-student with a multi-word name', () => {
  const store = createStore();
  assert.deepStrictEqual(run(['add-student', 'ak', 'Anna', 'Kovářová'], { store }), { code: 0, out: 'přidán ak' });
  assert.strictEqual(store.student('ak').name, 'Anna Kovářová');
});
test('duplicate student is an error (code 1)', () => {
  const store = fresh();
  const r = run(['add-student', 'jn', 'Jiný'], { store });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /already exists/);
});
test('add-grade with and without weight', () => {
  const store = fresh();
  assert.strictEqual(run(['add-grade', 'jn', 'fyzika', '2', '5'], { store }).code, 0);
  assert.strictEqual(run(['add-grade', 'jn', 'fyzika', 'N'], { store }).code, 0);
  assert.deepStrictEqual(store.gradesOf('jn').map((g) => [g.value, g.weight]), [[2, 5], ['N', 1]]);
});
test('add-grade rejects bad grade, weight and student', () => {
  const store = fresh();
  assert.deepStrictEqual(run(['add-grade', 'jn', 'fyzika', '6'], { store }), { code: 1, out: 'neplatná známka 6' });
  assert.deepStrictEqual(run(['add-grade', 'jn', 'fyzika', '2', '0'], { store }), { code: 1, out: 'neplatná váha 0' });
  assert.deepStrictEqual(run(['add-grade', 'xx', 'fyzika', '2'], { store }), { code: 1, out: 'neznámý žák xx' });
  assert.strictEqual(store.gradesOf('jn').length, 0);
});
test('report and export', () => {
  const store = fresh();
  run(['add-grade', 'jn', 'fyzika', '1'], { store });
  assert.deepStrictEqual(run(['report', 'jn'], { store }), { code: 0, out: 'Žák: Jan Novák (jn)\nfyzika: 1.00 → 1\nCelkem: 1.00' });
  assert.strictEqual(run(['export'], { store }).out, 'student,name,subject,value,weight\njn,Jan Novák,fyzika,1,1\n');
});
test('free and conflicts', () => {
  const store = fresh();
  store.addLesson({ day: 'po', start: '08:00', end: '08:45', subject: 'M', room: '1' });
  store.addLesson({ day: 'po', start: '08:45', end: '09:30', subject: 'Č', room: '2' });
  assert.deepStrictEqual(run(['conflicts'], { store }), { code: 0, out: 'bez kolizí' });
  assert.deepStrictEqual(run(['free', 'po'], { store }), { code: 0, out: '09:30–16:00' });
  store.addLesson({ day: 'po', start: '09:00', end: '10:00', subject: 'F', room: '3' });
  assert.deepStrictEqual(run(['conflicts'], { store }), { code: 1, out: 'po Č × F' });
});
test('unknown command or missing args prints usage with code 2', () => {
  const store = fresh();
  for (const argv of [[], ['nic'], ['report'], ['add-grade', 'jn']]) {
    const r = run(argv, { store });
    assert.strictEqual(r.code, 2, JSON.stringify(argv));
    assert.match(r.out, /^použití:/);
  }
});
test('store persists to a file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'znamky-')), 'data.json');
  const a = createStore(file);
  run(['add-student', 'jn', 'Jan'], { store: a });
  run(['add-grade', 'jn', 'dějepis', '3', '2'], { store: a });
  const b = createStore(file);
  assert.deepStrictEqual(b.gradesOf('jn'), [{ student: 'jn', subject: 'dějepis', value: 3, weight: 2 }]);
});
