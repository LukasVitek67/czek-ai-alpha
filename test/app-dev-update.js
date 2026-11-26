// CELÁ appka jako dev verze (src/devUpdate.js): klon tohoto repa se značkou dev kanálu, „origin“ = holé repo
// v dočasné složce. Nový commit kódu v originu → appka ho při startu sloučí a spustí se znovu; další commit za běhu →
// lišta „Nová verze z repa“ v okně OpenCode → klik → restart už s ním. Skrytě, dočasný profil, vlastní porty.
//   OPENCODE_BIN=<opencode> node test/app-dev-update.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const cdp = require('./app-cdp');

const CDP = Number(process.env.DEVUPD_CDP_PORT) || 9367;
const OC_PORT = Number(process.env.DEVUPD_OC_PORT) || 4455;
const repo = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-appdev-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const D = path.join(base, 'dev');
const ud = x('userdata');
const proj = x('proj');
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'zdarma', lang: 'cs', providers: {}, wizardDone: true, lastCwd: proj }));
const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: String(OC_PORT), ZDARMA_HIDDEN: '1', CZEK_DEV_POLL_MS: '5000' };
delete env.OPENCODE_CONFIG_DIR;
if (!env.OPENCODE_BIN && process.platform === 'win32') {
  const guess = path.join(os.homedir(), 'AppData', 'Roaming', 'czek-ai', 'opencode-bin', 'opencode.exe');
  if (fs.existsSync(guess)) env.OPENCODE_BIN = guess;
}
const OC = `127.0.0.1:${OC_PORT}`;
const ev = (expr) => Promise.race([cdp.evaluate(CDP, OC, expr), wait(8000).then(() => null)]).catch(() => null);
const readLog = () => { for (const f of ['zdarma.log', 'czek-ai.log']) { const p = path.join(ud, f); if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } return ''; };
const waitLog = async (re, ms) => { for (let t = 0; t < ms; t += 500) { const m = readLog().match(re); if (m) return m; await wait(500); } return null; };
const push = (msg, line) => {
  const f = path.join(base, 'seed', 'src', 'devUpdate.js');
  fs.appendFileSync(f, `// ${line}\n`);
  sh(path.join(base, 'seed'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', msg);
  sh(path.join(base, 'seed'), 'push', '-q', 'origin', 'main');
  return sh(path.join(base, 'seed'), 'rev-parse', '--short', 'HEAD');
};
// appka se sama spouští znovu (app.relaunch) → procesy mimo náš child; najít je podle složky dev klonu
const killAll = () => {
  if (process.platform !== 'win32') { try { execFileSync('pkill', ['-f', D]); } catch {} return; }
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(base)}*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`], { stdio: 'ignore' });
  } catch {}
};

(async () => {
  try {
    sh(base, 'clone', '-q', '--bare', '--single-branch', '--branch', 'main', repo, 'origin.git');
    sh(base, 'clone', '-q', path.join(base, 'origin.git'), 'dev');
    sh(base, 'clone', '-q', path.join(base, 'origin.git'), 'seed');
    fs.writeFileSync(path.join(D, '.git', 'czek-dev-channel'), 'test');
    fs.cpSync(path.join(repo, 'node_modules', 'marked'), path.join(D, 'node_modules', 'marked'), { recursive: true });
    const h0 = sh(D, 'rev-parse', '--short', 'HEAD');
    const h1 = push('feat: e2e kód 1', 'e2e 1');

    // 1) start: nový commit kódu → sloučit → nové spuštění
    const child = spawn(require('electron'), [D, '--password-store=basic', `--remote-debugging-port=${CDP}`], { env, stdio: 'ignore' });
    const upd = await waitLog(/\[dev\] aktualizováno (\S+)→(\S+) feat: e2e kód 1 → nové spuštění/, 60000);
    console.log('start:', upd && upd[0]);
    assert.ok(upd, 'sloučeno při startu; log:\n' + readLog().slice(-1500));
    assert.deepStrictEqual([upd[1], upd[2]], [h0, h1]);
    const run = await waitLog(new RegExp(`\\[dev\\] verze ze zdrojáků ${h1}`), 60000);
    assert.ok(run, 'nové spuštění běží s novým commitem');
    assert.ok(fs.readFileSync(path.join(D, 'src', 'devUpdate.js'), 'utf8').includes('e2e 1'));
    assert.strictEqual((readLog().match(/\[app\] start/g) || []).length, 2, '2 starty (ne smyčka)');
    console.log('child (1. proces) skončil:', child.exitCode !== null);

    // 2) okno OpenCode, další commit za běhu → lišta → klik → restart s ním
    let ok = false;
    for (let i = 0; i < 180 && !ok; i++) { ok = !!(await cdp.page(CDP, OC).catch(() => null)); if (!ok) await wait(1000); }
    assert.ok(ok, 'okno OpenCode');
    const h2 = push('feat: e2e kód 2', 'e2e 2');
    let bar = null;
    for (let i = 0; i < 100 && !bar; i++) { bar = await ev(`document.querySelector('[data-czek-upgrade]')?.innerText || null`); if (!bar) await wait(1000); }
    console.log('lišta:', JSON.stringify(bar));
    assert.match(bar || '', new RegExp(`Nová verze z repa \\(${h2}\\): feat: e2e kód 2`));
    await cdp.shot(CDP, OC, path.join(base, 'bar.png')).catch(() => {});
    assert.ok(!fs.readFileSync(path.join(D, 'src', 'devUpdate.js'), 'utf8').includes('e2e 2'), 'za běhu se kód nemění');
    await ev(`document.querySelector('[data-czek-upgrade] button').click(); 1`);
    const re = await waitLog(new RegExp(`\\[dev\\] verze ze zdrojáků ${h2}`), 90000);
    console.log('po kliknutí:', re && re[0]);
    assert.ok(re, 'po restartu běží commit 2; log:\n' + readLog().slice(-1500));
    assert.ok(/\[dev\] restart do nové verze/.test(readLog()));
    const errs = readLog().split('\n').filter((l) => /\[dev\].*(selhal|nejde)/.test(l));
    assert.deepStrictEqual(errs, [], 'žádné chyby dev aktualizace');
    console.log(`app-dev-update OK (start: ${h0}→${h1} + nové spuštění; za běhu lišta s ${h2}; klik → restart s ${h2})`);
  } finally {
    killAll();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
