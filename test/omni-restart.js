// Skutečný OmniRoute v dočasné složce: když ho zabije cizí program, ozve se onExit (Zdarma ho spustí znovu);
// ukončení přes stop() onExit nevolá. Živě 8. 11.: agent spustil `taskkill //F //IM node.exe`.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { OmniRoute } = require('../src/omniroute');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-omni-restart-'));
  let exits = 0;
  const eng = new OmniRoute({ dataDir: dir, onExit: () => { exits++; } });
  try {
    await eng.start();
    execFileSync('taskkill', ['/pid', String(eng.proc.pid), '/T', '/F'], { stdio: 'ignore' }); // „cizí“ zabití
    for (let i = 0; i < 40 && !exits; i++) await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(exits, 1, 'onExit po cizím zabití');
    assert.strictEqual(eng.ready, false);

    const eng2 = new OmniRoute({ dataDir: dir, onExit: () => { exits++; } });
    await eng2.start();
    eng2.stop();
    await new Promise((r) => setTimeout(r, 2000));
    assert.strictEqual(exits, 1, 'stop() nesmí volat onExit');
    console.log('omni-restart OK');
  } finally {
    eng.stop();
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
