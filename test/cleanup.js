// Úklid starých rozbalených kopií přenosné Zdarmy v %TEMP% (src/cleanup.js). Jen v dočasné složce.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanStaleUnpacks } = require('../src/cleanup');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-cleanup-'));
const mk = (name, zdarma = true) => {
  const app = path.join(tmp, name, 'app');
  fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
  if (zdarma) { fs.writeFileSync(path.join(app, 'Zdarma.exe'), 'x'.repeat(1000)); fs.writeFileSync(path.join(app, 'resources', 'app.asar'), 'y'); }
  return path.join(tmp, name);
};
mk('nsa1111.tmp'); // stará Zdarma → pryč
mk('nsb2222.tmp'); // ze které běžíme → zůstane
mk('nsc3333.tmp', false); // cizí program (jiný instalátor NSIS) → zůstane
mk('nsd4444.tmp'); // čerstvá (mladší než limit) → zůstane
mk('other.tmp'); // jiný název → zůstane
fs.mkdirSync(path.join(tmp, 'nse5555.tmp.zdarma-del')); // zbytek po přerušeném mazání → pryč
const now = Date.now();
const old = new Date(now - 3600e3);
for (const n of ['nsa1111.tmp', 'nsb2222.tmp', 'nsc3333.tmp', 'other.tmp']) fs.utimesSync(path.join(tmp, n), old, old);

// kopie, ze které běží jiná Zdarma (spuštěné exe = zamčené) → zůstane
// (zamčené běžící exe jde nasimulovat jen na Windows; přenosná verze a úklid %TEMP% jsou jen pro Windows)
const WIN = process.platform === 'win32';
let child = null;
if (WIN) {
  const busy = mk('nsf6666.tmp');
  fs.copyFileSync('C:/Windows/System32/PING.EXE', path.join(busy, 'app', 'Zdarma.exe'));
  fs.utimesSync(busy, old, old);
  child = require('child_process').spawn(path.join(busy, 'app', 'Zdarma.exe'), ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
}

setTimeout(() => {
  try {
    const r = cleanStaleUnpacks({ tmp, self: path.join(tmp, 'nsb2222.tmp', 'app', 'Zdarma.exe'), now });
    assert.deepStrictEqual(r.removed, ['nsa1111.tmp']);
    assert.ok(r.bytes >= 1000);
    const left = fs.readdirSync(tmp).sort();
    assert.deepStrictEqual(left, ['nsb2222.tmp', 'nsc3333.tmp', 'nsd4444.tmp', ...(WIN ? ['nsf6666.tmp'] : []), 'other.tmp']);
    console.log('cleanup OK');
  } catch (e) { console.error(e); process.exitCode = 1; }
  if (child) child.kill();
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 1000);
}, 1500);
