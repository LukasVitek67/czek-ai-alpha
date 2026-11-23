// Překlady: každý klíč má češtinu i angličtinu se stejnými {proměnnými} a každý klíč použitý v kódu existuje.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const I18N = require('../src/i18n');

const D = I18N._dict;
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const [k, v] of Object.entries(D)) {
  assert.ok(Array.isArray(v) && v.length === 2 && v[0] && v[1], `${k}: chybí cs nebo en`);
  assert.strictEqual(vars(v[0]), vars(v[1]), `${k}: jiné proměnné v cs a en`);
}

const src = path.join(__dirname, '..', 'src');
const files = ['main.js', 'race.js', 'ocPreload.js', 'renderer/splash.js', 'renderer/app.js', 'renderer/picker.js', 'renderer/skills.js', 'renderer/monitor.js', 'renderer/index.html', 'renderer/picker.html', 'renderer/skills.html', 'renderer/monitor.html'];
const used = new Set();
for (const f of files) {
  const s = fs.readFileSync(path.join(src, f), 'utf8');
  for (const m of s.matchAll(/\b(?:t|T|I18N\.t)\('([a-zA-Z0-9.]+)'/g)) used.add(m[1]);
  for (const m of s.matchAll(/data-i18n(?:-html|-ph|-title)?="([a-zA-Z0-9.]+)"/g)) used.add(m[1]);
}
const missing = [...used].filter((k) => !D[k]);
assert.deepStrictEqual(missing, [], 'klíče použité v kódu, ale chybí ve slovníku');

// okno Monitor skládá klíče z hodnot (tx('mon.a.', kód)): každý kód upozornění ze src/monitor.js, stavy a součásti
const monSrc = fs.readFileSync(path.join(src, 'monitor.js'), 'utf8');
const dyn = [
  ...[...monSrc.matchAll(/add\('(?:error|warn|info)', '([a-zA-Z_]+)',/g)].map((m) => 'mon.a.' + m[1]),
  ...['retryabort', 'block'].map((k) => 'mon.a.guard_' + k), // add('warn', 'guard_' + …)
  ...[...monSrc.matchAll(/id: '([a-z]+)', ok:/g)].map((m) => 'mon.c.' + m[1]),
  ...[...monSrc.matchAll(/st\.push\('([a-z]+)'\)/g)].map((m) => 'mon.ms.' + m[1]), 'mon.ms.ok',
  ...['ok', 'down', 'off', 'starting', 'warn', 'unknown'].map((k) => 'mon.st.' + k),
  ...['error', 'warn', 'info'].map((k) => 'mon.lvl.' + k), ...['busy', 'idle', 'retry'].map((k) => 'mon.ss.' + k),
];
assert.ok(dyn.length > 30, 'kódy z monitoru se načetly: ' + dyn.length);
assert.deepStrictEqual(dyn.filter((k) => !D[k]), [], 'dynamické klíče monitoru chybí ve slovníku');

// angličtina opravdu přepne
I18N.setLang('en');
assert.strictEqual(I18N.t('set.title'), 'Settings');
assert.strictEqual(I18N.models(1), '1 free model');
assert.strictEqual(I18N.models(5), '5 free models');
I18N.setLang('cs');
assert.strictEqual(I18N.models(3), '3 free modely');
assert.strictEqual(I18N.models(5), '5 free modelů');

// každý poskytovatel má anglický popis
const { PROVIDERS } = require('../src/providers');
assert.deepStrictEqual(PROVIDERS.filter((p) => !p.noteEn).map((p) => p.id), [], 'poskytovatelé bez anglického popisu');

// anglický katalog skills pokrývá všechny skills
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills', 'catalog.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skills', 'catalog.en.json'), 'utf8'));
assert.deepStrictEqual(cat.skills.filter((s) => !en.skills[s.name]?.summary || !en.skills[s.name]?.what).map((s) => s.name), [], 'skills bez anglického návodu');
assert.deepStrictEqual(cat.groups.filter((g) => !en.groups[g.id]).map((g) => g.id), [], 'skupiny bez anglického názvu');

console.log(`i18n OK (${Object.keys(D).length} klíčů, ${used.size} použitých)`);
