// Přechod na novější sestavení z plochy (src/upgrade.js): najde nejnovější czek-ai-X.Y.Z.exe, skript počká,
// dokud je stará exe zamčená (běží), pak ji nahradí. Tady bez spuštění (start: false).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { newerBuild, upgradeScript, upgradeTarget } = require('../src/upgrade');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-upgrade-'));
fs.writeFileSync(path.join(dir, 'czek-ai.exe'), 'OLD');
for (const v of ['0.15.8', '0.15.10', '0.15.9']) fs.writeFileSync(path.join(dir, `czek-ai-${v}.exe`), 'NEW ' + v);
fs.writeFileSync(path.join(dir, 'czek-ai-sdileni.zip'), 'zip');
const nb = newerBuild(dir, '0.15.9');
assert.deepStrictEqual(nb && nb.version, '0.15.10', 'picks newest above current (semver, not string order)');
assert.strictEqual(newerBuild(dir, '0.15.10'), null, 'nothing newer');
if (process.platform !== 'win32') { console.log('upgrade OK (bez Windows jen výběr)'); process.exit(0); }
const target = path.join(dir, 'czek-ai.exe');
// stará exe „běží“: PowerShell ji 4 s drží zamčenou (FileShare.None)
const lock = spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${target}','Open','Read','None'); Start-Sleep -Seconds 4; $f.Close()`], { windowsHide: true, stdio: 'ignore' });
const t0 = Date.now();
spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 800'], { windowsHide: true });
const cmd = path.join(dir, 'up.cmd');
fs.writeFileSync(cmd, upgradeScript({ from: nb.file, to: target, start: false }));
const r = spawnSync('cmd.exe', ['/c', cmd], { windowsHide: true, timeout: 60000 });
const waited = Date.now() - t0;
lock.kill();
assert.strictEqual(r.status, 0, 'script exit ' + r.status);
assert.strictEqual(fs.readFileSync(target, 'utf8'), 'NEW 0.15.10', 'replaced');
assert.ok(!fs.existsSync(nb.file), 'source moved away');
assert.ok(waited >= 3000, 'waited while the old exe was locked: ' + waited + ' ms');
// běží verzovaná czek-ai-0.15.11.exe (uživatel 14. 11. spustil rovnou ji): nová → czek-ai.exe, stará pryč
assert.deepStrictEqual(upgradeTarget(path.join(dir, 'czek-ai.exe')), { to: path.join(dir, 'czek-ai.exe'), old: null });
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-upgrade2-'));
const running = path.join(dir2, 'czek-ai-0.15.11.exe');
fs.writeFileSync(running, 'OLD 0.15.11');
fs.writeFileSync(path.join(dir2, 'czek-ai-0.15.12.exe'), 'NEW 0.15.12');
const tg = upgradeTarget(running);
assert.deepStrictEqual(tg, { to: path.join(dir2, 'czek-ai.exe'), old: running });
const nb2 = newerBuild(dir2, '0.15.11');
const lock2 = spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${running}','Open','Read','None'); Start-Sleep -Seconds 4; $f.Close()`], { windowsHide: true, stdio: 'ignore' });
const t2 = Date.now();
spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 800'], { windowsHide: true });
const cmd2 = path.join(dir2, 'up.cmd');
fs.writeFileSync(cmd2, upgradeScript({ from: nb2.file, to: tg.to, old: tg.old, start: false }));
const r2 = spawnSync('cmd.exe', ['/c', cmd2], { windowsHide: true, timeout: 60000 });
const waited2 = Date.now() - t2;
lock2.kill();
assert.strictEqual(r2.status, 0, 'script 2 exit ' + r2.status);
assert.strictEqual(fs.readFileSync(tg.to, 'utf8'), 'NEW 0.15.12', 'new version is czek-ai.exe');
assert.ok(!fs.existsSync(running), 'old versioned exe deleted');
assert.ok(!fs.existsSync(nb2.file), 'source moved away');
assert.ok(waited2 >= 3000, 'waited until the old app exited: ' + waited2 + ' ms');
setTimeout(() => {
  assert.ok(!fs.existsSync(cmd) && !fs.existsSync(cmd2), 'scripts deleted themselves');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  console.log(`upgrade OK (vybral 0.15.10, počkal ${Math.round(waited / 1000)} s na zamčenou exe, nahradil; běžela czek-ai-0.15.11.exe → nová je czek-ai.exe po ${Math.round(waited2 / 1000)} s, stará smazaná)`);
}, 500);
