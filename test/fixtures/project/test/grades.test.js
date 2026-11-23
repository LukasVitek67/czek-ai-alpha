'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { weightedAverage, finalGrade, bySubject } = require('../src/grades');

test('weighted average uses weights', () => {
  assert.strictEqual(weightedAverage([{ value: 1, weight: 3 }, { value: 4, weight: 1 }]), 1.75);
});
test('weight defaults to 1', () => {
  assert.strictEqual(weightedAverage([{ value: 2 }, { value: 3 }]), 2.5);
});
test('N (absent) is ignored', () => {
  assert.strictEqual(weightedAverage([{ value: 'N', weight: 10 }, { value: 2, weight: 1 }]), 2);
});
test('no valid grade gives null', () => {
  assert.strictEqual(weightedAverage([]), null);
  assert.strictEqual(weightedAverage([{ value: 'N' }]), null);
});
test('rounded to two decimals', () => {
  assert.strictEqual(weightedAverage([{ value: 1 }, { value: 1 }, { value: 2 }]), 1.33);
});
test('invalid weight throws RangeError', () => {
  assert.throws(() => weightedAverage([{ value: 1, weight: 0 }]), RangeError);
  assert.throws(() => weightedAverage([{ value: 1, weight: 11 }]), RangeError);
});
test('final grade boundaries', () => {
  assert.deepStrictEqual([1.5, 1.51, 2.5, 3.5, 3.51, 4.5, 4.51].map(finalGrade), [1, 2, 2, 3, 4, 4, 5]);
  assert.strictEqual(finalGrade(null), null);
});
test('averages by subject, sorted the Czech way', () => {
  const g = [
    { subject: 'matematika', value: 1 }, { subject: 'čeština', value: 3, weight: 2 }, { subject: 'čeština', value: 1 },
    { subject: 'angličtina', value: 'N' },
  ];
  const r = bySubject(g);
  assert.deepStrictEqual(Object.keys(r), ['angličtina', 'čeština', 'matematika']);
  assert.deepStrictEqual(r, { angličtina: null, čeština: 2.33, matematika: 1 });
});
