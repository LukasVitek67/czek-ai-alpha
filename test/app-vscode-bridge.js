// CELÁ appka + webový most pro VS Code (src/webBridge.js): stránka mostu otevřená v obyčejném Chrome (headless, jako
// iframe ve webview VS Code – bez Electronu, bez preloadu) má funkce czek-ai (výběr presetu, pravidla učitele), volání jdou
// do appky; /__czek/* jen s tokenem z vscode.json; vložení textu „z VS Code“ do promptu; modely /__czek/v1 pro vestavěný chat.
//   OPENCODE_BIN=<opencode> node test/app-vscode-bridge.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const cdp = require('./app-cdp');

const OC_PORT = 4461, BRIDGE = 4462, CHROME_CDP = 9374;
const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-vsbridge-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const ud = x('userdata'); const proj = x('proj');
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'zdarma', lang: 'cs', providers: {}, wizardDone: true, lastCwd: proj }));
const fake = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const j = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: j.model, choices: [{ message: { role: 'assistant', content: 'pong ' + j.model } }] })); }); });
const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: String(OC_PORT), ZDARMA_BRIDGE_PORT: String(BRIDGE), ZDARMA_HIDDEN: '1', CZEK_BRIDGE_DEBUG: '1' };
delete env.OPENCODE_CONFIG_DIR;
const b64 = (d) => Buffer.from(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const findChrome = () => ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].find((p) => fs.existsSync(p));

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  env.ZDARMA_TEST_MODEL_URL = `http://127.0.0.1:${fake.address().port}/v1/chat/completions`;
  const app = spawn(require('electron'), ['.', '--password-store=basic'], { cwd: root, env, stdio: 'ignore' });
  let chrome = null;
  const B = `http://127.0.0.1:${BRIDGE}`;
  try {
    let conf = null;
    for (let i = 0; i < 240 && !conf; i++) { await wait(1000); try { conf = JSON.parse(fs.readFileSync(path.join(ud, 'vscode.json'), 'utf8')); } catch {} }
    assert.ok(conf?.port === BRIDGE && /^[0-9a-f]{40}$/.test(conf.token), 'vscode.json s portem a tokenem');
    const T = conf.token;
    assert.strictEqual((await fetch(`${B}/__czek/ping`)).status, 403, 'bez tokenu 403');
    assert.strictEqual((await fetch(`${B}/__czek/ipcsync/oc:prefs?t=${'0'.repeat(40)}`)).status, 403, 'cizí token 403');
    let html = '';
    for (let i = 0; i < 60; i++) { const r = await fetch(`${B}/`, { headers: { accept: 'text/html' } }).catch(() => null); if (r?.ok) { html = await r.text(); if (html.includes('/__czek/web.js')) break; } await wait(1000); }
    assert.ok(html.includes(`/__czek/web.js?t=${T}`), 'HTML OpenCode s vloženým skriptem czek-ai');
    if (process.env.SHOWLOG) { const r = await fetch(`${B}/`, { headers: { accept: 'text/html' } }); console.log('CSP hlavička:', r.headers.get('content-security-policy')); console.log('meta/script:', (html.match(/<meta[^>]*(Content-Security|http-equiv)[^>]*>|<script[^>]*>/gi) || []).slice(0, 6).join(' | ')); }
    const prefs = await (await fetch(`${B}/__czek/ipcsync/oc:prefs?t=${T}`)).json();
    assert.ok(prefs.ok && prefs.value.presets?.length >= 8 && prefs.value.teacher === true, 'oc:prefs přes most (presety, pravidla učitele)');
    // modely pro vestavěný chat VS Code
    const models = await (await fetch(`${B}/__czek/v1/models`, { headers: { authorization: `Bearer ${T}` } })).json();
    assert.deepStrictEqual(models.data.map((m) => m.id), ['max', 'high', 'low']);
    const chat = await (await fetch(`${B}/__czek/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'max', messages: [{ role: 'user', content: 'ping' }] }) })).json();
    assert.strictEqual(chat.choices?.[0]?.message?.content, 'pong max', 'chat přes most → model czek-ai');
    // stránka mostu v obyčejném Chrome
    const exe = findChrome();
    assert.ok(exe, 'Chrome/Edge pro test');
    chrome = spawn(exe, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CHROME_CDP}`, `--user-data-dir=${x('chrome')}`, '--window-size=1280,900', `${B}/${b64(proj)}/session`], { stdio: 'ignore' });
    const page = `127.0.0.1:${BRIDGE}`;
    const ev = (js) => Promise.race([cdp.evaluate(CHROME_CDP, page, js), wait(8000).then(() => null)]).catch(() => null);
    let st = null;
    for (let i = 0; i < 90; i++) {
      await wait(1000);
      st = await ev(`({ web: !!window.__CZEK_WEB__, path: location.pathname, picker: !!document.querySelector('[data-czek-presets]'), teacher: document.querySelector('[data-czek-teacher]')?.innerText || null, opts: document.querySelectorAll('[data-czek-presets] .cp-opt[data-agent]').length })`);
      if (st?.picker && st.teacher) break;
      if (st && i % 15 === 14 && !String(st.path).includes('new-session')) await ev(`(() => { const b = [...document.querySelectorAll('button, a')].find((e) => /nová relace|new session/i.test(e.textContent || e.getAttribute('aria-label') || '')); if (b) b.click(); return 1; })()`);
    }
    console.log('Chrome (most):', JSON.stringify(st));
    if (!st?.picker) console.log('diag:', JSON.stringify(await ev(`(() => { const x = new XMLHttpRequest(); x.open('GET', '/__czek/ipcsync/oc:prefs?t=${T}', false); x.send(); let j = null; try { j = JSON.parse(x.responseText); } catch {}
      return { status: x.status, presets: j?.value?.presets?.length, prompt: !!document.querySelector('[aria-label="Prompt"]'), forms: document.querySelectorAll('form').length, maxw: [...document.querySelectorAll('[class*="max-w-"]')].length, ready: document.readyState, err: window.__czekErr || null }; })()`)));
    if (!st?.picker) console.log('diag3:', JSON.stringify(await ev(`({ sync: window.__czekSync || null, zd: typeof window.__ZDARMA__, styles: [...document.querySelectorAll('style')].map((s) => (s.textContent.match(/data-czek-[a-z]+/) || [''])[0]).filter(Boolean), scripts: [...document.scripts].map((s) => (s.src || 'inline').slice(-40)).slice(0, 6), lang: localStorage.getItem('opencode.global.dat:language') })`)));
    if (!st?.picker) console.log('diag2:', JSON.stringify(await ev(`(async () => { const t = await (await fetch('/__czek/web.js?t=${T}')).text(); try { new Function(t)(); document.dispatchEvent(new Event('DOMContentLoaded')); window.dispatchEvent(new Event('DOMContentLoaded')); return { ran: true, err: window.__czekErr || null, len: t.length, picker: !!document.querySelector('[data-czek-presets]') }; } catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; } })()`)));
    assert.ok(st?.web, 'skript czek-ai ve stránce');
    assert.ok(st.picker && st.opts >= 8, 'výběr presetu v Chrome přes most');
    assert.match(st.teacher || '', /Pravidla učitele/, 'přepínač pravidel učitele v Chrome přes most');
    await ev(`document.querySelector('[data-czek-teacher]').click()`);
    let tj = null;
    for (let i = 0; i < 20 && !tj?.pending; i++) { await wait(300); try { tj = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'czek-guard', 'teacher.json'), 'utf8')); } catch {} }
    if (!tj?.pending) {
      const t0 = Date.now();
      const nr = await fetch(`${B}/__czek/ipc/teacher:set?t=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arg: { sid: null, on: true } }), signal: AbortSignal.timeout(10000) }).then((x) => x.text()).catch((e) => 'ERR ' + e.message);
      console.log('node POST teacher:set:', Date.now() - t0, 'ms', nr.slice(0, 200));
      console.log('aktivní spojení:', JSON.stringify((await (await fetch(`${B}/__czek/ping?t=${T}`)).json()).active));
      for (const u of [`http://127.0.0.1:${OC_PORT}/path`, `${B}/path`, `http://127.0.0.1:${OC_PORT}/provider`, `${B}/provider`]) {
        const t1 = Date.now();
        const r = await fetch(u, { signal: AbortSignal.timeout(6000) }).then((x) => x.status).catch((e) => 'ERR ' + e.name);
        console.log('  ', u.replace(/http:\/\/127\.0\.0\.1:/, ''), r, Date.now() - t1, 'ms');
      }
      console.log('teacher diag:', JSON.stringify(await ev(`(async () => {
        const to = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), 2500))]);
        const getPing = await to(fetch('/__czek/ping?t=${T}').then((x) => 'ok ' + x.status).catch((e) => 'ERR ' + e.message));
        const getOc = await to(fetch('/global/health').then((x) => 'ok ' + x.status).catch((e) => 'ERR ' + e.message));
        const lh = await to(fetch('http://localhost:${BRIDGE}/__czek/ping?t=${T}').then((x) => 'ok ' + x.status).catch((e) => 'ERR ' + e.message));
        const sx = (() => { try { const x = new XMLHttpRequest(); x.open('POST', '/__czek/ipc/teacher%3Aset?t=${T}', false); x.setRequestHeader('content-type', 'application/json'); x.send(JSON.stringify({ arg: { sid: null, on: true } })); return x.status + ' ' + x.responseText.slice(0, 80); } catch (e) { return 'ERR ' + e.message; } })();
        const pend = performance.getEntriesByType('resource').filter((e) => !e.responseEnd).map((e) => e.name.replace(location.origin, '').slice(0, 70));
        return { getPing, getOc, localhost: lh, syncPost: sx, pending: pend }; })()`)));
      console.log('teacher.json:', fs.existsSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'czek-guard', 'teacher.json')) ? fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'czek-guard', 'teacher.json'), 'utf8').slice(0, 300) : 'chybí');
    }
    assert.strictEqual(tj?.pending?.on, true, 'klik v Chrome → appka (teacher.json)');
    // „z VS Code“: vložit text do promptu
    const ins = await (await fetch(`${B}/__czek/vscode/insert?t=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Vysvětli tenhle kód z VS Code', dir: proj }) })).json();
    assert.ok(ins.ok && ins.pages >= 1, 'stránka odebírá události');
    let prompt = '';
    for (let i = 0; i < 20 && !/z VS Code/.test(prompt); i++) { await wait(300); prompt = (await ev(`(document.querySelector('[aria-label="Prompt"]') || document.querySelector('form [contenteditable="true"]'))?.innerText || ''`)) || ''; }
    console.log('prompt:', JSON.stringify(prompt.slice(0, 80)));
    assert.match(prompt, /Vysvětli tenhle kód z VS Code/, 'text z VS Code v promptu');
    await cdp.shot(CHROME_CDP, page, path.join(root, 'docs', 'research', '2026-11-26-presets', 'vscode-bridge-chrome.png')).catch(() => {});
    console.log('app-vscode-bridge OK (token, HTML se skriptem, IPC přes most, výběr + přepínač v Chrome, vložení z VS Code, modely /__czek/v1)');
  } finally {
    for (const c of [chrome, app]) if (c) { try { execFileSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    fake.close();
    if (process.env.SHOWLOG) { try { console.log(fs.readFileSync(path.join(ud, 'zdarma.log'), 'utf8').split(/\r?\n/).filter((l) => /most/.test(l)).slice(0, 30).join('\n')); } catch {} }
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
