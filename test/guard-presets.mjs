// Presety chatu v czek-guard (src/guard/presets.mjs + hooky v index.mjs): agent zprávy uživatele → plán a skills
// presetu na konci systémového promptu relace (základní prompt OpenCode zůstává), jiný agent preset vypne,
// titulek relace bez playbooku, poškozená data = žádné presety, presets:false = vypnuto. Bez OpenCode, ~0,1 s.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPresets, presetBlock, isTitleRequest } from '../src/guard/presets.mjs';
import { CzekGuard } from '../src/guard/index.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-gpreset-'));
const file = path.join(dir, 'presets.json');
fs.writeFileSync(file, JSON.stringify({ agents: {
  'web-design': { id: 'web-design', name: 'Web design', skills: ['impeccable', 'ui-ux-pro-max', 'BAD SKILL', 5], plan: '## Plan\n1. Do the design thing.' },
  empty: { id: 'empty', name: 'No plan', skills: ['x'], plan: '   ' },
} }));

// 1) načtení: preset bez plánu vynechán, neplatná jména skills pryč, chybějící / poškozený soubor = {}
const p = loadPresets(file);
assert.deepStrictEqual(Object.keys(p), ['web-design']);
assert.deepStrictEqual(p['web-design'].skills, ['impeccable', 'ui-ux-pro-max']);
assert.deepStrictEqual(loadPresets(path.join(dir, 'chybi.json')), {});
fs.writeFileSync(path.join(dir, 'bad.json'), '{rozbite');
assert.deepStrictEqual(loadPresets(path.join(dir, 'bad.json')), {});

// 2) text do systémového promptu
const b = presetBlock(p['web-design']);
assert.match(b, /czek-ai preset: Web design/);
assert.match(b, /`impeccable`, `ui-ux-pro-max`/);
assert.match(b, /1\. Do the design thing\./);
assert.ok(!presetBlock({ ...p['web-design'], skills: [] }).includes('skill tool'), 'bez skills žádná výzva k načítání');
assert.ok(isTitleRequest(['You are a title generator. Output only a title.']) && !isTitleRequest(['You are OpenCode, the best coding agent.']));

// 3) hooky pluginu
const BASE = 'You are OpenCode, the best coding agent.';
const h = await CzekGuard({}, { presetsFile: file, search: false, look: false });
const sys = async (sessionID) => { const o = { system: [BASE] }; await h['experimental.chat.system.transform']({ sessionID, model: {} }, o); return o.system; };
const msg = (sessionID, agent) => h['chat.message']({ sessionID, agent }, { message: {}, parts: [{ type: 'text', text: 'udělej landing page' }] });
assert.strictEqual((await sys('s1')).length, 1, 'relace bez zprávy s presetem: beze změny');
await msg('s1', 'web-design');
let s = await sys('s1');
assert.strictEqual(s.length, 2, 'preset přidán');
assert.strictEqual(s[0], BASE, 'základní prompt OpenCode zůstává');
assert.match(s[1], /czek-ai preset: Web design[\s\S]*Do the design thing/);
assert.strictEqual((await sys('s1')).length, 2, 'i v dalších krocích téže relace');
assert.strictEqual((await sys('s2')).length, 1, 'jiná relace bez presetu');
const t = { system: ['You are a title generator. Output only a title.'] };
await h['experimental.chat.system.transform']({ sessionID: 's1', model: {} }, t);
assert.strictEqual(t.system.length, 1, 'titulek relace bez playbooku');
await msg('s1', 'build');
assert.strictEqual((await sys('s1')).length, 1, 'přepnutí na build preset vypne');
await msg('s1', 'web-design');
assert.strictEqual((await sys('s1')).length, 2, 'zpět na preset');

// 4) vypínač
const off = await CzekGuard({}, { presetsFile: file, presets: false, search: false, look: false });
await off['chat.message']({ sessionID: 's9', agent: 'web-design' }, { message: {}, parts: [] });
const o2 = { system: [BASE] };
await off['experimental.chat.system.transform']({ sessionID: 's9', model: {} }, o2);
assert.strictEqual(o2.system.length, 1, 'presets:false = nic');

fs.rmSync(dir, { recursive: true, force: true });
console.log('guard-presets OK (načtení + filtr skills, blok, preset podle agenta relace, build vypne, titulek bez playbooku, vypínač)');
