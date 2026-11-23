// Přečte konzoli a stav stránky přes Chrome DevTools Protocol.
//
//   node cdp-console.cjs --dist ./dist             frontend ze složky buildu (spustí vlastní server + neviditelný Chrome/Edge)
//   node cdp-console.cjs --url http://localhost:1420   běžící dev server (Vite) v neviditelném Chrome/Edge
//   node cdp-console.cjs 9222                       běžící aplikace s otevřeným ladicím portem (Electron --remote-debugging-port)
//   volitelně jako poslední argument čekání v ms (výchozí 4000)
//
// Vypíše adresu a titulek stránky, kolik má textu a prvků, a všechny chyby z konzole / nezachycené výjimky.
// --dist / --url nepotřebují restartovat aplikaci ani ladicí port WebView2: Tauri (wry) nastavuje WebView2
// vlastní parametry prohlížeče, takže WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS u něj spolehlivě nefunguje.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const distDir = flag('--dist');
const pageUrl = flag('--url');
const last = Number(args[args.length - 1]);
const waitMs = (args.length && Number.isFinite(last) && last > 500 && !(args.length === 1 && last < 65536 && !distDir && !pageUrl)) ? last : 4000;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const cands = [process.env.CHROME_PATH];
  for (const d of pf) cands.push(path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(d, 'Chromium', 'Application', 'chrome.exe'));
  cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return cands.filter(Boolean).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// statický server pro --dist: soubory ze složky, neznámé cesty → index.html (SPA)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };
function serve(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, 'index.html'))) { console.log(`NO index.html in ${root} – build the frontend first (npm run build) or pass the right folder.`); process.exit(5); }
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}

async function launchBrowser() {
  const exe = findBrowser();
  if (!exe) { console.log('NO CHROME/EDGE FOUND. Set CHROME_PATH to chrome.exe or msedge.exe.'); process.exit(6); }
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-console-'));
  const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = path.join(prof, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) { child.kill(); console.log('BROWSER DID NOT START: ' + exe); process.exit(7); }
  await sleep(200);
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const cleanup = () => { try { child.kill(); } catch {} setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} }, 500); };
  return { port, cleanup };
}

(async () => {
  let port = Number(args[0]) || 9222;
  let target = null; // URL, na kterou se v neviditelném prohlížeči přejde
  let cleanup = () => {};
  let srv = null;
  if (distDir || pageUrl) {
    if (distDir) { const s = await serve(distDir); srv = s.srv; target = s.url; } else target = pageUrl;
    const b = await launchBrowser();
    port = b.port;
    cleanup = b.cleanup;
  }
  const done = (code) => { try { srv?.close(); } catch {} cleanup(); setTimeout(() => process.exit(code), 600); };

  let targets;
  try { targets = await getJson(`http://127.0.0.1:${port}/json`); } catch (e) {
    console.log(`NO DEBUG PORT on ${port}: ${e.message}.\nFor Tauri/WebView2 do not restart the app with env vars – check the frontend instead:\n  node cdp-console.cjs --url http://localhost:1420   (dev server running)\n  node cdp-console.cjs --dist ./dist                 (after npm run build)`);
    return done(2);
  }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  if (!page) { console.log('NO TARGET: the app has no web page loaded (check frontendDist / loadFile path).'); return done(3); }
  if (typeof WebSocket === 'undefined') { console.log('Node 22+ is needed (global WebSocket).'); return done(4); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  const errors = [];
  const failed = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      const frame = d.stackTrace?.callFrames?.[0];
      errors.push(`EXCEPTION: ${d.exception?.description || d.text} @ ${frame ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : `${d.url || ''}:${d.lineNumber}:${d.columnNumber}`}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) {
      errors.push(`CONSOLE ${m.params.type.toUpperCase()}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
      const e = m.params.entry;
      errors.push(`LOG ${e.level.toUpperCase()} (${e.source}): ${e.text}${e.url ? ' @ ' + e.url : ''}`);
    } else if (m.method === 'Network.loadingFailed' && !m.params.canceled) {
      failed.push(`${m.params.errorText} (${m.params.type || ''})`);
    } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      failed.push(`HTTP ${m.params.response.status} ${m.params.response.url}`);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');
  // chyby z načítání stránky by už byly pryč → sledovat od začátku (načíst znovu / přejít na cíl)
  if (target) await send('Page.navigate', { url: target }); else await send('Page.reload', { ignoreCache: true });
  await sleep(waitMs);
  const res = await send('Runtime.evaluate', { returnByValue: true, expression: `({ url: location.href, title: document.title, text: (document.body?.innerText || '').trim().length, elements: document.querySelectorAll('*').length, ready: document.readyState, root: (document.querySelector('#app, #root, main, body > div')?.innerHTML || '').length, sample: (document.body?.innerText || '').trim().slice(0, 200) })` });
  const st = res?.result?.value || {};
  console.log(`PAGE: ${st.url || page.url}\nTITLE: ${st.title || '(none)'}`);
  console.log(`DOM: readyState=${st.ready} elements=${st.elements} visibleText=${st.text} rootHtml=${st.root}`);
  if (st.text) console.log(`TEXT: ${String(st.sample).replace(/\s+/g, ' ')}`);
  if (!st.text) console.log('PAGE IS EMPTY: no visible text. The errors below are the likely cause.');
  if (failed.length) console.log(`FAILED REQUESTS (${failed.length}):\n` + [...new Set(failed)].slice(0, 15).join('\n'));
  console.log(errors.length ? `ERRORS (${errors.length}):\n` + [...new Set(errors)].slice(0, 40).join('\n') : 'NO CONSOLE ERRORS');
  if (target && errors.some((e) => /__TAURI|tauri|invoke/i.test(e))) console.log('NOTE: in a plain browser Tauri APIs (invoke, __TAURI_INTERNALS__) do not exist. Errors about them are expected here; any OTHER error that stops rendering is a real bug.');
  ws.close();
  done(0);
})().catch((e) => { console.log('FAILED: ' + e.message); process.exit(1); });
