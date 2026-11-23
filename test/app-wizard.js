// Průvodce klíči v CELÉ appce (ze zdrojáků, skrytě, čistý dočasný profil bez klíčů), přes CDP jako uživatel:
//  1) appka bez klíčů otevře průvodce sama, začne krokem 1 (NVIDIA) s odkazem a postupem;
//  2) vložený klíč se uloží a hned ověří dotazem na model; falešný klíč → hláška „zkouška selhala“, krok ukazuje
//     uložený klíč a tlačítko „Další“; klíč je v settings.json zašifrovaný (ne čitelný text);
//  3) „Přeskočit“ až na konec → souhrn podle počtu klíčů → „Hotovo“ zapíše wizardDone a okno zavře;
//  4) druhý start s wizardDone průvodce neotevře.
//   OPENCODE_BIN=<cesta k opencode> node test/app-wizard.js   (Linux i Windows; ZDARMA_SKIP_NET=1 bez sítě)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./app-cdp');

const root = path.join(__dirname, '..');
const CDP = Number(process.env.WIZ_CDP_PORT) || 9353;
const OC_PORT = Number(process.env.WIZ_OC_PORT) || 4433;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = 'nvapi-' + 'x'.repeat(40); // falešný klíč ve formátu NVIDIA (žádný skutečný)

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-wizard-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const ud = x('userdata');
// router 'zdarma' = bez OmniRoute (test je o okně průvodce, ne o směrování)
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'zdarma', lang: 'cs', providers: {} }));
const env = {
  ...process.env,
  ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: String(OC_PORT), ZDARMA_HIDDEN: '1', ZDARMA_WIZARD: '1',
};
delete env.OPENCODE_CONFIG_DIR;

function launch() {
  // --password-store=basic: na Linuxu bez klíčenky systému (žádný dialog odemknutí)
  const args = ['.', `--remote-debugging-port=${CDP}`, '--password-store=basic'];
  // vlastní skupina procesů: kill(-pid) ukončí i server OpenCode, který appka spustila (jinak zůstane viset
  // a zdědí zásuvku CDP, další běh testu pak na ní čeká donekonečna)
  return spawn(require('electron'), args, { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' });
}
const kill = async (c) => {
  const sig = (s) => { try { if (process.platform === 'win32') c.kill(s); else process.kill(-c.pid, s); } catch {} };
  sig('SIGTERM'); await wait(2500); sig('SIGKILL'); await wait(500);
};
const isWiz = async () => !!(await cdp.page(CDP, 'index.html').catch(() => null));
const ev = (js) => cdp.evaluate(CDP, 'index.html', js);

(async () => {
  let child = launch();
  const res = {};
  try {
    // 1) průvodce se otevře sám (po startu OpenCode)
    let page = null;
    for (let i = 0; i < 180 && !page; i++) { page = await cdp.page(CDP, 'index.html').catch(() => null); if (!page) await wait(1000); }
    assert.ok(page, 'the key guide window did not open on a profile without keys');
    let st = null;
    for (let i = 0; i < 30; i++) {
      st = await ev(`(() => { const c = document.querySelector('#wizCard'); const pg = document.querySelector('.page[data-page="wizard"]'); return c && !pg.hidden && c.textContent ? { step: c.querySelector('.top').textContent, how: c.querySelectorAll('.wiz-how li').length, dots: document.querySelectorAll('#wizDots li').length, progress: document.querySelector('#wizProgress').textContent, open: !![...c.querySelectorAll('button')].find(b => /Otevřít stránku/.test(b.textContent)) } : null; })()`).catch(() => null);
      if (st) break;
      await wait(1000);
    }
    console.log('krok 1:', JSON.stringify(st));
    assert.ok(st, 'wizard page visible');
    assert.match(st.step, /Krok 1 z 7/);
    assert.match(st.step, /NVIDIA/);
    assert.strictEqual(st.how, 3, 'three how-to steps');
    assert.strictEqual(st.dots, 7, 'seven providers in the guide');
    assert.match(st.progress, /0 z 7/);
    assert.ok(st.open, 'button that opens the sign-up page');
    res.opened = true;

    // 2) vložit falešný klíč → uložit a ověřit
    await ev(`(() => { const i = document.querySelector('#wizKey'); i.value = ${JSON.stringify(FAKE)}; [...document.querySelectorAll('#wizCard button')].find(b => /Uložit a ověřit/.test(b.textContent)).click(); return 1; })()`);
    let after = null;
    for (let i = 0; i < 60; i++) {
      await wait(1000);
      after = await ev(`(() => { const r = document.querySelector('#wizCard .test'); return r && /ok|bad/.test(r.className) ? { cls: r.className, text: r.textContent, saved: !!document.querySelector('#wizCard .state.ok'), next: document.querySelector('#wizNext').textContent, progress: document.querySelector('#wizProgress').textContent } : null; })()`);
      if (after) break;
    }
    console.log('po vložení:', JSON.stringify(after));
    assert.ok(after, 'test result shown');
    assert.match(after.cls, /bad/, 'fake key → test fails');
    assert.match(after.text, /zkouška selhala/);
    assert.ok(after.saved, 'key shown as saved');
    assert.strictEqual(after.next, 'Další', 'skip button becomes Next once a key is saved');
    assert.match(after.progress, /1 z 7/);
    const saved = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
    assert.ok(saved.providers.nvidia?.key, 'key stored in settings.json');
    // šifruje safeStorage (Windows DPAPI); na Linuxu s --password-store=basic appka ukládá bez šifrování (stávající chování)
    if (process.platform === 'win32') assert.ok(!JSON.stringify(saved).includes(FAKE), 'key is not stored as plain text');
    res.keySaved = true;

    // 2a) co student skutečně vloží (src/wizard.js cleanKey/ownerOf/notKey): odkaz → odmítnout bez uložení;
    //     „Bearer <klíč OpenRouter>“ v kroku NVIDIA → uložit k OpenRouter (ne k NVIDIA) a říct to
    const paste = (v) => ev(`(() => { const i = document.querySelector('#wizKey'); i.value = ${JSON.stringify(v)}; [...document.querySelectorAll('#wizCard button')].find(b => /Uložit a ověřit/.test(b.textContent)).click(); return 1; })()`);
    await paste('https://build.nvidia.com/settings/api-keys');
    await wait(300);
    const link = await ev(`(() => { const r = document.querySelector('#wizCard .test'); return { cls: r.className, text: r.textContent, progress: document.querySelector('#wizProgress').textContent }; })()`);
    console.log('odkaz:', JSON.stringify(link));
    assert.match(link.text, /odkaz, ne klíč/, 'a pasted link is refused');
    assert.match(link.progress, /1 z 7/, 'nothing saved for a link');
    const FAKE_OR = 'sk-' + 'or-v1-' + 'y'.repeat(40);
    await paste(`Bearer ${FAKE_OR}`);
    let moved = null;
    for (let i = 0; i < 60; i++) {
      await wait(1000);
      moved = await ev(`(() => { const r = document.querySelector('#wizCard .test'); return r && /ok|bad/.test(r.className) && /OpenRouter/.test(r.textContent) ? { text: r.textContent, progress: document.querySelector('#wizProgress').textContent, orDot: /✓/.test([...document.querySelectorAll('#wizDots li')][1].textContent) } : null; })()`);
      if (moved) break;
    }
    console.log('klíč jiné služby:', JSON.stringify(moved));
    assert.ok(moved, 'misplaced key result shown');
    assert.match(moved.text, /klíč pro OpenRouter/, 'tells the student where the key went');
    assert.match(moved.progress, /2 z 7/, 'counted under OpenRouter');
    assert.ok(moved.orDot, 'OpenRouter step ticked');
    res.misplacedKey = true;

    // 2b) skutečný klíč (WIZ_REAL=1, z private/keys.json, nikde se nevypisuje) → „Klíč funguje“
    if (process.env.WIZ_REAL === '1') {
      const real = JSON.parse(fs.readFileSync(path.join(root, 'private/keys.json'), 'utf8')).providers.nvidia;
      const k = typeof real === 'string' ? real : real?.key;
      assert.ok(k, 'nvidia key in private/keys.json');
      await ev(`(() => { const i = document.querySelector('#wizKey'); i.value = ${JSON.stringify(k)}; [...document.querySelectorAll('#wizCard button')].find(b => /Uložit a ověřit/.test(b.textContent)).click(); return 1; })()`);
      let ok = null;
      for (let i = 0; i < 90; i++) {
        await wait(1000);
        ok = await ev(`(() => { const r = document.querySelector('#wizCard .test'); return r && /ok|bad/.test(r.className) ? { cls: r.className, text: r.textContent.replace(/nvapi-\\S+/g, 'nvapi-***') } : null; })()`);
        if (ok) break;
      }
      console.log('skutečný klíč:', JSON.stringify(ok));
      assert.ok(ok && /ok/.test(ok.cls), 'real NVIDIA key → works');
      res.realKey = true;
    }

    // 3) přeskočit až na konec → Hotovo
    for (let i = 0; i < 7; i++) { await ev(`document.querySelector('#wizNext').click(); 1`); await wait(150); }
    const done = await ev(`(() => { const c = document.querySelector('#wizCard'); return { text: c.textContent, fin: !!document.querySelector('#wizFinish') }; })()`);
    console.log('konec:', done.text.slice(0, 160));
    assert.ok(done.fin, 'finish button');
    assert.match(done.text, /2 z doporučených 3/, 'summary counts both saved keys');
    // 3b) se skutečným klíčem: „Vyzkoušet, že appka funguje“ = skutečný dotaz cestou agenta (tady záložní proxy)
    if (process.env.WIZ_REAL === '1') {
      await ev(`document.querySelector('#wizSmoke').click(); 1`);
      let sm = null;
      for (let i = 0; i < 100; i++) {
        await wait(1000);
        sm = await ev(`(() => { const o = document.querySelector('#wizSmokeOut'); return o && /ok|bad/.test(o.className) ? { cls: o.className, text: o.textContent } : null; })()`);
        if (sm) break;
      }
      console.log('zkouška appky:', JSON.stringify(sm));
      assert.ok(sm && /ok/.test(sm.cls), 'smoke test through the app path answered');
      res.smoke = true;
    }
    await ev(`document.querySelector('#wizFinish').click(); 1`);
    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) { await wait(500); closed = !(await isWiz()); }
    const s2 = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
    assert.strictEqual(s2.wizardDone, true, 'wizardDone saved');
    assert.ok(closed, 'guide window closed after Done');
    res.finished = true;
  } finally { await kill(child); }

  // 4) druhý start: wizardDone → průvodce se neotevře (OpenCode ano)
  child = launch();
  try {
    let oc = null;
    for (let i = 0; i < 180 && !oc; i++) { oc = await cdp.page(CDP, `127.0.0.1:${OC_PORT}`).catch(() => null); if (!oc) await wait(1000); }
    assert.ok(oc, 'OpenCode window on second start');
    await wait(5000);
    assert.ok(!(await isWiz()), 'guide does not open again after Done');
    res.secondStart = true;
  } finally { await kill(child); }
  console.log('app-wizard OK', JSON.stringify(res));
  process.exit(0);
})().catch((e) => { console.error('app-wizard FAILED:', e.message); process.exit(1); });
