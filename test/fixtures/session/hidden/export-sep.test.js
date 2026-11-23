'use strict';
// Skrytý test 3. zadání (agent ho nevidí, přidá se až při vyhodnocení).
// Kontroluje VÝZNAM CSV (rozparsuje ho), ne vedlejší volby: uvozovky kolem buňky s čárkou při oddělovači „;“ jsou
// platné CSV a Excel je přečte správně (do 23. 11. test chtěl, aby tam nebyly – trestal správný výsledek).
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const { run } = require('../src/cli');
const { csv } = require('../src/report');

/** Minimální parser CSV (RFC 4180: uvozovky, zdvojené uvozovky, oddělovač uvnitř uvozovek). */
function parse(text, sep) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function sample() {
  const store = createStore();
  store.addStudent('jn', 'Novák; Jan');
  store.addStudent('ak', 'Anna, ml.');
  run(['add-grade', 'jn', 'fyzika', '1', '2'], { store });
  run(['add-grade', 'ak', 'chemie', '2'], { store });
  return store;
}
const ROWS = [['student', 'name', 'subject', 'value', 'weight'], ['ak', 'Anna, ml.', 'chemie', '2', '1'], ['jn', 'Novák; Jan', 'fyzika', '1', '2']];

test('csv with a semicolon separator', () => {
  const out = csv(sample(), ';');
  assert.ok(out.startsWith('student;name;subject;value;weight\n'), 'header separated by semicolons');
  assert.ok(out.endsWith('\n'), 'ends with a newline');
  assert.ok(out.includes('"Novák; Jan"'), 'a cell containing the separator is quoted');
  assert.deepStrictEqual(parse(out, ';'), ROWS);
});
test('csv default separator unchanged', () => {
  const out = csv(sample());
  assert.ok(out.startsWith('student,name,subject,value,weight\n'));
  assert.ok(out.includes('"Anna, ml."'), 'a cell containing a comma is quoted');
  assert.deepStrictEqual(parse(out, ','), ROWS);
});
test('cli export with a separator argument', () => {
  assert.strictEqual(run(['export', ';'], { store: sample() }).out, csv(sample(), ';'));
  assert.strictEqual(run(['export'], { store: sample() }).out, csv(sample()));
  assert.strictEqual(run(['export', '|'], { store: sample() }).code, 2);
});
