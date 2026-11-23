// CELÁ appka ze zdrojáků (skrytě, dočasný profil, Linux i Windows): start s OmniRoute až po kontrolu zdraví čela
// tierů. Chytá chyby v src/main.js, které testy jednotlivých modulů nevidí (22. 11.: větev smyčky volala
// neexistující omniSyncPromise → start OmniRoute by spadl).
//   OPENCODE_BIN=<opencode> ZDARMA_OMNIROUTE_ROOT=<omniroute> node test/app-omni-start.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./app-cdp');
const CDP = Number(process.env.OMNISTART_CDP_PORT) || 9355;

const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-omnistart-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const ud = x('userdata');
let keys = {};
try { keys = require('../private/keys.json').providers || {}; } catch {}
// klíče jen pro start (bez nich nejsou tierlisty a kontrola zdraví nemá co kontrolovat); nikde se nevypisují
const providers = Object.fromEntries(Object.entries(keys).map(([id, k]) => [id, { enabled: true, key: k }]));
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'omniroute', lang: 'cs', providers, wizardDone: true }));
const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: String(Number(process.env.OMNISTART_OC_PORT) || 4437), ZDARMA_HIDDEN: '1',
  // okno nastavení (skryté) kvůli zkoušce appky z průvodce klíči přes hlavní cestu (OmniRoute + závod)
  ZDARMA_DEBUG_OPEN: 'settings' };
delete env.OPENCODE_CONFIG_DIR;

(async () => {
  const child = spawn(require('electron'), ['.', '--password-store=basic', `--remote-debugging-port=${CDP}`], { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' });
  const logFile = () => { for (const f of ['zdarma.log', 'czek-ai.log']) { const p = path.join(ud, f); if (fs.existsSync(p)) return p; } return null; };
  let log = '', probed = null;
  try {
    for (let i = 0; i < 300 && !probed; i++) {
      await wait(1000);
      const f = logFile(); if (!f) continue;
      log = fs.readFileSync(f, 'utf8');
      probed = /kontrola zdraví: (\d+) modelů z čela tierů/.exec(log);
    }
    // „400 i po druhém pokusu“ = diagnostika s tělem odpovědi modelu (0.15.41), ne chyba main.js
    const errs = log.split('\n').filter((l) => !/400 i po druhém pokusu/.test(l)).filter((l) => /ReferenceError|TypeError|nezachycen|is not defined|kontrola zdraví: .*(Error|selhal)|\[omniroute\] (sync|rebalance): .*(Error|chyba|selhal|failed)/i.test(l));
    console.log('kontrola zdraví:', probed ? probed[0] : 'nenalezeno', '| chyby:', errs.length);
    for (const e of errs.slice(0, 5)) console.log('  ', e.replace(/(sk-or-v1-|nvapi-|gsk_|AIza|hf_|ghp_)[A-Za-z0-9_-]+/g, '$1***').slice(0, 200));
    assert.ok(probed, 'health check of tier heads ran after OmniRoute start');
    assert.ok(Number(probed[1]) > 0, 'health check probed > 0 models (tier lists were built)');
    assert.deepStrictEqual(errs, [], 'no errors from main.js during OmniRoute start');
    // zkouška appky z průvodce klíči: dotaz jde OmniRoute + závodem na combo tieru Max (stejně jako agent)
    let sm = null;
    for (let i = 0; i < 60 && !sm; i++) {
      await wait(1000);
      sm = await cdp.evaluate(CDP, 'index.html', `(() => { if (!document.querySelector('#wizCard')) return null; showPage('wizard'); wiz.i = WIZARD.STEPS.length; renderWizard(); const b = document.querySelector('#wizSmoke'); if (!b) return { noButton: true }; b.click(); return { clicked: true }; })()`).catch(() => null);
    }
    assert.ok(sm?.clicked, 'smoke button on the wizard summary: ' + JSON.stringify(sm));
    let out = null;
    for (let i = 0; i < 100 && !out; i++) {
      await wait(1000);
      out = await cdp.evaluate(CDP, 'index.html', `(() => { const o = document.querySelector('#wizSmokeOut'); return o && /ok|bad/.test(o.className) ? { cls: o.className, text: o.textContent } : null; })()`).catch(() => null);
    }
    console.log('zkouška appky (OmniRoute + závod):', JSON.stringify(out));
    assert.ok(out && /ok/.test(out.cls), 'smoke test through OmniRoute + race answered');
    const via = /\[průvodce\] zkouška appky: (\S+)/.exec(fs.readFileSync(logFile(), 'utf8'));
    assert.strictEqual(via && via[1], 'omniroute', 'smoke went through OmniRoute (not the fallback proxy)');
    // lehký benchmark z konce průvodce (tlačítko „Zkontrolovat modely“): jeden drobný dotaz na čelo každého tieru
    const clicked = await cdp.evaluate(CDP, 'index.html', `(() => { const b = document.querySelector('#wizBenchRun'); if (!b) return false; b.click(); return true; })()`).catch(() => false);
    assert.ok(clicked, 'benchmark offer shown at the end of the key guide');
    let bench = null;
    for (let i = 0; i < 120 && !bench; i++) {
      await wait(1000);
      bench = await cdp.evaluate(CDP, 'index.html', `(() => { const o = document.querySelector('#wizBenchOut'); return o && /ok|bad/.test(o.className) ? { cls: o.className, text: o.textContent } : null; })()`).catch(() => null);
    }
    const benchLog = /\[benchmark\] modely: (\{.*\})/.exec(fs.readFileSync(logFile(), 'utf8'));
    console.log('benchmark:', JSON.stringify(bench), benchLog ? benchLog[1] : '');
    assert.ok(bench && /ok/.test(bench.cls), 'benchmark finished with working models');
    const bj = benchLog ? JSON.parse(benchLog[1]) : {};
    assert.ok(bj.probed > 0 && bj.probed <= 60, 'benchmark probed a bounded number of models: ' + bj.probed);
    // ZDARMA_SHARE_URL (+ ZDARMA_PUBLIC_TIER_MS=15000): veřejný tierlist – appka sama pošle souhrn skutečných volání
    // (site/dev-server.js nebo nasazené API) a stáhne veřejný souhrn (src/publicTier.js)
    if (env.ZDARMA_SHARE_URL) {
      let sent = null;
      for (let i = 0; i < 150 && !sent; i++) { await wait(1000); sent = /\[tierlist\] odesláno (\d+) modelů, (\d+) volání/.exec(fs.readFileSync(logFile(), 'utf8')); }
      console.log('veřejný tierlist:', (fs.readFileSync(logFile(), 'utf8').match(/\[tierlist\][^\n]*/g) || []).slice(-3).join(' | ') || 'nic');
      assert.ok(sent && Number(sent[1]) > 0, 'app sent a model summary to the tier list API');
    }
    console.log('app-omni-start OK');
  } finally {
    try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {}
    await wait(3000);
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  process.exit(0);
})().catch((e) => { console.error('app-omni-start FAILED:', e.message); process.exit(1); });
