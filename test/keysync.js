// Klíče v soukromém repu (src/keysync.js): sloučení, zápis jen při změně, nalezení klonu repa, a skutečný
// průchod aplikací (izolovaný profil): --import-keys → šifrované settings.json → --export-keys, start s
// CZEK_KEYS_FILE doplní chybějící klíč. Žádné skutečné klíče, jen zástupné texty.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ks = require('../src/keysync');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-keysync-'));
const file = path.join(base, 'repo', 'private', 'keys.json');

// unit: zápis, beze změny se nepřepisuje, sloučení nepřepíše místní klíč
const local = { providers: { groq: { key: 'test-groq-A' }, nvidia: { key: '' } }, customProviders: [{ id: 'c1', name: 'Moje', baseUrl: 'http://x/v1', key: 'test-c1' }] };
assert.strictEqual(ks.write(file, local), true);
assert.strictEqual(ks.write(file, local), false, 'unchanged → not rewritten');
const j = ks.read(file);
assert.deepStrictEqual(j.providers, { groq: 'test-groq-A' });
assert.strictEqual(j.customProviders[0].key, 'test-c1');
const other = { providers: { groq: { key: 'test-groq-B' } }, customProviders: [] };
fs.writeFileSync(file, JSON.stringify({ format: 'czek-ai-keys', version: 1, providers: { groq: 'test-groq-A', openrouter: 'test-or' }, customProviders: j.customProviders }));
const got = ks.merge(file, other);
assert.deepStrictEqual(got.sort(), ['c1', 'openrouter']);
assert.strictEqual(other.providers.groq.key, 'test-groq-B', 'local key kept');
assert.strictEqual(other.providers.openrouter.key, 'test-or');
assert.strictEqual(ks.merge(path.join(base, 'nope.json'), other).length, 0);

// nalezení klonu repa (package.json name czek-ai + .git)
const desk = path.join(base, 'Desktop', 'projekt', 'czek-ai');
fs.mkdirSync(path.join(desk, '.git'), { recursive: true });
fs.writeFileSync(path.join(desk, 'package.json'), '{"name":"czek-ai"}');
fs.mkdirSync(path.join(base, 'Desktop', 'jiny'), { recursive: true });
fs.writeFileSync(path.join(base, 'Desktop', 'jiny', 'package.json'), '{"name":"neco"}');
// klon BEZ private/keys.json (např. veřejné repo spolužáka) se nevezme – klíče se do něj nikdy nezapíšou samy
assert.strictEqual(ks.findRepoFile([path.join(base, 'Desktop')]), null, 'clone without private/keys.json is ignored');
fs.mkdirSync(path.join(desk, 'private'), { recursive: true });
fs.writeFileSync(path.join(desk, 'private', 'keys.json'), '{"format":"czek-ai-keys","version":1,"providers":{}}');
assert.strictEqual(ks.findRepoFile([path.join(base, 'Desktop')]), path.join(desk, 'private', 'keys.json'));
assert.strictEqual(ks.findRepoFile([path.join(base, 'Desktop', 'jiny')]), null);
console.log('keysync unit OK');

// aplikace: import → šifrované nastavení → export
const electron = require('electron');
const root = path.join(__dirname, '..');
const env = { ...process.env, ZDARMA_USER_DATA: path.join(base, 'userdata'), XDG_CONFIG_HOME: path.join(base, 'cfg'), XDG_DATA_HOME: path.join(base, 'data'), ZDARMA_HIDDEN: '1' };
delete env.CZEK_KEYS_FILE;
const run = (...args) => spawnSync(electron, ['.', ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
const src = path.join(base, 'in.json');
fs.writeFileSync(src, JSON.stringify({ format: 'czek-ai-keys', version: 1, providers: { groq: 'test-groq-X', gemini: 'test-gem-Y' }, customProviders: [] }));
let r = run(`--import-keys=${src}`);
assert.match(r.stdout, /doplněno: groq, gemini/, r.stdout + r.stderr);
const saved = JSON.parse(fs.readFileSync(path.join(env.ZDARMA_USER_DATA, 'settings.json'), 'utf8'));
assert.ok(saved.providers.groq.key.startsWith('enc:'), 'stored encrypted');
const out = path.join(base, 'out.json');
r = run(`--export-keys=${out}`);
assert.deepStrictEqual(ks.read(out).providers, { groq: 'test-groq-X', gemini: 'test-gem-Y' });
// --keys-file uloží cestu a srovná soubor s místními klíči (doplní z něj, zapíše do něj)
const repoFile = path.join(base, 'repo2', 'private', 'keys.json');
fs.mkdirSync(path.dirname(repoFile), { recursive: true });
fs.writeFileSync(repoFile, JSON.stringify({ format: 'czek-ai-keys', version: 1, providers: { mistral: 'test-mis-Z' }, customProviders: [] }));
r = run(`--keys-file=${repoFile}`);
assert.deepStrictEqual(ks.read(repoFile).providers, { groq: 'test-groq-X', gemini: 'test-gem-Y', mistral: 'test-mis-Z' }, 'merged both ways');
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(env.ZDARMA_USER_DATA, 'settings.json'), 'utf8')).keysFile, repoFile);
console.log('keysync app OK (import → šifrováno → export, --keys-file obousměrně)');
fs.rmSync(base, { recursive: true, force: true });
