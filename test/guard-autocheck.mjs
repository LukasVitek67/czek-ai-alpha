// Kontrola po editu v plném formátu rustc (0.15.21): z výstupu cargo check vybere hlášky chyb (kód, ukázka, note,
// help), modelu pošle seznam + plné hlášky prvních chyb; stejné chyby po 4 kontrolách za sebou = poznámka „změň
// přístup“. Živě 20. 11.: 3× E0283 a 83 editů main.rs, model viděl jen jednořádkový tvar bez řádku help.
import assert from 'node:assert';
import path from 'node:path';
import { blocks, parse, report, stuckNote } from '../src/guard/autocheck.mjs';

// skutečný výstup `cargo check --color never` (cargo 1.97, Windows), zkrácené cesty
const OUT = [
  '    Checking e0283 v0.1.0 (C:\\p\\e0283)',
  'warning: unused variable: `unused`',
  ' --> src\\main.rs:3:9',
  '  |',
  '3 |     let unused = 5;',
  '  |         ^^^^^^ help: if this is intentional, prefix it with an underscore: `_unused`',
  '  |',
  '  = note: `#[warn(unused_variables)]` (part of `#[warn(unused)]`) on by default',
  '',
  'error[E0283]: type annotations needed',
  ' --> src\\main.rs:4:9',
  '  |',
  '4 |     let x = "abc".into();',
  '  |         ^         ---- type must be known at this point',
  '  |',
  '  = note: the type must implement `From<&str>`',
  '  = note: required for `&str` to implement `Into<_>`',
  'help: consider giving `x` an explicit type',
  '  |',
  '4 |     let x: /* Type */ = "abc".into();',
  '  |          ++++++++++++',
  '',
  'error[E0308]: mismatched types',
  ' --> src\\main.rs:5:18',
  '  |',
  '5 |     let y: u32 = "x";',
  '  |            ---   ^^^ expected `u32`, found `&str`',
  '  |            |',
  '  |            expected due to this',
  '',
  'Some errors have detailed explanations: E0283, E0308.',
  'For more information about an error, try `rustc --explain E0283`.',
  'warning: `e0283` (bin "e0283") generated 1 warning',
  'error: could not compile `e0283` (bin "e0283") due to 2 previous errors; 1 warning emitted',
].join('\r\n');

const bl = blocks(OUT);
assert.deepStrictEqual(bl.map((b) => b.kind), ['warning', 'error', 'error'], 'souhrnné řádky cargo nejsou hlášky');
assert.deepStrictEqual(parse('cargo', OUT), {
  errors: ['src\\main.rs:4:9: error[E0283]: type annotations needed', 'src\\main.rs:5:18: error[E0308]: mismatched types'],
  warnings: 1,
}, 'tvar jako --message-format=short');
assert.ok(!bl[2].text.includes('For more information'), 'obecné řádky na konci nepatří k poslední hlášce');

const c = { root: 'C:\\p\\e0283', kind: 'cargo', label: 'cargo check' };
let rep = report(c, { out: OUT, code: 101 });
assert.match(rep, /2 errors remain:\nsrc\\main\.rs:4:9: error\[E0283\]/);
assert.match(rep, /Full compiler messages \(the note\/help lines/);
assert.match(rep, /help: consider giving `x` an explicit type/, 'řádek help jde modelu');
assert.match(rep, /let x: \/\* Type \*\/ = "abc"\.into\(\);/, 'navržená oprava jde modelu');
assert.match(rep, /expected `u32`, found `&str`/);
assert.ok(!/unused variable/.test(rep), 'varování v plných hláškách ne');

// mnoho chyb → jen seznam (žádné plné hlášky)
const many = Array.from({ length: 12 }, (_, i) => `error[E0425]: cannot find value \`v${i}\` in this scope\n --> src\\main.rs:${i + 10}:5\n  |\n${i + 10} |     v${i};\n  |     ^^ not found in this scope\n`).join('\n');
rep = report(c, { out: many, code: 101 });
assert.match(rep, /12 errors remain/);
assert.ok(!/Full compiler message/.test(rep), 'u 12 chyb jen seznam');

// dlouhé hlášky: nejvýš 3 a ~90 řádků
const long = Array.from({ length: 5 }, (_, i) => `error[E0599]: no method named \`m${i}\`\n --> src\\a.rs:${i + 1}:1\n${Array.from({ length: 40 }, () => '  |').join('\n')}\n`).join('\n');
rep = report(c, { out: long, code: 101 });
assert.match(rep, /Full compiler messages for the first 2 /, '2 × 42 řádků se vejde, třetí už ne');

// starý krátký formát (--message-format=short) dál funguje
assert.deepStrictEqual(parse('cargo', 'src\\main.rs:5:18: error[E0308]: mismatched types\nerror: could not compile `x`').errors, ['src\\main.rs:5:18: error[E0308]: mismatched types']);

// stejné chyby (jiné řádky – edity je posouvají) 4× za sebou → poznámka; změna nebo oprava → od nuly
const root = path.join('C:\\', 'proj-stuck');
const e1 = ['src\\main.rs:629:126: error[E0283]: type annotations needed', 'src\\main.rs:791:111: error[E0283]: type annotations needed'];
const e2 = ['src\\main.rs:630:103: error[E0283]: type annotations needed', 'src\\main.rs:792:126: error[E0283]: type annotations needed'];
assert.strictEqual(stuckNote(root, e1), '');
assert.strictEqual(stuckNote(root, e2), '');
assert.strictEqual(stuckNote(root, e1), '');
const note = stuckNote(root, e2);
assert.match(note, /same 2 errors have survived your last 4 edits/);
assert.match(note, /registry/);
assert.match(stuckNote(root, e1), /last 5 edits/);
assert.strictEqual(stuckNote(root, e1.slice(0, 1)), '', 'jiná sada chyb → od nuly');
assert.strictEqual(stuckNote(root, []), '', 'bez chyb nic');
assert.strictEqual(stuckNote(root, e1.slice(0, 1)), '', 'po opravě znovu od nuly');

console.log('guard-autocheck OK (plné hlášky rustc s help pro první chyby, u 12 chyb jen seznam, poznámka po 4 stejných kontrolách)');
