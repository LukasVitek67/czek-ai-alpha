// Průvodce klíči: co student skutečně vloží (src/wizard.js cleanKey/ownerOf/notKey). Falešné klíče jen ve formátu.
// Měří, kolik vložení by se před opravou uložilo špatně (jen trim, vždy k aktuálnímu kroku) a kolik po ní.
'use strict';
const assert = require('assert');
const W = require('../src/wizard');

const X = (n) => 'A1b2C3d4E5'.repeat(6).slice(0, n);
const nv = 'nvapi-' + X(40), or = 'sk-or-v1-' + X(40), gm = 'AIzaSy' + X(33), gh = 'ghp_' + X(36), gq = 'gsk_' + X(40), zai = X(32) + '.' + X(16);
// [krok průvodce, co student vložil, kam má klíč patřit, očekávaný čistý klíč | null = odmítnout]
const CASES = [
  ['nvidia', nv, 'nvidia', nv],
  ['nvidia', `  ${nv}\n`, 'nvidia', nv],
  ['nvidia', `"${nv}"`, 'nvidia', nv],
  ['nvidia', `Bearer ${nv}`, 'nvidia', nv],
  ['nvidia', `Authorization: Bearer ${nv}`, 'nvidia', nv],
  ['nvidia', `export NVIDIA_API_KEY="${nv}"`, 'nvidia', nv],
  ['nvidia', `$env:NVIDIA_API_KEY="${nv}"`, 'nvidia', nv],
  ['nvidia', nv.slice(0, 20) + '\n' + nv.slice(20), 'nvidia', nv], // zalomené při kopírování
  ['nvidia', or, 'openrouter', or], // klíč OpenRouter do kroku NVIDIA
  ['openrouter', gm, 'gemini', gm],
  ['gemini', `GEMINI_API_KEY=${gm}`, 'gemini', gm],
  ['zai', gh, 'github', gh],
  ['mistral', gq, 'groq', gq],
  ['zai', zai, 'zai', zai], // bez prefixu → zůstane u kroku
  ['nvidia', 'https://build.nvidia.com/settings/api-keys', 'nvidia', null],
  ['nvidia', 'student@skola.cz', 'nvidia', null],
  ['nvidia', 'nvapi-abc', 'nvidia', null],
];

let before = 0, after = 0;
for (const [step, pasted, owner, clean] of CASES) {
  // před: trim, uložit ke kroku
  const oldKey = pasted.trim();
  if (clean === null ? true : !(oldKey === clean && step === owner)) before++;
  // po: notKey → odmítnout; jinak cleanKey + ownerOf
  const nk = W.notKey(pasted);
  if (clean === null) { assert.ok(nk, `reject: ${pasted}`); continue; }
  assert.strictEqual(nk, null, `accept: ${pasted}`);
  const k = W.cleanKey(pasted);
  const target = W.ownerOf(k) || step;
  if (!(k === clean && target === owner)) after++;
  assert.strictEqual(k, clean, `clean: ${JSON.stringify(pasted)}`);
  assert.strictEqual(target, owner, `owner: ${JSON.stringify(pasted)}`);
}
// prefixy patří skutečným poskytovatelům
const { PROVIDERS } = require('../src/providers');
for (const [id] of W.PREFIXES) assert.ok(PROVIDERS.find((p) => p.id === id && p.needsKey), `${id} exists and needs a key`);
console.log(`wizard-paste OK: ${CASES.length} vložení, špatně uložených/neodmítnutých před ${before}, po ${after}`);
