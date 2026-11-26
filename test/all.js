// Všechny testy, které nepotřebují síť, klíče ani skutečné modely: jednotkové, mocky OmniRoute a skutečný OpenCode
// s falešným modelem. Jeden po druhém (testy mají pevné porty), každý s limitem, na konci tabulka a kód 1 při chybě.
//   node test/all.js                 # vše offline (~15–25 min)
//   node test/all.js guard oc-       # jen testy, jejichž název obsahuje některé ze slov
//   OPENCODE_BIN=<opencode> ZDARMA_OMNIROUTE_ROOT=<omniroute>  (bez nich se testy, které je potřebují, přeskočí)
// Vynechané (potřebují síť / klíče / celou appku se skutečnými modely): app-*, *live*, bench-*, capture-opencode,
// cdp-console, wizard-links, installer-tools, first-byte, gemini-sig, run.js (živý test staré smyčky).
// Měření smyčky Strata (omni-probe-gate-safety, omni-probe-restart) jen jménem nebo ALL_MEASURE=1 (viz MEASURE níž).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dir = __dirname;
const SKIP = /^(app-|bench-|capture-opencode|cdp-console|wizard-links|installer-tools|first-byte|gemini-sig|run\.js|all\.js)|live/;
// testy, které spouštějí skutečný OpenCode / potřebují balík OmniRoute
const NEEDS_OC = /^(oc-|fullauto|installer\.js|class-cache)/;
const NEEDS_OMNI = /^(oc-lean|oc-auto-context|oc-watch\.js|oc-race|oc-vision|oc-visible)/;
// skutečný cargo (Rust): bez něj test přeskočit
const NEEDS_CARGO = /^oc-autocheck/;
const hasCargo = () => require('child_process').spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cargo']).status === 0;
const home = os.homedir();
const guess = (p) => (fs.existsSync(p) ? p : null);
process.env.OPENCODE_BIN ||= guess(path.join(home, '.local/share/czek-bench/node_modules/opencode-linux-x64/bin/opencode'))
  || guess(path.join(home, 'AppData/Roaming/czek-ai/opencode-bin/opencode.exe')) || ''; // Windows: binárka nainstalovaná appkou
process.env.ZDARMA_OMNIROUTE_ROOT ||= guess(path.join(home, '.local/share/czek-bench/node_modules/omniroute'))
  || guess(path.join(home, 'AppData/Roaming/czek-ai/omniroute-app/node_modules/omniroute')) || ''; // Windows: OmniRoute z instalace appky
// ZDARMA_SKIP_NET jen pro testy instalátoru (všem by rozbil start OpenCode: test pak visí do limitu)
const SKIP_NET = /^(installer\.js|class-cache)/;
const LIMIT_MS = Number(process.env.TEST_LIMIT_MS) || 300000;
// Měřicí testy smyčky Strata: hypotézy s vlastním „pass" (i v archivu z Linuxu většinou pass:false), každý 8–10 min
// (5× čerstvý OmniRoute). Nejsou regresní → výchozí běh je přeskočí; spustí se jménem
// (node test/all.js omni-probe-restart) nebo s ALL_MEASURE=1, s limitem aspoň 15 min.
const MEASURE = /^(omni-probe-gate-safety|omni-probe-restart)\.js$/;
const limitFor = (f) => (MEASURE.test(f) ? Math.max(LIMIT_MS, 900000) : LIMIT_MS);

const filters = process.argv.slice(2);
const all = fs.readdirSync(dir).filter((f) => /\.(m?js)$/.test(f) && fs.statSync(path.join(dir, f)).isFile() && !SKIP.test(f))
  .filter((f) => !filters.length || filters.some((w) => f.includes(w))).sort();

function run(f) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = SKIP_NET.test(f) ? { ...process.env, ZDARMA_SKIP_NET: '1' } : process.env;
    const child = spawn(process.execPath, [path.join(dir, f)], { cwd: path.join(dir, '..'), env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '';
    child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
    // Windows: child.kill() zabije jen node s testem, ne jeho OpenCode/OmniRoute → po timeoutu osiří, drží porty a CPU a
    // další testy pak padají do limitu (lavina). taskkill /T zabije celý strom (jako test/oc-race.js).
    const kill = () => { try { if (process.platform === 'win32') require('child_process').execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const lim = limitFor(f);
    const timer = setTimeout(() => { out += `\n[all.js] limit ${lim / 1000} s`; kill(); }, lim);
    child.on('exit', (code, sig) => {
      clearTimeout(timer); kill(); // i podprocesy (OpenCode), kdyby test zapomněl
      resolve({ f, code: sig ? 124 : code, ms: Date.now() - t0, out });
    });
  });
}

(async () => {
  const res = [];
  for (const f of all) {
    if (MEASURE.test(f) && !process.env.ALL_MEASURE && !filters.some((w) => f.includes(w))) { res.push({ f, skip: 'měření (ALL_MEASURE=1)' }); continue; }
    if (NEEDS_OC.test(f) && !process.env.OPENCODE_BIN) { res.push({ f, skip: 'bez OPENCODE_BIN' }); continue; }
    if (NEEDS_CARGO.test(f) && !hasCargo()) { res.push({ f, skip: 'bez cargo' }); continue; }
    if (NEEDS_OMNI.test(f) && !process.env.ZDARMA_OMNIROUTE_ROOT) { res.push({ f, skip: 'bez ZDARMA_OMNIROUTE_ROOT' }); continue; }
    const r = await run(f);
    const last = r.out.trim().split('\n').filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-1)[0] || '';
    console.log(`${r.code === 0 ? 'OK  ' : 'FAIL'} ${f} (${(r.ms / 1000).toFixed(1)} s)${r.code === 0 ? '' : ' :: ' + last.slice(0, 160)}`);
    res.push({ ...r, last });
  }
  const bad = res.filter((r) => !r.skip && r.code !== 0);
  const skipped = res.filter((r) => r.skip);
  console.log(`\n${res.length - bad.length - skipped.length} OK, ${bad.length} FAIL, ${skipped.length} přeskočeno${skipped.length ? ' (' + skipped.map((r) => r.f).join(', ') + ')' : ''}`);
  if (bad.length) {
    for (const r of bad) console.log(`\n--- ${r.f} ---\n${r.out.split('\n').filter((l) => !/^\s+at /.test(l)).slice(-15).join('\n')}`);
    process.exitCode = 1;
  }
})();
