// Ověřené modely z měření (src/evidence.js): klíče, co se počítá, vypršení, pořadí, soubor v repu.
'use strict';
const assert = require('assert');
const E = require('../src/evidence');

assert.strictEqual(E.modelKey('z-kilo/nvidia/nemotron-3-ultra-550b-a55b:free'), 'nemotron-3-ultra-550b-a55b');
assert.strictEqual(E.modelKey('nvidia/nemotron-3-ultra-550b-a55b'), 'nemotron-3-ultra-550b-a55b');
assert.strictEqual(E.modelKey('reflection/beam-free'), 'beam-free');

// bench-e2e: jeden model; chyba protokolu po ≤ 2 krocích se nepočítá (nic neříká o modelu)
assert.deepStrictEqual(E.recordsFrom({ model: 'gemini-3-flash-preview', fixture: 'feature', at: '2026-11-22T00:00:00Z', steps: 2, errors: ['400 Function call is missing'], success: false }), []);
assert.strictEqual(E.recordsFrom({ model: 'glm-4.5-flash', fixture: 'feature', at: '2026-11-22T00:00:00Z', steps: 20, errors: [], success: false })[0].ok, false);
// bench-czek: výsledek nese model, který vyhrál většinu kroků; profil bez klíčů se nepočítá
// neúspěch kvůli limitu se nepočítá (týdenní přeměření na sdílených kvótách), skutečný neúspěch ano
assert.deepStrictEqual(E.recordsFrom({ model: 'x/fast', fixture: 'bugfix', at: '2026-11-22T00:00:00Z', steps: 9, success: false, errors: ['{"name":"APIError","data":{"message":"Provider returned error","statusCode":429}}'] }), []);
assert.deepStrictEqual(E.recordsFrom({ fixture: 'feature', at: '2026-11-22T00:00:00Z', steps: 9, success: false, timedOut: true, errors: [], raceFailures: ['závod: a vypadl (HTTP 429 All credentials for model a are cooling down)'], raceWinners: { 'z-kilo/a': 9 } }), []);
assert.strictEqual(E.recordsFrom({ model: 'x/weak', fixture: 'bugfix', at: '2026-11-22T00:00:00Z', steps: 30, success: false, errors: [] })[0].ok, false, 'a real failure still counts');
const czek = { fixture: 'project', at: '2026-11-22T13:54:11Z', success: true, wallS: 110, steps: 9, raceWinners: { 'z-kilo/nvidia/nemotron-3-ultra-550b-a55b:free': 8, 'openrouter/particle-ai/particle-1:free': 1 } };
assert.deepStrictEqual(E.recordsFrom(czek).map((r) => r.key), ['nemotron-3-ultra-550b-a55b']);
assert.deepStrictEqual(E.recordsFrom({ ...czek, noKeys: true }), []);

const now = Date.parse('2026-11-22T15:00:00Z');
const day = (d) => new Date(now - d * 86400000).toISOString();
const models = E.summarize([
  { key: 'wide', ok: true, wallS: 120, fixture: 'feature', at: day(1) },
  { key: 'wide', ok: true, wallS: 100, fixture: 'bugfix', at: day(2) },
  { key: 'wide', ok: true, wallS: 100, fixture: 'bugfix', at: day(2) }, // duplicitní záznam → jednou
  { key: 'fast', ok: true, wallS: 40, fixture: 'feature', at: day(1) },
  { key: 'stale', ok: true, wallS: 30, fixture: 'feature', at: day(60) }, // vypršelo
  { key: 'flaky', ok: true, wallS: 50, fixture: 'feature', at: day(3) },
  { key: 'flaky', ok: false, wallS: 600, fixture: 'feature', at: day(2) },
  { key: 'flaky', ok: false, wallS: 600, fixture: 'feature', at: day(1) }, // úspěšnost 1/3 < 0,5
  { key: 'bad', ok: false, wallS: 600, fixture: 'feature', at: day(1) },
]);
assert.strictEqual(models.wide.length, 2, 'duplicate record counted once');
const p = E.proven(models, now);
assert.deepStrictEqual(Object.keys(p), ['wide', 'fast'], 'breadth of evidence before speed; stale, flaky, bad out');
assert.strictEqual(p.wide.medianS, 100);
const m = E.matcher(models, now);
assert.ok(m.test('openrouter/x/fast:free some name'));
assert.ok(!m.test('stale'));
assert.strictEqual(m.rank('nvidia/wide'), 0);
assert.strictEqual(m.rank('unknown'), Infinity);

// šíře nejvýš 3 úlohy: rychlý model ověřený na 3 úlohách předběhne pomalejší na 4
const broad = E.proven(E.summarize([
  ...['a', 'b', 'c', 'd'].map((f) => ({ key: 'slow4', ok: true, wallS: 120, fixture: f, at: day(1) })),
  ...['a', 'b', 'c'].map((f) => ({ key: 'fast3', ok: true, wallS: 50, fixture: f, at: day(1) })),
  ...['a', 'b'].map((f) => ({ key: 'fast2', ok: true, wallS: 10, fixture: f, at: day(1) })),
]), now);
assert.deepStrictEqual(Object.keys(broad), ['fast3', 'slow4', 'fast2']);

// jeden neúspěch rychlý model jen mírně odsune: 7/8 za 55 s (→ 63 s) před 16/16 za 115 s
const rate = E.proven(E.summarize([
  ...['a', 'b', 'c'].map((f) => ({ key: 'reliable-slow', ok: true, wallS: 115, fixture: f, at: day(1) })),
  ...['a', 'b', 'c', 'a', 'b', 'c', 'a'].map((f, i) => ({ key: 'fast-once-failed', ok: true, wallS: 55, fixture: f, at: day(1 + i / 100) })),
  { key: 'fast-once-failed', ok: false, wallS: 115, fixture: 'a', at: day(2) },
]), now);
assert.deepStrictEqual(Object.keys(rate), ['fast-once-failed', 'reliable-slow']);

// soubor v repu: platný a Nemotron 3 Ultra je ověřený (běhy z 22. 11.)
const repo = E.load();
assert.ok(Object.keys(repo).length >= 5, 'src/model-evidence.json loaded');
assert.ok(E.matcher(repo, now).test('nvidia/nemotron-3-ultra-550b-a55b'), 'Nemotron proven by measurements');
assert.ok(!E.matcher(repo, now).test('gemini-3.8-flash'), 'unmeasured model is not proven (the old regex let it in)');
console.log(`evidence OK (${Object.keys(E.proven(repo)).length} ověřených modelů v src/model-evidence.json)`);
