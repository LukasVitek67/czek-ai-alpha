// Monitor v CELÉ appce (kopie stavu uživatele, test/app-replica.js): skutečný dotaz přes závod modelů, pak okno
// Monitor (z okna OpenCode přes __ZDARMA__.openMonitor): součásti v pořádku, model v tabulce s úspěšností a časy,
// volání v seznamu, po kliknutí celý obsah (dotaz se zprávami, odpověď modelu, závod). Soubory: úplný záznam volání
// (logs/calls) s dotazem, bez nezamaskovaných klíčů; logs/monitor-now.json pro ladění.
//   node test/app-monitor.js   (APP_EXE=none = ze zdrojáků; REPLICA_OC_PORT, výchozí 4421)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeReplica, launch, freePort } = require('./app-replica');
const cdp = require('./app-cdp');
const { KEY_RES } = require('../src/fullLog');
const I18N = require('../src/i18n');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// texty okna podle jazyka profilu (kopie stavu uživatele může mít angličtinu); {proměnné} = cokoli
const T = (k) => I18N.t(k);
const re = (k) => new RegExp(T(k).split(/\{\w+\}/).map((p) => p.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('.*'));

(async () => {
  const OC_PORT = Number(process.env.REPLICA_OC_PORT) || 4421;
  const cdpPort = await freePort(9345);
  const rep = makeReplica({ ocPort: OC_PORT, cdpPort, sessions: false, uiState: false });
  rep.env.CZEK_FULL_LOG = '1';
  try { I18N.setLang(JSON.parse(fs.readFileSync(path.join(rep.ud, 'settings.json'), 'utf8')).lang === 'en' ? 'en' : 'cs'); } catch {}
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-monitor-proj-')));
  const child = launch(rep);
  const u = `http://127.0.0.1:${OC_PORT}`;
  const q = '?directory=' + encodeURIComponent(work);
  const OC = `127.0.0.1:${OC_PORT}`;
  try {
    let ok = false;
    for (let i = 0; i < 300 && !ok; i++) { ok = !!(await cdp.page(rep.cdpPort, OC).catch(() => null)); if (!ok) await wait(1000); }
    assert.ok(ok, 'OpenCode window did not appear');
    await wait(8000);
    const prompt = 'Reply with exactly the text MONITOR-TEST-OK and nothing else. Do not use any tools.';
    const s = await (await fetch(u + '/session' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const r = await fetch(u + `/session/${s.id}/message` + q, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'opencode-omniroute', modelID: 'zdarma-max' }, parts: [{ type: 'text', text: prompt }] }), signal: AbortSignal.timeout(240000) });
    const answer = await r.json().catch(() => ({}));
    const answerText = (answer.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
    console.log('odpověď modelu:', JSON.stringify(answerText).slice(0, 120));

    // okno Monitor z okna OpenCode
    assert.strictEqual(await cdp.evaluate(rep.cdpPort, OC, 'window.__ZDARMA__.openMonitor()'), true, 'openMonitor from the OpenCode window');
    let st = null;
    for (let i = 0; i < 40; i++) {
      await wait(1500);
      st = await cdp.evaluate(rep.cdpPort, 'monitor.html', `(() => ({
        sum: document.getElementById('sum').textContent,
        comps: [...document.querySelectorAll('#components tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent)),
        models: [...document.querySelectorAll('#models tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent)),
        calls: document.querySelectorAll('#calls tr.call').length,
        alerts: [...document.querySelectorAll('#alerts li')].map((li) => li.textContent),
      }))()`).catch(() => null);
      // OmniRoute zapisuje volání se zpožděním (nejdřív stav 0) → čekat, až má model dokončené pokusy
      if (st && st.calls > 0 && st.models.some((m) => m.length > 3 && Number(m[2]) > 0)) break;
    }
    assert.ok(st, 'monitor window did not render');
    console.log('stav:', st.sum);
    for (const c of st.comps) console.log('  ', c.join(' | ').slice(0, 160));
    console.log('modely:'); for (const m of st.models.slice(0, 5)) console.log('  ', m.slice(0, 10).join(' | ').slice(0, 200));
    console.log('upozornění:', st.alerts.slice(0, 5).join(' / ').slice(0, 400));
    const comp = (id) => st.comps.find((c) => c[0] === T('mon.c.' + id));
    for (const id of ['omniroute', 'opencode', 'race', 'calllog']) assert.strictEqual(comp(id)?.[1], T('mon.st.ok'), id + ' OK');
    assert.ok(st.models.some((m) => Number(m[2]) > 0 && /\d+ %/.test(m[3])), 'a model with finished attempts and success rate (OmniRoute call log)');
    assert.ok(st.calls >= 1, 'call in the list');

    // klik na nejnovější volání s nástroji (krok agenta) → celý obsah
    const detail = await cdp.evaluate(rep.cdpPort, 'monitor.html', `(async () => {
      const row = [...document.querySelectorAll('#calls tr.call')].find((tr) => /agent/.test(tr.cells[1].textContent)) || document.querySelector('#calls tr.call');
      row.click();
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); const d = document.querySelector('.detail-row .detail'); if (d && d.textContent !== ${JSON.stringify(T('mon.d.loading'))}) return d.innerText; }
      return document.querySelector('.detail-row .detail')?.innerText || '';
    })()`);
    console.log('detail volání (začátek):', detail.slice(0, 600).replace(/\n+/g, ' ⏎ '));
    assert.match(detail, re('mon.d.response'));
    assert.match(detail, re('mon.d.request'));
    assert.match(detail, /MONITOR-TEST-OK and nothing else/, 'the user message as the model got it');
    assert.match(detail, /system/, 'system prompt in the request');
    assert.match(detail, re('mon.d.race'), 'race section');
    await cdp.shot(rep.cdpPort, 'monitor.html', path.join(os.tmpdir(), 'zd-monitor-shot.png')).catch(() => {});

    // pauza OmniRoute (OVH_PAUSE_MODEL = OVH model s vyčerpaným ročním limitem, např. nemotron3-nano-30b): 429 → OmniRoute
    // pauza do 1. 1. → czek-ai syncCooldowns (do 20 s) → okno Monitor: stav „pauza OmniRoute do …“ + upozornění
    const pm = process.env.OVH_PAUSE_MODEL;
    if (pm) {
      const auth = JSON.parse(fs.readFileSync(path.join(rep.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'))['opencode-omniroute'];
      const t429 = Date.now();
      const pr = await fetch(auth.baseURL.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.key },
        body: JSON.stringify({ model: 'z-ovh/' + pm, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) });
      console.log(`OVH z-ovh/${pm}: HTTP ${pr.status}`);
      assert.strictEqual(pr.status, 429, 'OVH model má vyčerpaný limit');
      // synchronizace pauz běží každých 20 s → čekat na stav „pauza OmniRoute“ i upozornění omniPaused (ne „volání skončilo chybou“)
      const stRe = re('mon.ms.paused'); const alRe = re('mon.a.omniPaused');
      let pz = null;
      for (let i = 0; i < 40; i++) {
        await wait(1500);
        pz = await cdp.evaluate(rep.cdpPort, 'monitor.html', `(() => {
          const tr = [...document.querySelectorAll('#models tbody tr')].find((t) => t.cells[0].textContent === ${JSON.stringify('z-ovh/' + pm)});
          const al = [...document.querySelectorAll('#alerts li')].map((li) => li.textContent).filter((x) => x.includes(${JSON.stringify('z-ovh/' + pm + ':')}));
          return { state: tr ? [...tr.cells[1].querySelectorAll('span')].map((s) => s.textContent).join(' + ') : '', tip: tr?.cells[1].querySelector('span[title]')?.title || '', alerts: al };
        })()`).catch(() => null);
        if (pz && stRe.test(pz.state) && pz.alerts.some((a) => alRe.test(a))) break;
      }
      if (pz) pz.alert = (pz.alerts || []).find((a) => alRe.test(a)) || '';
      assert.ok(pz, 'monitor window readable');
      console.log(`pauza v monitoru za ${((Date.now() - t429) / 1000).toFixed(0)} s: ${pz.state} / ${pz.alert} / ${pz.tip}`);
      assert.match(pz.state, stRe, 'model state: OmniRoute pause');
      assert.match(pz.alert, alRe, 'omniPaused alert');
      assert.match(pz.alert, /2027|31\. ?12\.|1\. ?1\.|31\/12|1\/1/, 'do konce roku (OVH retry-after)');
      await cdp.shot(rep.cdpPort, 'monitor.html', path.join(os.tmpdir(), 'zd-monitor-pause-shot.png')).catch(() => {});
    }

    // soubory: záznam volání + stav pro ladění
    const day = new Date().toISOString().slice(0, 10);
    const cdir = path.join(rep.ud, 'logs', 'calls');
    const callsTxt = fs.readFileSync(path.join(cdir, day + '.jsonl'), 'utf8');
    const msgsTxt = fs.readFileSync(path.join(cdir, day + '.msgs.jsonl'), 'utf8');
    assert.ok(callsTxt.split('\n').filter(Boolean).length >= 1, 'call recorded');
    assert.ok(msgsTxt.includes('MONITOR-TEST-OK and nothing else'), 'messages recorded');
    const all = fs.readdirSync(cdir).map((f) => fs.readFileSync(path.join(cdir, f), 'utf8')).join('');
    const leaks = KEY_RES.flatMap((re) => all.match(new RegExp(re.source, 'g')) || []);
    assert.strictEqual(leaks.length, 0, 'unmasked keys in call recordings: ' + leaks.length);
    let snap = null;
    for (let i = 0; i < 20 && !snap; i++) { try { snap = JSON.parse(fs.readFileSync(path.join(rep.ud, 'logs', 'monitor-now.json'), 'utf8')); } catch { await wait(1500); } }
    assert.ok(snap && Array.isArray(snap.models) && snap.components.length >= 6, 'logs/monitor-now.json written');
    console.log(`app-monitor OK (součásti v pořádku, ${st.models.length} modely, ${st.calls} volání, detail s dotazem i odpovědí, záznam ${Math.round(all.length / 1024)} kB bez klíčů, monitor-now.json)`);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    setTimeout(() => { try { fs.rmSync(rep.base, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
