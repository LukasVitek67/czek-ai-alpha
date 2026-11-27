// CELÁ appka: prázdné okno OpenCode (uživatel 27. 11.: „neloaduje ui“ – po probuzení PC zůstal web bílý). Obsah stránky
// vyprázdníme → po 12 s stav „OpenCode se načítá…“ s tlačítky; „Načíst znovu“ vrátí obsah; bez zásahu po 45 s sama obnova;
// „Restartovat OpenCode“ restartuje server (nový proces) a okno se načte. Skrytě, dočasný profil, vlastní porty.
//   OPENCODE_BIN=<opencode> node test/app-blank.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const cdp = require('./app-cdp');

const CDP = 9379, OC_PORT = 4469;
const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-blank-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const ud = x('userdata'); const proj = x('proj');
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'zdarma', lang: 'cs', providers: {}, wizardDone: true, lastCwd: proj }));
const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'), ZDARMA_OC_PORT: String(OC_PORT), ZDARMA_BRIDGE_PORT: '4470', ZDARMA_HIDDEN: '1' };
delete env.OPENCODE_CONFIG_DIR;
const P = `127.0.0.1:${OC_PORT}`;
const ev = (js) => Promise.race([cdp.evaluate(CDP, P, js), wait(6000).then(() => null)]).catch(() => null);
const readLog = () => { const p = path.join(ud, 'zdarma.log'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
const ocPid = () => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -like '*--port ${OC_PORT}*' } | Select-Object -First 1).ProcessId`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
// viditelný obsah OpenCode (bez prvků czek-ai); skryté okno testu se nerozkresluje → checkVisibility místo innerText
const blankState = () => ev(`({ text: [...document.querySelectorAll('body *')].filter((e) => e.childElementCount === 0 && !e.closest('[data-czek-video],[data-czek-teacher],[data-czek-blank],noscript,script,style') && e.checkVisibility({ checkVisibilityCSS: true })).reduce((a, e) => a + (e.textContent || '').trim().length, 0), card: document.querySelector('[data-czek-blank] .cb-title')?.textContent || null })`);
// „bílá stránka“: obsah OpenCode skrýt (mazání by OpenCode hned vykreslil znovu); prvky czek-ai nechat
// opakovaně (OpenCode si kořen vykresluje znovu); nové načtení stránky interval zruší
const emptyPage = () => ev(`(() => { const s = document.createElement('style'); s.textContent = 'body > *:not([data-czek-video]):not([data-czek-teacher]):not([data-czek-upgrade]):not([data-czek-blank]):not(script):not(style):not(noscript){display:none!important}'; document.head.append(s); return document.body.innerText.length; })()`);

(async () => {
  const app = spawn(require('electron'), ['.', '--password-store=basic', `--remote-debugging-port=${CDP}`], { cwd: root, env, stdio: 'ignore' });
  try {
    let st = null;
    for (let i = 0; i < 180; i++) { await wait(1000); st = await blankState(); if (st?.text > 20) break; }
    assert.ok(st?.text > 20, 'okno OpenCode s obsahem');
    // po startu czek-ai okno ještě přepíná rozvržení / otevírá projekt (přenačtení) → počkat, až se URL ustálí
    let lastUrl = '', stable = 0;
    for (let i = 0; i < 90 && stable < 12; i++) { await wait(1000); const u = await ev('location.href'); if (u && u === lastUrl) stable++; else { stable = 0; lastUrl = u; } }
    await wait(3000);
    const pid1 = ocPid();
    // 1) prázdná stránka → stav po 12 s → „Načíst znovu“
    console.log('vyprázdnění:', JSON.stringify(await emptyPage()), JSON.stringify(await blankState()), JSON.stringify(await ev('location.href')));
    for (let i = 0; i < 20 && !st?.card; i++) { await wait(1000); st = await blankState(); }
    console.log('stav:', JSON.stringify(st));
    if (!st?.card) console.log('podmínky:', JSON.stringify(await ev(`(() => { const pb = document.querySelector('[aria-label="Prompt"], form [contenteditable="true"]'); const OWN = 'script,style,noscript,[data-czek-blank],[data-czek-video],[data-czek-upgrade],[data-czek-teacher],dialog[data-czek-cpe]'; const parts = [...document.body.children].filter((c) => !c.matches(OWN)).map((c) => c.tagName + ':' + (c.innerText || '').replace(/\\s+/g, '').length); return { prompt: !!pb, promptVisible: !!(pb && pb.getClientRects().length), parts, body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200), own: [...document.body.querySelectorAll(OWN)].map((o) => o.tagName + ':' + o.getClientRects().length + ':' + (o.innerText || '').replace(/\\s+/g, '').length), err: window.__czekErr || null }; })()`)));
    if (!st?.card) console.log('zbylo:', JSON.stringify(await ev(`[...document.body.children].map((c) => c.tagName + '.' + String(c.className).slice(0, 30) + [...c.attributes].filter((a) => a.name.startsWith('data-')).map((a) => '[' + a.name + ']').join('') + ' = ' + (c.innerText || '').slice(0, 60)).join(' || ')`)));
    assert.match(st?.card || '', /OpenCode se načítá… 1\d s/, 'stav po ~12 s');
    await wait(3000);
    const still = await blankState();
    assert.match(still?.card || '', /OpenCode se načítá… 1\d s/, 'stav zůstává (nebliká)');
    await ev(`[...document.querySelectorAll('[data-czek-blank] button')].find((b) => /Načíst znovu/.test(b.textContent)).click()`);
    for (let i = 0; i < 60; i++) { await wait(1000); st = await blankState(); if (st?.text > 20 && !st.card) break; }
    assert.ok(st?.text > 20 && !st.card, 'po „Načíst znovu“ obsah zpět');
    assert.match(readLog(), /uživatel: znovu načíst prázdné okno/);
    // 2) bez zásahu → automatická obnova po 45 s
    await emptyPage();
    const t0 = Date.now();
    for (let i = 0; i < 90; i++) { await wait(1000); if (/prázdné okno → prázdná stránka \d+ s → znovu načíst stránku/.test(readLog())) break; }
    const auto = /prázdné okno → prázdná stránka \d+ s → znovu načíst stránku/.test(readLog());
    console.log(`automatická obnova: ${auto} (${Math.round((Date.now() - t0) / 1000)} s)`);
    assert.ok(auto, 'automatická obnova po ~45 s');
    for (let i = 0; i < 60; i++) { await wait(1000); st = await blankState(); if (st?.text > 20) break; }
    assert.ok(st?.text > 20, 'obsah zpět po automatické obnově');
    // 3) „Restartovat OpenCode“ → nový proces serveru, okno s obsahem
    await emptyPage();
    for (let i = 0; i < 20 && !st?.card; i++) { await wait(1000); st = await blankState(); }
    await ev(`[...document.querySelectorAll('[data-czek-blank] button')].find((b) => /Restartovat OpenCode/.test(b.textContent)).click()`);
    let pid2 = '';
    for (let i = 0; i < 120; i++) { await wait(1000); st = await blankState(); pid2 = ocPid(); if (st?.text > 20 && pid2 && pid2 !== pid1) break; }
    console.log('server OpenCode:', pid1, '→', pid2);
    assert.ok(pid2 && pid2 !== pid1, 'server OpenCode restartovaný (nový proces)');
    assert.ok(st?.text > 20, 'po restartu obsah');
    const errs = readLog().split('\n').filter((l) => /nezachycen|TypeError|ReferenceError|preload-error/i.test(l));
    assert.deepStrictEqual(errs, [], 'žádné chyby');
    console.log('app-blank OK (stav po 12 s, Načíst znovu, automatická obnova po 45 s, restart OpenCode)');
  } finally {
    try { execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
