// Nejnovější build na plochu: vždy jen jeden soubor Desktop\czek-ai.exe, starší verze (i dřívější Zdarma.exe) pryč.
// node tools/to-desktop.js   (nebo npm run desktop; npm run dist:desktop = build + tohle)
//
// Běžící ček-ai se nezavírá. Její exe nejde přepsat, smazat ani přesunout (spouštěč ho drží zamčený),
// takže když běží, dá se nejnovější vedle jako czek-ai-<verze>.exe a při dalším spuštění tohoto
// skriptu (po zavření staré) se z něj stane czek-ai.exe.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const version = process.argv[2] || require(path.join(root, 'package.json')).version;
const src = path.join(root, 'dist', `czek-ai-${version}-portable.exe`);
if (!fs.existsSync(src)) { console.error(`Chybí ${src} – nejdřív npm run dist`); process.exit(1); }

const desktop = spawnSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8', windowsHide: true }).stdout.trim() || path.join(os.homedir(), 'Desktop');
const target = path.join(desktop, 'czek-ai.exe');
const side = path.join(desktop, `czek-ai-${version}.exe`);

const busy = (e) => ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
const tryDelete = (f) => { try { fs.unlinkSync(f); return true; } catch (e) { if (!busy(e) && e.code !== 'ENOENT') throw e; return false; } };

// 1) Desktop\czek-ai.exe = nejnovější (když stará běží, jde nejnovější vedle)
let placed;
if (!fs.existsSync(target) || tryDelete(target)) { fs.copyFileSync(src, target); placed = target; }
else { fs.copyFileSync(src, side); placed = side; }

// 2) ostatní kopie na ploše (czek-ai-0.x.exe, staré Zdarma.exe, Zdarma-0.x.exe…) a starý zástupce pryč
const left = [];
for (const f of fs.readdirSync(desktop)) {
  const full = path.join(desktop, f);
  if (full === placed) continue;
  if (/^(czek-ai-[\d.]+(-portable)?|Zdarma(-[\d.]+(-portable)?)?)\.exe$/i.test(f) && !tryDelete(full)) left.push(f);
  if (f === 'Zdarma (OpenCode).lnk' || f === 'czek-ai (OpenCode).lnk') tryDelete(full);
}

// 3) běží starší czek-ai-X.Y.Z.exe → i kopie s verzí, ať ji běžící appka najde a nabídne restart (src/upgrade.js)
if (placed === target && left.some((f) => /^czek-ai-[\d.]+\.exe$/i.test(f))) {
  fs.copyFileSync(src, side);
  console.log(`Plocha: czek-ai.exe = ${version}; běží ${left.join(', ')} → vedle i ${path.basename(side)} pro lištu „Restartovat do nové verze“`);
} else if (placed === target) console.log(`Plocha: czek-ai.exe = ${version}`);
else console.log(`Plocha: czek-ai.exe ještě běží (starší verze), nejnovější je zatím ${path.basename(side)}. Po zavření staré spusť znovu npm run desktop.`);
if (left.length) console.log(`Běží, nešly smazat: ${left.join(', ')}`);
