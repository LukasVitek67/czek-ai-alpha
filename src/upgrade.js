// Přechod na novější sestavení z plochy. Nová verze jde na plochu jako czek-ai-<verze>.exe vedle běžící
// czek-ai.exe (tools/to-desktop.js) a uživatel pak dál spouštěl starou – opravy se k němu nedostaly
// (13.–14. 11.: běžela 0.15.8, oprava seznamu úkolů byla v 0.15.9 na ploše). Appka novější soubor najde,
// nabídne restart a skrytý skript po jejím ukončení soubor přesune na místo czek-ai.exe a spustí ho.
'use strict';
const fs = require('fs');
const path = require('path');

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

/** Nejnovější czek-ai-X.Y.Z.exe ve složce, která je novější než `current`, jinak null. */
function newerBuild(dir, current) {
  try {
    const best = fs.readdirSync(dir)
      .map((f) => /^czek-ai-(\d+\.\d+\.\d+)\.exe$/i.exec(f))
      .filter((m) => m && cmp(m[1], current) > 0)
      .sort((a, b) => cmp(b[1], a[1]))[0];
    return best ? { version: best[1], file: path.join(dir, best[0]) } : null;
  } catch { return null; }
}

/**
 * Kam nová verze patří: vždy czek-ai.exe. Když běží czek-ai-X.Y.Z.exe (uživatel 14. 11. spustil rovnou
 * czek-ai-0.15.11.exe z plochy), nová jde na czek-ai.exe a stará verzovaná se po ukončení smaže – jinak by
 * se nová přesunula pod jméno staré verze a czek-ai.exe zůstala stará.
 * @returns {{to: string, old: string|null}}
 */
function upgradeTarget(running) {
  if (!running) return { to: null, old: null };
  if (/^czek-ai-\d+\.\d+\.\d+\.exe$/i.test(path.basename(running))) return { to: path.join(path.dirname(running), 'czek-ai.exe'), old: running };
  return { to: running, old: null };
}

/**
 * Skript cmd: dokud běží stará appka (soubor je zamčený), zkouší přesun (max ~90 s); pak novou spustí a smaže se.
 * S `old` (běžela jiná exe než `to`) nejdřív počká, až jde stará smazat (= appka skončila), ať se nová nespustí
 * vedle ještě běžící staré.
 * @param {{from: string, to: string, old?: string|null, start?: boolean}} o
 */
function upgradeScript(o) {
  const wait = o.old && path.resolve(o.old).toLowerCase() !== path.resolve(o.to).toLowerCase() ? [
    'set w=0',
    ':wait',
    `del /F /Q "${o.old}" >nul 2>&1`,
    `if not exist "${o.old}" goto moved`,
    'set /a w+=1',
    'if %w% GEQ 90 exit /b 1',
    'ping -n 2 127.0.0.1 >nul',
    'goto wait',
    ':moved',
  ] : [];
  return [
    '@echo off',
    ...wait,
    'set n=0',
    ':retry',
    `move /Y "${o.from}" "${o.to}" >nul 2>&1 && goto run`,
    'set /a n+=1',
    'if %n% GEQ 90 exit /b 1',
    'ping -n 2 127.0.0.1 >nul',
    'goto retry',
    ':run',
    ...(o.start === false ? [] : [`start "" "${o.to}"`]),
    '(goto) 2>nul & del "%~f0"',
  ].join('\r\n') + '\r\n';
}

module.exports = { newerBuild, upgradeScript, upgradeTarget, cmp };
