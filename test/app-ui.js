// Celá appka na kopii stavu uživatele (test/app-replica.js), přes CDP jako uživatel:
//  1) mini přehrávač nad promptem vpravo: hraje, výchozí bez zvuku, 🔊 zapne zvuk, ▶ přepne video;
//  2) seznam úkolů pod promptem skrytý;  3) panel Kontext: součty relace (volání modelu, tokeny);
//  4) novější czek-ai-X.Y.Z.exe „na ploše“ (CZEK_DESKTOP_DIR) → lišta s restartem.
//   APP_EXE=none node test/app-ui.js   (REPLICA_OC_PORT=4419 – běží i vedle otevřené appky uživatele)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeReplica, launch } = require('./app-replica');
const cdp = require('./app-cdp');

const OC_PORT = Number(process.env.REPLICA_OC_PORT) || 4419;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (d) => Buffer.from(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const shots = process.env.UI_SHOTS || path.join(os.tmpdir(), 'zd-ui-shots');

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const rep = makeReplica({ ocPort: OC_PORT, uiState: false });
  const desk = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-desk-'));
  fs.writeFileSync(path.join(desk, 'czek-ai-9.9.9.exe'), 'x');
  rep.env.CZEK_DESKTOP_DIR = desk;
  const child = launch(rep);
  const P = `127.0.0.1:${OC_PORT}`;
  const ev = (js) => cdp.evaluate(rep.cdpPort, P, js);
  const res = {};
  try {
    let ok = false;
    for (let i = 0; i < 300 && !ok; i++) { ok = !!(await cdp.page(rep.cdpPort, P)); if (!ok) await wait(1000); }
    assert.ok(ok, 'OpenCode window did not appear');
    const sessions = await (await fetch(`http://${P}/session`)).json();
    const last = sessions.sort((a, b) => b.time.updated - a.time.updated)[0];
    // jiný port než 4096 = jiný původ, bez localStorage uživatele → OpenCode by kreslilo nové rozvržení; appka
    // u uživatele jede v klasickém (stejně jako při prvním spuštění: newLayoutDesigns false)
    await ev(`(() => { const s = JSON.parse(localStorage.getItem('settings.v3') || '{}'); s.general = { ...(s.general || {}), newLayoutDesigns: false }; localStorage.setItem('settings.v3', JSON.stringify(s)); return 1; })()`);
    await ev(`location.href = '/${b64(last.directory)}/session/${last.id}'; 1`);
    // čekat na pole pro prompt + přehrávač
    let v = null;
    for (let i = 0; i < 60; i++) {
      await wait(2000);
      v = await ev(`(() => { const w = document.querySelector('[data-czek-video]'); const s = document.querySelector('[data-dock-surface="shell"]'); if (!w || !s) return null; const a = w.getBoundingClientRect(), b = s.getBoundingClientRect(); return { shown: getComputedStyle(w).display !== 'none', src: w.querySelector('iframe').src, muted: w.dataset.muted, idx: w.dataset.idx, wRight: Math.round(a.right), wBottom: Math.round(a.bottom), sRight: Math.round(b.right), sTop: Math.round(b.top) }; })()`).catch(() => null);
      if (v?.shown) break;
    }
    console.log('přehrávač:', JSON.stringify(v));
    assert.ok(v?.shown, 'video dock not shown above the prompt');
    assert.ok(Math.abs(v.wRight - v.sRight) <= 2 && v.wBottom <= v.sTop, 'video dock sits above the right edge of the prompt');
    assert.match(v.src, /youtube-nocookie\.com\/embed\/YAgJ9XugGBo\?.*mute=1/, 'first video, muted');
    // rámeček YouTube: hraje? (OOPIF = vlastní cíl CDP typu iframe)
    let playing = null;
    for (let i = 0; i < 15; i++) {
      await wait(2000);
      const fr = (await cdp.targets(rep.cdpPort)).find((t) => t.type === 'iframe' && /youtube/.test(t.url));
      if (!fr) continue;
      const r = await cdp.call(fr, 'Runtime.evaluate', { expression: `(() => { const x = document.querySelector('video'); return x ? { t: x.currentTime, paused: x.paused, muted: x.muted } : { err: document.body.innerText.slice(0, 160) }; })()`, returnByValue: true }).catch((e) => ({ result: { value: { err: e.message } } }));
      playing = r.result.value;
      if (playing && playing.t > 1) break;
    }
    console.log('video v rámečku:', JSON.stringify(playing));
    assert.ok(playing && playing.t > 1 && !playing.paused, 'YouTube video plays: ' + JSON.stringify(playing));
    assert.strictEqual(playing.muted, true, 'sound off by default');
    await cdp.shot(rep.cdpPort, P, path.join(shots, 'ui-video.png'));
    // zvuk zapnout
    await ev(`[...document.querySelectorAll('[data-czek-video] button')].find(b => /🔇|🔊/.test(b.textContent)).click(); 1`);
    await wait(2500);
    const fr = (await cdp.targets(rep.cdpPort)).find((t) => t.type === 'iframe' && /youtube/.test(t.url));
    const un = (await cdp.call(fr, 'Runtime.evaluate', { expression: `(() => { const x = document.querySelector('video'); return x && { muted: x.muted, paused: x.paused }; })()`, returnByValue: true })).result.value;
    console.log('po 🔊:', JSON.stringify(un));
    assert.strictEqual(un.muted, false, 'sound on after click');
    // přepnout na další video
    await ev(`document.querySelector('[data-czek-video] button[title]').parentElement.querySelectorAll('button')[1].click(); 1`);
    await wait(1500);
    const v2 = await ev(`(() => { const w = document.querySelector('[data-czek-video]'); return { src: w.querySelector('iframe').src, idx: w.dataset.idx, muted: w.dataset.muted }; })()`);
    console.log('po ▶:', JSON.stringify(v2));
    assert.match(v2.src, /embed\/coaN2VBNgYA\?.*mute=0/, 'second video, sound stays on');
    // seznam úkolů skrytý
    res.todo = await ev(`(() => { const d = document.createElement('div'); d.setAttribute('data-component', 'session-todo-dock'); document.body.append(d); const v = getComputedStyle(d).display; d.remove(); return v; })()`);
    assert.strictEqual(res.todo, 'none', 'todo dock hidden');
    // lišta s novou verzí
    let up = null;
    for (let i = 0; i < 10 && !up; i++) { up = await ev(`document.querySelector('[data-czek-upgrade]')?.innerText || null`); if (!up) await wait(1000); }
    console.log('lišta nové verze:', JSON.stringify(up));
    assert.match(up || '', /9\.9\.9/, 'upgrade bar shows the newer version');
    // panel Kontext: otevřít (tlačítko/záložka „Context“ nebo kroužek využití) a přečíst součty czek-ai
    let totals = null;
    for (let i = 0; i < 12 && !totals; i++) {
      await ev(`(() => { const c = [...document.querySelectorAll('button,[role=tab]')].find(b => /^\\s*(Context|Kontext)\\s*$/i.test(b.innerText) || /context/i.test(b.getAttribute('aria-label') || '')); if (c) c.click(); return !!c; })()`);
      await wait(2500);
      totals = await ev(`document.querySelector('[data-czek-totals]')?.innerText || null`);
    }
    console.log('panel Kontext (czek-ai):', JSON.stringify(totals));
    await cdp.shot(rep.cdpPort, P, path.join(shots, 'ui-context.png'));
    assert.match(totals || '', /volání modelu|model calls/, 'context totals shown');
    assert.ok(!/\{[a-z]+\}/.test(totals), 'no unfilled {placeholders}');
    console.log(`app-ui OK (přehrávač hraje bez zvuku → 🔊 zvuk → ▶ další video; úkoly skryté; součty v Kontextu; lišta nové verze) – snímky: ${shots}`);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    setTimeout(() => { try { fs.rmSync(rep.base, { recursive: true, force: true }); fs.rmSync(desk, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
