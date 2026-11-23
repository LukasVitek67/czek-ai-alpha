'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const { run } = require('../src/cli');
const { subjectStats } = require('../src/report');

function sample() {
  const store = createStore();
  store.addStudent('jn', 'Jan Novák');
  store.addStudent('ak', 'Anna Kovářová');
  run(['add-grade', 'jn', 'fyzika', '1', '2'], { store });
  run(['add-grade', 'jn', 'fyzika', '3'], { store });
  run(['add-grade', 'ak', 'fyzika', '2'], { store });
  run(['add-grade', 'ak', 'fyzika', 'N'], { store });
  run(['add-grade', 'ak', 'chemie', '5'], { store });
  return store;
}

test('subjectStats: count, average over all students, distribution', () => {
  assert.deepStrictEqual(subjectStats(sample(), 'fyzika'), {
    subject: 'fyzika', count: 3, absent: 1, average: 1.75, distribution: { 1: 1, 2: 1, 3: 1, 4: 0, 5: 0 },
  });
});
test('subjectStats of a subject without grades', () => {
  assert.deepStrictEqual(subjectStats(sample(), 'dějepis'), {
    subject: 'dějepis', count: 0, absent: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  });
});
test('cli stats prints one line summary', () => {
  assert.deepStrictEqual(run(['stats', 'fyzika'], { store: sample() }), { code: 0, out: 'fyzika: 3 známek (1× N), průměr 1.75, 1:1 2:1 3:1 4:0 5:0' });
  assert.deepStrictEqual(run(['stats', 'dějepis'], { store: sample() }), { code: 0, out: 'dějepis: 0 známek (0× N), průměr –, 1:0 2:0 3:0 4:0 5:0' });
  assert.strictEqual(run(['stats'], { store: sample() }).code, 2);
});
test('remove-grade removes the n-th grade of a student (1-based, in insertion order)', () => {
  const store = sample();
  assert.deepStrictEqual(run(['remove-grade', 'jn', '2'], { store }), { code: 0, out: 'smazána známka 3 z fyzika pro jn' });
  assert.deepStrictEqual(store.gradesOf('jn').map((g) => g.value), [1]);
  assert.deepStrictEqual(run(['remove-grade', 'jn', '5'], { store }), { code: 1, out: 'jn nemá známku č. 5' });
  assert.deepStrictEqual(run(['remove-grade', 'xx', '1'], { store }), { code: 1, out: 'neznámý žák xx' });
  assert.strictEqual(run(['remove-grade', 'jn'], { store }).code, 2);
});
test('removing a grade is saved to the file', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'znamky2-')), 'data.json');
  const a = createStore(file);
  run(['add-student', 'jn', 'Jan'], { store: a });
  run(['add-grade', 'jn', 'dějepis', '3'], { store: a });
  run(['add-grade', 'jn', 'dějepis', '1'], { store: a });
  run(['remove-grade', 'jn', '1'], { store: a });
  assert.deepStrictEqual(createStore(file).gradesOf('jn').map((g) => g.value), [1]);
});
