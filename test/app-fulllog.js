// Úplný log v CELÉ appce (kopie stavu uživatele, test/app-replica.js, CZEK_FULL_LOG=1): relace v dočasné
// složce (žádný skutečný projekt), krátký skutečný dotaz přes OmniRoute, pak kontrola, že log obsahuje
// všechno: start appky, akce (IPC), text uživatele, odpověď / myšlení modelu, kroky s tokeny, výstup serveru
// OpenCode, log procesu OmniRoute + záznam volání (který model, stav), czek-guard. A žádný nezamaskovaný klíč.
//   node test/app-fulllog.js   (REPLICA_OC_PORT=4419 výchozí – běží i vedle otevřené appky uživatele)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeReplica, launch } = require('./app-replica');
const cdp = require('./app-cdp');
const { KEY_RES } = require('../src/fullLog');

const OC_PORT = Number(process.env.REPLICA_OC_PORT) || 4419;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const rep = makeReplica({ ocPort: OC_PORT, sessions: false, uiState: false });
  if (rep.skipped.length) console.log('zamčené (přeskočené) soubory kopie:', rep.skipped.length);
  rep.env.CZEK_FULL_LOG = '1';
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-fulllog-proj-')));
  const t0 = Date.now();
  const child = launch(rep);
  const u = `http://127.0.0.1:${OC_PORT}`;
  const q = '?directory=' + encodeURIComponent(work);
  try {
    let ok = false;
    for (let i = 0; i < 300 && !ok; i++) { ok = !!(await cdp.page(rep.cdpPort, `127.0.0.1:${OC_PORT}`)); if (!ok) await wait(1000); }
    assert.ok(ok, 'OpenCode window did not appear');
    // seznam úkolů pod promptem musí být v okně appky skrytý (ocPatch.TODO_HIDE_CSS); prvek podle bundlu webu
    // CSS se vkládá při dom-ready; na čistém profilu se stránka po startu jednou sama přenačte (klasické rozvržení)
    let todoHidden = null;
    for (let i = 0; i < 20 && todoHidden !== 'none'; i++) {
      await wait(1500);
      todoHidden = await cdp.evaluate(rep.cdpPort, `127.0.0.1:${OC_PORT}`, `(() => { const d = document.createElement('div'); d.setAttribute('data-component', 'session-todo-dock'); d.textContent = '0 of 6 todos completed'; document.body.append(d); const v = getComputedStyle(d).display; d.remove(); return v; })()`).catch(() => null);
    }
    console.log('seznam úkolů v okně appky: display =', todoHidden);
    assert.strictEqual(todoHidden, 'none', 'todo dock is visible in the app window');
    const s = await (await fetch(u + '/session' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const prompt = 'Reply with exactly the text LOG-TEST-OK and nothing else. Do not use any tools.';
    const r = await fetch(u + `/session/${s.id}/message` + q, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'opencode-omniroute', modelID: 'zdarma-max' }, parts: [{ type: 'text', text: prompt }] }),
      signal: AbortSignal.timeout(240000),
    });
    const answer = await r.json().catch(() => ({}));
    await wait(15000); // záznamy volání OmniRoute se čtou po 10 s, sledované soubory po 2 s
    const logDir = path.join(rep.ud, 'logs');
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl') && f !== 'guard.jsonl');
    const raw = files.map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
    const recs = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const has = (src, kind, re) => recs.some((x) => x.src === src && (!kind || x.kind === kind) && (!re || re.test(x.msg + JSON.stringify(x.data || ''))));
    const kinds = {};
    for (const x of recs) kinds[x.src + '/' + x.kind] = (kinds[x.src + '/' + x.kind] || 0) + 1;
    console.log(`log: ${recs.length} záznamů, ${(raw.length / 1024).toFixed(0)} KB za ${Math.round((Date.now() - t0) / 1000)} s`);
    console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`).join('\n'));
    const answerText = (answer.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
    console.log('odpověď modelu:', JSON.stringify(answerText).slice(0, 200), answer.info?.error ? 'CHYBA ' + JSON.stringify(answer.info.error).slice(0, 200) : '');
    const checks = {
      'start appky': has('app', 'start'),
      'řádky logu appky': has('app', 'log'),
      'akce v appce (IPC)': recs.some((x) => x.src === 'app' && /^ipc/.test(x.kind)),
      'text uživatele celý': has('opencode', 'user-text', /LOG-TEST-OK and nothing else/),
      'odpověď modelu': has('opencode', 'model-text') || has('opencode', 'message-error'),
      'krok s tokeny': has('opencode', 'step-finish', /tokeny vstup/),
      'konec odpovědi s důvodem': has('opencode', 'message-done') || has('opencode', 'message-error'),
      'stav relace': has('opencode', 'session-status'),
      'výstup serveru OpenCode': has('opencode-server', 'out'),
      'proces OmniRoute': has('omniroute', 'proces'),
      'volání OmniRoute (model, stav)': has('omniroute', 'call'),
      'czek-guard': has('czek-guard'),
      // 0.15.21: krok agenta (s nástroji) jde přes proxy závodu na 3 modely tieru (src/race.js)
      'závod modelů (vítěz)': has('race', 'race', /vyhrál|selhalo → dotaz na celé combo/),
    };
    for (const x of recs.filter((y) => y.src === 'race').slice(0, 4)) console.log('  závod:', x.msg.slice(0, 160));
    for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'OK ' : 'CHYBÍ'} ${k}`);
    const leaks = KEY_RES.flatMap((re) => raw.match(new RegExp(re.source, 'g')) || []);
    console.log(`  nezamaskované klíče: ${leaks.length}`);
    assert.strictEqual(leaks.length, 0, 'unmasked key-like strings in the log');
    const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    assert.deepStrictEqual(missing, [], 'missing in full log: ' + missing.join(', '));
    console.log('app-fulllog OK');
  } finally {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    setTimeout(() => { try { fs.rmSync(rep.base, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
