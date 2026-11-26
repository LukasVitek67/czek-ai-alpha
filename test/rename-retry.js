// renameRetry (src/installer.js): přejmenování složky po rozbalení opakuje při EPERM/EACCES/EBUSY (Windows Defender
// drží čerstvé soubory). Čistý Windows 11 ve VM 26. 11.: Git Bash „EPERM … rename git.part -> git“ → agent bez bashe.
// Simulace: fs.renameSync 3× hodí EPERM, pak projde; jiná chyba (ENOENT) se neopakuje; trvalé EPERM po limitu skončí.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renameRetry } = require('../src/installer');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-rename-'));
  const a = path.join(tmp, 'git.part'); const b = path.join(tmp, 'git');
  fs.mkdirSync(a); fs.writeFileSync(path.join(a, 'bash.exe'), 'x');
  const real = fs.renameSync;
  let fails = 3; const seen = [];
  fs.renameSync = (x, y) => { if (fails-- > 0) { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; } return real(x, y); };
  try {
    const t0 = Date.now();
    const tries = await renameRetry(a, b, { onRetry: (e, n) => seen.push(n) });
    assert.strictEqual(tries, 3, 'succeeded on the 4th attempt');
    assert.ok(fs.existsSync(path.join(b, 'bash.exe')) && !fs.existsSync(a), 'folder moved');
    assert.deepStrictEqual(seen, [1, 2, 3]);
    console.log(`  EPERM 3× → přejmenováno za ${Date.now() - t0} ms`);
    // ENOENT = skutečná chyba, bez opakování
    fs.renameSync = real;
    await assert.rejects(renameRetry(path.join(tmp, 'nic'), path.join(tmp, 'x')), /ENOENT/);
    // trvalé EPERM → po limitu původní chyba
    fs.renameSync = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
    const t1 = Date.now();
    await assert.rejects(renameRetry(b, a, { maxMs: 800 }), /EPERM/);
    assert.ok(Date.now() - t1 < 1500, 'gives up after the limit');
  } finally { fs.renameSync = real; fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('rename-retry OK (EPERM se opakuje až ~60 s, ENOENT hned, trvalé EPERM po limitu)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
