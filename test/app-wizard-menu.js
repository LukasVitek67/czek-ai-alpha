// CELÁ appka ze zdrojáků (skrytě, dočasný profil): menu okna OpenCode → „Průvodce klíči“. Hlášení 25. 11.: appka
// spadla a nic se neukázalo. Kontrola: hlavní proces běží dál, okno nastavení existuje a ukazuje stránku průvodce
// s kartou kroku, žádné chyby v logu; potom podruhé (okno už existuje → jen přepnutí) a po zavření okna potřetí.
//   OPENCODE_BIN=<opencode> node test/app-wizard-menu.js      (ROUTER=omniroute + ZDARMA_OMNIROUTE_ROOT = s OmniRoute)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./app-cdp');
const CDP = Number(process.env.WIZMENU_CDP_PORT) || 9363;

const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-wizmenu-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const ud = x('userdata');
// bez klíčů a s hotovým průvodcem (jinak by se průvodce otevřel sám a menu bychom netestovali)
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: process.env.ROUTER || 'zdarma', lang: 'cs', providers: {}, wizardDone: true }));
const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: String(Number(process.env.WIZMENU_OC_PORT) || 4447), ZDARMA_HIDDEN: '1', ZDARMA_DEBUG: '1',
  ZDARMA_DEBUG_OPEN: 'wizardmenu', ZDARMA_DEBUG_OPEN_MS: '3000' };
delete env.OPENCODE_CONFIG_DIR;

const logFile = () => { for (const f of ['zdarma.log', 'czek-ai.log']) { const p = path.join(ud, f); if (fs.existsSync(p)) return p; } return null; };
const readLog = () => { const f = logFile(); return f ? fs.readFileSync(f, 'utf8') : ''; };
const wizardShown = () => cdp.evaluate(CDP, 'index.html', `(() => {
  const pg = document.querySelector('#page-wizard') || document.querySelector('[data-page="wizard"]');
  const card = document.querySelector('#wizCard');
  return { hash: location.hash, card: !!(card && card.children.length), visible: !!(card && card.offsetParent !== null), step: (document.querySelector('#wizCard .nm') || {}).textContent || null };
})()`).catch((e) => ({ err: e.message }));

(async () => {
  const child = spawn(require('electron'), ['.', '--password-store=basic', `--remote-debugging-port=${CDP}`], { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' });
  let exited = null;
  child.on('exit', (c, s) => { exited = { c, s }; });
  try {
    let log = '';
    for (let i = 0; i < 240 && !/\[debug\] menu průvodce 1/.test(log); i++) { await wait(1000); log = readLog(); if (exited) break; }
    console.log('menu:', (/\[debug\] menu průvodce 1 (.*)/.exec(log) || [])[1] || 'nenalezeno', '| proces:', exited ? JSON.stringify(exited) : 'běží');
    assert.ok(/\[debug\] menu průvodce 1 Průvodce/.test(log), 'menu item clicked in the OpenCode window');
    let w = null;
    for (let i = 0; i < 20; i++) { await wait(1000); w = await wizardShown(); if (w?.card) break; }
    console.log('1. otevření:', JSON.stringify(w));
    assert.ok(!exited, 'app still running after the menu click');
    assert.ok(w?.card, 'wizard card rendered after the menu click');
    // 2. okno existuje a ukazuje jinou stránku → přepnutí; 3. okno zavřené → nové okno
    for (const n of [2, 3]) {
      let seen = false;
      if (n === 2) await cdp.evaluate(CDP, 'index.html', 'document.querySelector("#wizCard").innerHTML = ""').catch(() => {});
      for (let i = 0; i < 25 && !seen; i++) { await wait(1000); seen = new RegExp(`\\[debug\\] menu průvodce ${n} Průvodce`).test(readLog()); }
      assert.ok(seen, `menu click ${n} happened`);
      w = null;
      for (let i = 0; i < 15; i++) { await wait(1000); w = await wizardShown(); if (w?.card && w.visible) break; }
      console.log(`${n}. otevření:`, JSON.stringify(w), '| proces:', exited ? JSON.stringify(exited) : 'běží');
      assert.ok(!exited, `app still running after click ${n}`);
      assert.ok(w?.card && w.visible, `wizard visible after click ${n}`);
    }
    const errs = readLog().split('\n').filter((l) => /renderer gone|renderer skončil|nezachycen|uncaught|unhandled|preload-error|console\((3|error)\)|TypeError|ReferenceError/i.test(l));
    console.log('chyby v logu:', errs.length); for (const e of errs.slice(0, 8)) console.log('  ', e.slice(0, 300));
    assert.deepStrictEqual(errs, [], 'no errors in the log');
    console.log('app-wizard-menu OK');
  } finally {
    try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {}
    await wait(2500);
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  process.exit(0);
})().catch((e) => { console.error('app-wizard-menu FAILED:', e.message); try { console.error(readLog().split('\n').slice(-25).join('\n').slice(0, 4000)); } catch {} process.exit(1); });
