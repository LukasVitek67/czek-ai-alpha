'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const { studentReport, csv } = require('../src/report');

function sample() {
  const s = createStore();
  s.addStudent('jn', 'Jan Novák');
  s.addStudent('ak', 'Anna "Andy" Kovářová, ml.');
  s.addGrade({ student: 'jn', subject: 'matematika', value: 1, weight: 2 });
  s.addGrade({ student: 'jn', subject: 'matematika', value: 4 });
  s.addGrade({ student: 'jn', subject: 'čeština', value: 'N' });
  s.addGrade({ student: 'ak', subject: 'angličtina', value: 2, weight: 3 });
  return s;
}

test('report lines per subject with final grade', () => {
  assert.deepStrictEqual(studentReport(sample(), 'jn'), [
    'Žák: Jan Novák (jn)',
    'čeština: nehodnocen',
    'matematika: 2.00 → 2',
    'Celkem: 2.00',
  ]);
});
test('report of a student without grades', () => {
  const s = sample();
  s.addStudent('pd', 'Petr Dvořák');
  assert.deepStrictEqual(studentReport(s, 'pd'), ['Žák: Petr Dvořák (pd)', 'Celkem: nehodnocen']);
});
test('report of unknown student throws', () => {
  assert.throws(() => studentReport(sample(), 'xx'), /unknown student xx/);
});
test('csv header and sorting', () => {
  const lines = csv(sample()).trimEnd().split('\n');
  assert.strictEqual(lines[0], 'student,name,subject,value,weight');
  assert.deepStrictEqual(lines.slice(1).map((l) => l.split(',')[0]), ['ak', 'jn', 'jn', 'jn']);
});
test('csv escapes quotes and commas', () => {
  const lines = csv(sample()).split('\n');
  assert.strictEqual(lines[1], 'ak,"Anna ""Andy"" Kovářová, ml.",angličtina,2,3');
});
test('csv keeps N and default weight, ends with newline', () => {
  const out = csv(sample());
  assert.ok(out.endsWith('\n'));
  assert.ok(out.includes('jn,Jan Novák,čeština,N,1\n'));
  assert.ok(out.includes('jn,Jan Novák,matematika,4,1\n'));
});
