// findRg (src/guard/search.mjs): kde czek-guard hledá ripgrep. OpenCode si rg stáhne do své bin složky;
// na Windows je to CACHE (XDG_CACHE_HOME, ~/.cache/opencode/bin/rg.exe), ne data. Dřív se hledalo jen v data
// složce → na Windows se rg nenašel, guard glob/grep se nenasadil a OpenCode spadl na vestavěné bez stropu
// (živě 20. 11.: glob/grep 160–225 s, smrt na 120s killu).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRg } from '../src/guard/search.mjs';

const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
const mkRg = (root) => { const bin = path.join(root, 'opencode', 'bin'); fs.mkdirSync(bin, { recursive: true }); const f = path.join(bin, name); fs.writeFileSync(f, ''); return f; };
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

const saved = { PATH: process.env.PATH, data: process.env.XDG_DATA_HOME, cache: process.env.XDG_CACHE_HOME };
process.env.PATH = ''; // ať se nechytne rg z PATH dřív než z bin složky

// 1) cache (XDG_CACHE_HOME) – tak to má OpenCode na Windows
let cache = tmp('rg-cache-');
const rgCache = mkRg(cache);
process.env.XDG_DATA_HOME = tmp('rg-data-empty-');
process.env.XDG_CACHE_HOME = cache;
assert.strictEqual(findRg(), rgCache, 'rg z cache složky (OpenCode na Windows)');

// 2) data (XDG_DATA_HOME)
let data = tmp('rg-data-');
const rgData = mkRg(data);
process.env.XDG_DATA_HOME = data;
process.env.XDG_CACHE_HOME = tmp('rg-cache-empty-');
assert.strictEqual(findRg(), rgData, 'rg z data složky');

// 3) nikde → null (guard nechá OpenCode jeho vestavěné nástroje)
process.env.XDG_DATA_HOME = tmp('rg-none-d-');
process.env.XDG_CACHE_HOME = tmp('rg-none-c-');
assert.strictEqual(findRg(), null, 'bez rg → null');

// 4) PATH má přednost před bin složkami
const pdir = tmp('rg-path-');
const rgPath = path.join(pdir, name); fs.writeFileSync(rgPath, '');
process.env.PATH = pdir;
assert.strictEqual(findRg(), rgPath, 'rg z PATH má přednost');

// obnova prostředí
for (const [k, v] of [['PATH', saved.PATH], ['XDG_DATA_HOME', saved.data], ['XDG_CACHE_HOME', saved.cache]]) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
console.log('guard-rg OK (rg z cache i data složky OpenCode, PATH má přednost, jinak null)');
