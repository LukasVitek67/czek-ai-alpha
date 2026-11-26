// CELÁ appka ze zdrojáků (skrytě, dočasný profil i pracovní složka): nová relace v okně OpenCode ukáže výběr presetu
// místo loga, klik na „Oprava chyby“ přepne nativního agenta OpenCode na bugfix, ruční přepnutí agenta v liště promptu
// (nativní menu) výběr srovná, v logu žádné chyby. Snímek: docs/research/2026-11-26-presets/app-presets.png.
//   OPENCODE_BIN=<opencode> node test/app-presets.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./app-cdp');

const CDP = Number(process.env.PRESETS_CDP_PORT) || 9365;
const OC_PORT = Number(process.env.PRESETS_OC_PORT) || 4451;
const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-apppresets-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const ud = x('userdata');
const proj = x('proj');
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'zdarma', lang: 'cs', providers: {}, wizardDone: true, lastCwd: proj }));
const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: String(OC_PORT), ZDARMA_HIDDEN: '1', ZDARMA_DEBUG: '1' };
delete env.OPENCODE_CONFIG_DIR;
const OC = `127.0.0.1:${OC_PORT}`;
// každé CDP volání s limitem: během načítání stránky (dlouhý iframe) se Runtime.evaluate umí zaseknout
const ev = (expr) => Promise.race([cdp.evaluate(CDP, OC, expr), wait(8000).then(() => ({ err: 'cdp timeout' }))]).catch((e) => ({ err: e.message }));
const readLog = () => { for (const f of ['zdarma.log', 'czek-ai.log']) { const p = path.join(ud, f); if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } return ''; };
const state = () => ev(`(() => {
  const h = document.querySelector('[data-czek-presets]');
  const opts = h ? [...h.querySelectorAll('.cp-opt')] : [];
  const trig = [...document.querySelectorAll('form button[aria-haspopup]')].find((b) => /^(build|plan|web-design|web-app|backend|bugfix|game-3d|school|refactor)$/.test(b.textContent.trim().toLowerCase()));
  const svg = [...document.querySelectorAll('svg')].find((s) => s.getBoundingClientRect().width > 200);
  return { path: location.pathname, picker: !!h, options: opts.map((o) => o.dataset.agent), checked: opts.filter((o) => o.getAttribute('aria-checked') === 'true').map((o) => o.dataset.agent),
    agent: trig ? trig.textContent.trim().toLowerCase() : null, status: h ? h.querySelector('.cp-status').textContent : null, bigLogoVisible: !!(svg && svg.getBoundingClientRect().height > 0) };
})()`);

(async () => {
  const child = spawn(require('electron'), ['.', '--password-store=basic', `--remote-debugging-port=${CDP}`], { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' });
  let exited = null;
  child.on('exit', (c, s) => { exited = { c, s }; });
  try {
    // okno OpenCode → nová relace (draft); když appka otevře jinou stránku, jdeme do nové relace složky projektu
    let s = null;
    for (let i = 0; i < 240; i++) {
      await wait(1000);
      if (exited) break;
      s = await state();
      if (s?.picker && s.agent) break;
      if (i >= 30 && s && !s.err && s.path && !s.path.includes('new-session') && i % 15 === 0) {
        await ev(`location.href = '/' + btoa(unescape(encodeURIComponent(${JSON.stringify(proj)}))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') + '/session'`);
      }
    }
    console.log('nová relace:', JSON.stringify(s));
    assert.ok(!exited, 'appka běží');
    assert.ok(s?.picker, 'výběr presetu v nové relaci');
    assert.deepStrictEqual(s.options, ['web-design', 'web-app', 'backend', 'bugfix', 'game-3d', 'school', 'refactor', 'build'], '8 voleb v pořadí presets.json');
    assert.ok(!s.bigLogoVisible, 'logo OpenCode místo výběru skryté');
    assert.deepStrictEqual(s.checked, [s.agent], 'vybraná volba = aktuální agent OpenCode');
    // klik na „Oprava chyby“ → nativní agent bugfix
    await ev(`document.querySelector('[data-czek-presets] .cp-opt[data-agent="bugfix"]').click()`);
    for (let i = 0; i < 20; i++) { await wait(250); s = await state(); if (s.agent === 'bugfix') break; }
    console.log('po kliku:', JSON.stringify({ agent: s.agent, checked: s.checked, status: s.status }));
    assert.strictEqual(s.agent, 'bugfix', 'nativní agent OpenCode přepnutý na bugfix');
    assert.deepStrictEqual(s.checked, ['bugfix']);
    assert.match(s.status, /bugfix · 4 skills/, 'stavový řádek: aktivní agent a počet skills');
    // ruční přepnutí v liště promptu (nativní menu) → výběr se srovná
    await ev(`(async () => {
      const ptr = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true };
      const t = [...document.querySelectorAll('form button[aria-haspopup]')].find((b) => b.textContent.trim().toLowerCase() === 'bugfix');
      t.dispatchEvent(new PointerEvent('pointerdown', ptr)); t.click();
      let it = null; for (let i = 0; i < 25 && !it; i++) { await new Promise((r) => setTimeout(r, 40)); it = [...document.querySelectorAll('[role="menuitemradio"]')].find((m) => m.textContent.trim().toLowerCase() === 'web-design'); }
      it.dispatchEvent(new PointerEvent('pointermove', ptr)); it.dispatchEvent(new PointerEvent('pointerenter', { ...ptr, bubbles: false }));
      await new Promise((r) => setTimeout(r, 30));
      for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) it.dispatchEvent(new (k.startsWith('pointer') ? PointerEvent : MouseEvent)(k, ptr));
      it.click();
    })()`);
    for (let i = 0; i < 20; i++) { await wait(250); s = await state(); if (s.checked[0] === 'web-design') break; }
    console.log('ruční přepnutí:', JSON.stringify({ agent: s.agent, checked: s.checked, status: s.status }));
    assert.strictEqual(s.agent, 'web-design');
    assert.deepStrictEqual(s.checked, ['web-design'], 'výběr následuje nativního agenta');
    const out = path.join(root, 'docs', 'research', '2026-11-26-presets');
    fs.mkdirSync(out, { recursive: true });
    await cdp.shot(CDP, OC, path.join(out, 'app-presets.png')).catch((e) => console.log('snímek nevyšel:', e.message));
    // regrese 26. 11.: iframe videa (YouTube) se src nastaveným před „load“ zdržel načtení okna OpenCode o ~5 min
    const lg = readLog();
    const at = (re) => { const m = re.exec(lg); return m ? Date.parse(m[1]) : null; };
    const ready = at(/^(\S+) \[opencode\] dom-ready http:\/\/127\.0\.0\.1:\d+\//m);
    const fin = at(/^(\S+) \[opencode\] did-finish-load http:\/\/127\.0\.0\.1:\d+\//m);
    console.log('okno OpenCode: load', ready && fin ? `${fin - ready} ms po dom-ready` : 'neměřeno');
    if (ready && fin) assert.ok(fin - ready < 60000, 'video (iframe) nezdržuje načtení okna OpenCode');
    const errs = readLog().split('\n').filter((l) => /renderer gone|renderer skončil|nezachycen|uncaught|unhandled|preload-error|console\((3|error)\)|TypeError|ReferenceError/i.test(l));
    console.log('chyby v logu:', errs.length); for (const e of errs.slice(0, 8)) console.log('  ', e.slice(0, 300));
    assert.deepStrictEqual(errs, [], 'žádné chyby v logu');
    console.log('app-presets OK');
  } finally {
    try { if (process.platform === 'win32') require('child_process').execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-child.pid, 'SIGTERM'); } catch {}
    await wait(2500);
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {}
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 500);
  }
  process.exit(0);
})().catch((e) => { console.error('app-presets FAILED:', e.message); try { console.error(readLog().split('\n').slice(-25).join('\n').slice(0, 4000)); } catch {} process.exit(1); });
