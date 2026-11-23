'use strict';
// Úklid starých rozbalených kopií přenosné Zdarmy. Portable exe (electron-builder, unpackDirName: true)
// se při každém spuštění rozbalí do %TEMP%\ns????.tmp (asi 0,7 GB). Po normálním zavření ji spouštěč
// smaže, po násilném ukončení (taskkill, pád, vypnutí PC) zůstane. 8. 11. jich tam bylo 9 (5,1 GB)
// a disk C: měl 0 MB volných.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = /^ns[a-z0-9]{3,5}\.tmp$/i;
const EXES = ['czek-ai.exe', 'Zdarma.exe'];

function unpackExe(dir) {
  return EXES.map((e) => path.join(dir, 'app', e)).find((p) => fs.existsSync(p)) || null;
}

/** Je to rozbalená czek-ai / Zdarma? (app\czek-ai.exe nebo app\Zdarma.exe + app\resources\app.asar) */
function isZdarmaUnpack(dir) {
  return !!unpackExe(dir) && fs.existsSync(path.join(dir, 'app', 'resources', 'app.asar'));
}

/** Běží z kopie nějaká instance? Spuštěné exe nejde na Windows otevřít pro zápis (EBUSY).
 *  (Přejmenovat složku se spuštěným exe Windows dovolí – ověřeno, proto ne přes rename.) */
function inUse(dir) {
  const exe = unpackExe(dir);
  if (!exe) return false;
  try { fs.closeSync(fs.openSync(exe, 'r+')); return false; } catch { return true; }
}

/**
 * Smaže staré rozbalené kopie kromě té, ze které běží tahle Zdarma, a těch, ze kterých běží jiná Zdarma.
 * @returns {{removed: string[], bytes: number}}
 */
function cleanStaleUnpacks({ tmp = os.tmpdir(), self = process.execPath, minAgeMs = 10 * 60e3, now = Date.now() } = {}) {
  const out = { removed: [], bytes: 0 };
  const own = path.resolve(self).toLowerCase();
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return out; }
  for (const n of names) {
    if (!NAME.test(n)) continue;
    const dir = path.join(tmp, n);
    try {
      if (own.startsWith(path.resolve(dir).toLowerCase() + path.sep)) continue; // naše vlastní
      const st = fs.statSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < minAgeMs || !isZdarmaUnpack(dir) || inUse(dir)) continue;
      const del = dir + '.zdarma-del';
      fs.renameSync(dir, del);
      out.bytes += sizeOf(del);
      fs.rmSync(del, { recursive: true, force: true });
      out.removed.push(n);
    } catch {}
  }
  // zbytky po přerušeném mazání
  for (const n of names) if (/\.zdarma-del$/.test(n)) { try { fs.rmSync(path.join(tmp, n), { recursive: true, force: true }); } catch {} }
  return out;
}

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const n of fs.readdirSync(p)) s += sizeOf(path.join(p, n));
  } catch {}
  return s;
}

module.exports = { cleanStaleUnpacks, isZdarmaUnpack };
