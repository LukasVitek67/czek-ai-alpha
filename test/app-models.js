// Celá sestavená appka na KOPII stavu uživatele (test/app-replica.js), ovládaná přes CDP jako uživatel:
// hned jak se objeví okno OpenCode, otevře poslední relaci a pak každých 5 s otevře výběr modelu a spočítá
// modely v něm (to, co vidí uživatel). Živě 13. 11.: „No model results“ po startu.
//   node test/app-models.js              běžný start (port 4096 = stejný původ webu jako u uživatele,
//                                        jeho appka musí být zavřená)
//   INDUCE=startup node test/app-models.js
//       plugin OmniRoute jde přes proxy testu (ZDARMA_TEST_PLUGIN_URL), která při startu appky vrací 503
//       (= OmniRoute nestihne odpovědět). Až je výběr modelu prázdný (reprodukce), proxy začne pouštět
//       dotazy dál a test měří, jestli a za jak dlouho se appka zotaví SAMA.
// Výstup: časová osa (s od startu: co ukázal výběr modelu, kolik modelů má server pro složku) + log appky.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { makeReplica, launch } = require('./app-replica');
const cdp = require('./app-cdp');

const OC_PORT = Number(process.env.REPLICA_OC_PORT) || 4096;
const DURATION = Number(process.env.WATCH_S || 200) * 1000;
const INDUCE = process.env.INDUCE || '';

const b64 = (d) => Buffer.from(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// spočítá položky ve výběru modelu (otevře ho, přečte, zavře)
const PICKER_JS = `(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => /Tier ·|modelů|auto\\/|Select model|Flash|GLM|Default model|Big Pickle/i.test(b.innerText) && b.closest('[data-dock-surface], form'))
    || [...document.querySelectorAll('button')].find(b => /Tier ·|modelů|Select model/.test(b.innerText));
  if (!btn) return { button: null };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); // jen .click() výběr neotevře
  await new Promise(r => setTimeout(r, 1500));
  const pop = document.querySelector('[data-slot="model-selector-scroll"]') || document.querySelector('[role="dialog"]');
  const text = pop ? pop.innerText : '';
  const empty = /No model results/i.test(text);
  const items = pop ? Math.max(pop.querySelectorAll('[data-slot="list-item"], [role="option"], li').length, text.split('\\n').filter(l => /·|\\(/.test(l)).length) : 0; // popup v aktuální verzi nemá li/option, položky jsou řádky s „·“ nebo závorkou
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return { button: btn.innerText.slice(0, 40), empty, items };
})()`;

// proxy plugin → OmniRoute; mode 'down' = 503 (OmniRoute „neodpovídá“), 'up' = přeposílá
function startProxy(getTarget) {
  const st = { mode: 'down', hits: { down: 0, up: 0 } };
  const srv = http.createServer((req, res) => {
    const target = getTarget();
    if (st.mode === 'down' || !target) { st.hits.down++; res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"OmniRoute starting"}}'); return; }
    st.hits.up++;
    const u = new URL(req.url, target);
    const up = http.request(u, { method: req.method, headers: { ...req.headers, host: u.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
    req.pipe(up);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ st, srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

(async () => {
  const rep = makeReplica({ ocPort: OC_PORT });
  let omniUrl = '';
  const readOmni = () => {
    if (omniUrl) return omniUrl;
    try { omniUrl = /OmniRoute [\d.]+ běží na (http:\/\/127\.0\.0\.1:\d+)/.exec(fs.readFileSync(path.join(rep.ud, 'zdarma.log'), 'utf8'))[1]; } catch {}
    return omniUrl;
  };
  let proxy = null;
  if (INDUCE === 'startup') {
    proxy = await startProxy(readOmni);
    rep.env.ZDARMA_TEST_PLUGIN_URL = proxy.url;
  }
  const t0 = Date.now();
  const s = () => Math.round((Date.now() - t0) / 1000);
  const child = launch(rep);
  const timeline = [];
  let dir = null;
  let firstOk = 0;
  let lastEmpty = 0;
  let emptySeen = 0;
  let restored = 0;
  let noButton = 0;
  try {
    let ocAt = 0;
    for (let i = 0; i < 300 && !ocAt; i++) {
      const p = await cdp.page(rep.cdpPort, `127.0.0.1:${OC_PORT}`);
      if (p) ocAt = s(); else await wait(1000);
    }
    assert.ok(ocAt, 'OpenCode window did not appear');
    const sessions = await (await fetch(`http://127.0.0.1:${OC_PORT}/session`)).json();
    const last = sessions.sort((a, b) => b.time.updated - a.time.updated)[0];
    dir = last.directory;
    await wait(6000); // web po startu ještě sám přechází na poslední projekt / přenačítá se
    const openLast = () => cdp.evaluate(rep.cdpPort, `127.0.0.1:${OC_PORT}`, `location.href = '/${b64(dir)}/session/${last.id}'; 1`);
    await openLast();
    timeline.push(`${s()} s: okno OpenCode (${ocAt} s), otevřena relace ${last.title} v ${dir}`);
    const end = Date.now() + DURATION;
    while (Date.now() < end) {
      await wait(5000);
      let pick = null;
      try { pick = await cdp.evaluate(rep.cdpPort, `127.0.0.1:${OC_PORT}`, PICKER_JS); } catch (e) { pick = { err: e.message }; }
      let server = '?';
      try {
        const j = await (await fetch(`http://127.0.0.1:${OC_PORT}/config/providers?directory=${encodeURIComponent(dir)}`, { signal: AbortSignal.timeout(20000) })).json();
        const p = (j.providers || []).find((x) => x.id === 'opencode-omniroute');
        server = p ? Object.keys(p.models).length : 0;
      } catch (e) { server = 'err'; }
      // relace se neotevřela (web mezitím přešel jinam) → otevřít znovu; neplatí pro vyvolaný výpadek
      noButton = pick && !pick.button && !pick.err ? noButton + 1 : 0;
      if (noButton === 3 && !INDUCE) { await openLast().catch(() => {}); timeline.push(`${s()} s: relace otevřena znovu`); }
      const ok = !!(pick && pick.button && !pick.empty && pick.items > 0);
      const emptyNow = !!(pick && (pick.empty || (!pick.button && server === 0)));
      if (ok && !firstOk && (!INDUCE || restored)) firstOk = s();
      if (emptyNow) { lastEmpty = s(); emptySeen++; }
      timeline.push(`${s()} s: výběr ${pick?.err ? 'chyba ' + pick.err : !pick?.button ? 'bez tlačítka modelu' : pick.empty ? 'PRÁZDNÝ (No model results)' : pick.items + ' položek'} | server ${server}${proxy ? ` | proxy ${proxy.st.mode}` : ''}`);
      if (INDUCE === 'startup' && !restored && emptySeen >= 2) {
        restored = s();
        proxy.st.mode = 'up';
        timeline.push(`${s()} s: >>> OmniRoute pro plugin zase odpovídá – teď se musí zotavit appka sama`);
      }
      if (INDUCE === 'startup' && !restored && ok && s() - ocAt > 90) { timeline.push('!!! výběr modelu není prázdný ani s nedostupným OmniRoute – nereprodukováno'); break; }
      if (firstOk && s() - firstOk > 20) break; // stabilně funguje
    }
    const log = fs.readFileSync(path.join(rep.ud, 'zdarma.log'), 'utf8').split(/\r?\n/).filter((l) => /\[app\] start|\[omniroute\] (OmniRoute|katalog)|\[opencode\] (instance|výběr|start|restart|hlíd|stránka)/.test(l));
    console.log(timeline.join('\n'));
    console.log('--- log appky\n' + log.map((l) => l.slice(0, 220)).join('\n'));
    if (proxy) console.log(`--- proxy: ${proxy.st.hits.down}× 503, ${proxy.st.hits.up}× přeposláno`);
    if (INDUCE === 'startup') {
      assert.ok(emptySeen >= 2, 'bug not reproduced (picker never empty while OmniRoute was unreachable for the plugin)');
      assert.ok(firstOk, `app did NOT recover by itself within ${Math.round((Date.now() - t0) / 1000) - restored} s after OmniRoute came back`);
      console.log(`app-models INDUCE OK (prázdný výběr reprodukován, OmniRoute zpět v ${restored} s, appka sama zotavena v ${firstOk} s = za ${firstOk - restored} s)`);
    } else {
      assert.ok(firstOk, 'model picker never showed models');
      console.log(`app-models OK (modely ve výběru od ${firstOk} s${lastEmpty ? `, prázdný naposledy v ${lastEmpty} s` : ', ani jednou prázdný'})`);
    }
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    if (proxy) proxy.srv.close();
    setTimeout(() => { try { fs.rmSync(rep.base, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
