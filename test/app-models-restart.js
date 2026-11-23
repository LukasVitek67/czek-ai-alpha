// Celá appka na kopii stavu uživatele, dva starty po sobě:
//  1) OmniRoute pro plugin odpovídá → výběr modelu má modely, plugin si uloží diskovou cache katalogu;
//  2) appka zavřená a spuštěná znovu, OmniRoute pro plugin celou dobu NEODPOVÍDÁ (503).
// Do 0.15.7 czek-ai diskovou cache při každém startu mazala → 2. start bez modelů („No model results“).
// Teď musí výběr ukázat modely z cache hned.  node test/app-models-restart.js  (~6 min, port 4096)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { makeReplica, launch } = require('./app-replica');
const cdp = require('./app-cdp');

const OC_PORT = Number(process.env.REPLICA_OC_PORT) || 4096;
const b64 = (d) => Buffer.from(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PICKER_JS = `(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => /Tier ·|modelů|Select model/.test(b.innerText));
  if (!btn) return { button: null };
  btn.click();
  await new Promise(r => setTimeout(r, 1500));
  const pop = document.querySelector('[data-slot="model-selector-scroll"]') || document.querySelector('[role="dialog"]');
  const text = pop ? pop.innerText : '';
  const items = pop ? pop.querySelectorAll('[data-slot="list-item"], [role="option"], li').length : 0;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return { button: btn.innerText.slice(0, 40), empty: /No model results/i.test(text), items };
})()`;

function proxyServer(getTarget) {
  const st = { mode: 'up', down: 0, up: 0 };
  const srv = http.createServer((req, res) => {
    const target = getTarget();
    if (st.mode === 'down' || !target) { st.down++; res.writeHead(503); res.end('{"error":{"message":"starting"}}'); return; }
    st.up++;
    const u = new URL(req.url, target);
    const up = http.request(u, { method: req.method, headers: { ...req.headers, host: u.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
    req.pipe(up);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ st, srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function run(rep, label, maxS) {
  const t0 = Date.now();
  const s = () => Math.round((Date.now() - t0) / 1000);
  const child = launch(rep);
  const out = { label, firstOk: 0, emptySeen: 0, lines: [] };
  try {
    let ocAt = 0;
    for (let i = 0; i < 300 && !ocAt; i++) { if (await cdp.page(rep.cdpPort, `127.0.0.1:${OC_PORT}`)) ocAt = s(); else await wait(1000); }
    assert.ok(ocAt, label + ': OpenCode window did not appear');
    const sessions = await (await fetch(`http://127.0.0.1:${OC_PORT}/session`)).json();
    const last = sessions.sort((a, b) => b.time.updated - a.time.updated)[0];
    await cdp.evaluate(rep.cdpPort, `127.0.0.1:${OC_PORT}`, `location.href = '/${b64(last.directory)}/session/${last.id}'; 1`);
    out.lines.push(`${label} ${s()} s: okno (${ocAt} s), relace otevřena`);
    while (s() < maxS) {
      await wait(5000);
      let pick;
      try { pick = await cdp.evaluate(rep.cdpPort, `127.0.0.1:${OC_PORT}`, PICKER_JS); } catch (e) { pick = { err: e.message }; }
      const ok = !!(pick && pick.button && !pick.empty && pick.items > 0);
      if (pick && (pick.empty || !pick.button)) out.emptySeen++;
      out.lines.push(`${label} ${s()} s: výběr ${pick?.err ? 'chyba' : !pick?.button ? 'bez tlačítka modelu' : pick.empty ? 'PRÁZDNÝ' : pick.items + ' položek'}`);
      if (ok) { out.firstOk = s(); break; }
    }
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await wait(4000);
  }
  return out;
}

(async () => {
  const rep = makeReplica({ ocPort: OC_PORT });
  let omniUrl = '';
  const readOmni = () => {
    try { omniUrl = /OmniRoute [\d.]+ běží na (http:\/\/127\.0\.0\.1:\d+)/g.exec(fs.readFileSync(path.join(rep.ud, 'zdarma.log'), 'utf8').split('[app] start').pop())[1]; } catch {}
    return omniUrl;
  };
  const proxy = await proxyServer(readOmni);
  rep.env.ZDARMA_TEST_PLUGIN_URL = proxy.url;
  try {
    const a = await run(rep, '1. start', 300);
    const snap = path.join(rep.base, 'data', 'opencode', 'plugins');
    const files = fs.existsSync(snap) ? fs.readdirSync(snap) : [];
    proxy.st.mode = 'down';
    const b = await run(rep, '2. start (OmniRoute pro plugin nedostupný)', 240);
    console.log([...a.lines, `--- disková cache pluginu po 1. startu: ${files.join(', ') || '(nic)'}`, ...b.lines].join('\n'));
    assert.ok(a.firstOk, '1st start never showed models');
    assert.ok(files.some((f) => /^omniroute-/.test(f)), 'plugin disk cache was not kept after the 1st start');
    assert.ok(b.firstOk, '2nd start with OmniRoute unreachable showed NO models (disk cache fallback missing)');
    console.log(`app-models-restart OK (2. start bez OmniRoute: modely ve výběru z diskové cache, ${b.emptySeen}× prázdný)`);
  } finally {
    proxy.srv.close();
    setTimeout(() => { try { fs.rmSync(rep.base, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
