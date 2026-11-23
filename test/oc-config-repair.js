// Rozbitý / komentovaný opencode.json nesmí zastavit start (izolované XDG_CONFIG_HOME).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-cfgrepair-'));
process.env.XDG_CONFIG_HOME = path.join(base, 'config');
delete process.env.OPENCODE_CONFIG_DIR;
const oc = require('../src/opencode');
const file = oc.CONFIG_FILE();
fs.mkdirSync(path.dirname(file), { recursive: true });
const tiers = [{ id: 'max', name: 'Max', keys: [] }];

// 1) JSONC: komentáře, čárka na konci, URL s // v řetězci → přečte se, vlastní hodnoty zůstanou
fs.writeFileSync(file, `{
  // můj komentář
  "$schema": "https://opencode.ai/config.json", /* blok */
  "theme": "tokyonight",
  "keybinds": { "leader": "ctrl+x", },
}`);
oc.writeConfig(4545, [], { tiers, snapshotOff: true });
let cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.strictEqual(cfg.theme, 'tokyonight');
assert.strictEqual(cfg.$schema, 'https://opencode.ai/config.json');
assert.strictEqual(cfg.keybinds.leader, 'ctrl+x');
assert.ok(cfg.plugin.some((p) => String(p).includes('czek-guard')));
assert.match(fs.readFileSync(file + '.bak', 'utf8'), /můj komentář/, 'original with comments kept in .bak');

// 2) rozbitý soubor (useknutý zápis) → obnova z .bak, rozbitý originál v .broken
fs.writeFileSync(file + '.bak', JSON.stringify({ theme: 'gruvbox' }));
fs.writeFileSync(file, '{ "theme": "gruv');
const r = oc.writeConfig(4545, [], { tiers, snapshotOff: true });
assert.ok(r.changed);
cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.strictEqual(cfg.theme, 'gruvbox');
assert.strictEqual(fs.readFileSync(file + '.broken', 'utf8'), '{ "theme": "gruv');
assert.strictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).theme, 'gruvbox', '.bak not overwritten by broken file');

// 3) rozbitý soubor i záloha → srozumitelná chyba
fs.writeFileSync(file, '{ x');
fs.writeFileSync(file + '.bak', '{ y');
assert.throws(() => oc.writeConfig(4545, [], { tiers }), /není platný JSON/);

// 4) UTF-8 BOM (Poznámkový blok) nevadí
fs.writeFileSync(file, '﻿{"theme":"nord"}');
oc.writeConfig(4545, [], { tiers, snapshotOff: true });
assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'nord');

fs.rmSync(base, { recursive: true, force: true });
console.log('oc-config-repair OK');
