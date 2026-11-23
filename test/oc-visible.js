// Výchozí výběr modelů v OpenCode (živá cesta přes OmniRoute): visibleModels = auto/coding + pár ověřených
// modelů z měření (src/evidence.js). Tierlisty (combos) ukazuje plugin vždy; „všechny modely" (onlyTiers=false)
// visibleModels vynechá = celý katalog („Další"). Viz src/opencode.js leanVisible / provenModelKeys.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-vis-cfg-'));
process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-vis-data-'));
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_DATA_DIR;
const oc = require('../src/opencode');
const ev = require('../src/evidence');

// --- jednotka: leanVisible / provenModelKeys ------------------------------------------------------
const proven = oc.provenModelKeys();
assert.ok(Array.isArray(proven), 'provenModelKeys vrací pole');
assert.ok(proven.length >= 1 && proven.length <= 8, `pár ověřených (1–8), je ${proven.length}`);
// pořadí = rank z evidence (0 = nejlepší)
const expectTop = Object.entries(ev.proven(ev.load())).sort((a, b) => a[1].rank - b[1].rank).slice(0, 8).map(([k]) => k);
assert.deepStrictEqual(proven, expectTop, 'ověřené modely jsou v pořadí podle ranku');

const vis = oc.leanVisible();
assert.strictEqual(vis[0], 'auto/coding', 'první je auto/coding');
assert.deepStrictEqual(vis.slice(1), proven, 'za ním ověřené modely z měření');
assert.strictEqual(new Set(vis).size, vis.length, 'žádné duplicity');
// vlastní seznam přebije ověřené a auto/coding se nezdvojí
assert.deepStrictEqual(oc.leanVisible({ visibleModels: ['auto/coding', 'foo'] }), ['auto/coding', 'foo'], 'override + bez duplicity auto/coding');
assert.deepStrictEqual(oc.leanVisible({ visibleModels: [] }), ['auto/coding'], 'prázdný override = jen auto/coding');

// --- integrace: zapsaný opencode.json (živá omniUrl cesta) ----------------------------------------
// falešný plugin, ať installOmniPlugin jen zkopíruje (patch .replace jsou no-opy)
const plug = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-vis-plug-'));
fs.writeFileSync(path.join(plug, 'package.json'), JSON.stringify({ name: '@omniroute/opencode-plugin', version: '0.0.0-test' }));
fs.mkdirSync(path.join(plug, 'dist'));
fs.writeFileSync(path.join(plug, 'dist', 'index.js'), '// stub omniroute plugin\n');

const base = { omniUrl: 'http://127.0.0.1:1', omniKey: 'k', pluginSrc: plug, guard: false, dcp: false, reviewer: false };
const read = (r) => JSON.parse(fs.readFileSync(r.file, 'utf8'));
const omniEntry = (cfg) => (cfg.plugin || []).find((p) => Array.isArray(p) && String(p[0]).includes('omniroute'));

// výchozí (lean): visibleModels = auto/coding + ověřené
let cfg = read(oc.writeConfig(4999, [], { ...base, onlyTiers: true }));
let e = omniEntry(cfg);
assert.ok(e, 'plugin OmniRoute je v configu');
assert.deepStrictEqual(e[1].features.visibleModels, oc.leanVisible(), 'výchozí visibleModels = auto/coding + ověřené');
assert.ok(e[1].features.visibleModels.length > 1, 'nabídka není jen auto/coding (ověřené modely se ukázaly)');

// „všechny modely" (Další): onlyTiers=false → bez visibleModels
cfg = read(oc.writeConfig(4999, [], { ...base, onlyTiers: false }));
e = omniEntry(cfg);
assert.ok(e, 'plugin OmniRoute je v configu i u všech modelů');
assert.ok(!e[1].features || e[1].features.visibleModels === undefined, 'všechny modely: žádné omezení visibleModels');

console.log(`oc-visible OK (výchozí nabídka: ${oc.leanVisible().length} položek = auto/coding + ${proven.length} ověřených; „všechny modely" bez omezení)`);
