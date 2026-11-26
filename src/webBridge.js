'use strict';
// Webový most czek-ai (uživatel 26. 11.: integrace do VS Code jako náhrada vestavěného chatu se stejnými možnostmi).
// Lokální server (jen 127.0.0.1) = reverzní proxy na server OpenCode, která do stránky vloží funkce czek-ai
// (src/ocPreload.js – výběr presetu, pravidla učitele, limity, …) a jejich volání předá appce:
//  - /__czek/web.js       ocPreload.js s náhradou electronu (sync XHR, fetch, EventSource) → stejný kód jako v okně
//  - /__czek/ipc/<kanál>  ipcMain.handle appky (falešná událost s odesílatelem BRIDGE_SENDER)
//  - /__czek/events       SSE appka → stránka (např. vložení textu z VS Code do promptu)
//  - /__czek/v1/*         modely czek-ai pro vestavěný chat VS Code (OpenAI formát, stejná cesta jako agent)
// Všechno pod /__czek/ chce token (vscode.json v profilu czek-ai, čte ho rozšíření). Ostatní cesty = OpenCode beze změny
// (+ vložený <script> do HTML, bez X-Frame-Options, ať jde stránka do webview VS Code), i websockety (terminál).
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

const BRIDGE_SENDER = Object.freeze({ czekBridge: true });

function shim(token) {
  return `const __CZEK_T = ${JSON.stringify(token)};
const __CZEK_Q = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(__CZEK_T);
// asynchronní volání přes DRUHÉ jméno téhož serveru: prohlížeč má na jeden host jen 6 spojení a OpenCode je umí na
// chvíli všechna obsadit (pomalý start projektu, proudy událostí) → volání czek-ai by čekala ve frontě (26. 11.)
const __CZEK_B = (location.hostname === 'localhost' ? 'http://127.0.0.1:' : 'http://localhost:') + location.port;
const __CZEK_A = (p) => __CZEK_B + __CZEK_Q(p);
const __CZEK_L = {}; let __CZEK_ES = null; const __CZEK_FETCH = window.fetch.bind(window); // OpenCode si fetch v prohlížeči obaluje → vlastní kopie z doby před ním
const __CZEK_SSE = () => { if (__CZEK_ES) return; __CZEK_ES = new EventSource(__CZEK_A('/__czek/events')); __CZEK_ES.onmessage = (m) => { try { const d = JSON.parse(m.data); for (const f of __CZEK_L[d.ch] || []) f({}, d.data); } catch {} }; };
const ipcRenderer = {
  sendSync(ch) { try { const x = new XMLHttpRequest(); x.open('GET', __CZEK_Q('/__czek/ipcsync/' + encodeURIComponent(ch)), false); x.send(); window.__czekSync = (window.__czekSync || "") + ch + ":" + x.status + ";"; return JSON.parse(x.responseText).value; } catch (e) { window.__czekSync = (window.__czekSync || "") + ch + ":ERR " + (e && e.message) + ";"; return undefined; } },
  invoke(ch, arg) { return __CZEK_FETCH(__CZEK_A('/__czek/ipc/' + encodeURIComponent(ch)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arg: arg === undefined ? null : arg }) }).then((r) => r.json()).then((j) => { if (!j.ok) throw new Error(j.error || 'ipc'); return j.value; }); },
  send(ch, arg) { __CZEK_FETCH(__CZEK_A('/__czek/send/' + encodeURIComponent(ch)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arg: arg === undefined ? null : arg }) }).catch(() => {}); },
  on(ch, fn) { (__CZEK_L[ch] = __CZEK_L[ch] || []).push(fn); __CZEK_SSE(); },
};
const contextBridge = { exposeInMainWorld(k, v) { try { window[k] = v; } catch {} } };
window.__CZEK_WEB__ = true;
`;
}

/** ocPreload.js → skript pro prohlížeč (electron nahrazený shimem). */
function buildScript(preloadFile, token) {
  const src = fs.readFileSync(preloadFile, 'utf8');
  const line = "const { contextBridge, ipcRenderer } = require('electron');";
  if (!src.includes(line)) throw new Error('ocPreload: chybí import electronu');
  return `(() => { try {\n${src.replace("'use strict';", '').replace(line, shim(token))}\n} catch (e) { try { console.error('[czek-ai] web.js', e); window.__czekErr = 'web.js: ' + (e && e.message); } catch {} } })();\n`;
}

/**
 * @param {{ token: string, port?: number, ocUrl: () => string, preloadFile: string, handlers: Map, syncHandlers: Map,
 *   onModels?: (req, res, path) => Promise<void>, log?: Function }} o
 */
function createBridge(o) {
  const log = o.log || (() => {});
  const clients = new Set();
  const active = new Set(); // rozpracované požadavky přes proxy (ladění: /__czek/ping s CZEK_BRIDGE_DEBUG)
  let script = null;
  const tokenOk = (t) => { const a = Buffer.from(String(t || '')); const b = Buffer.from(o.token); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const hostOk = (req, port) => /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(req.headers.host || '')) && (!port || String(req.headers.host).endsWith(':' + port));
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req, max = 2_000_000) => new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > max) { reject(new Error('too big')); req.destroy(); } }); req.on('end', () => resolve(b)); req.on('error', reject); });
  const fakeEvent = () => ({ sender: BRIDGE_SENDER, returnValue: undefined, reply() {} });

  async function czek(req, res, url) {
    const port = server.address()?.port;
    const origin = String(req.headers.origin || '');
    if (origin && (new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${port}$`).test(origin) || /^vscode-webview:\/\//.test(origin))) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-czek-token, authorization', 'access-control-max-age': '600' }); return res.end(); }
    }
    if (!hostOk(req, port)) return json(res, 403, { ok: false, error: 'host' });
    if (!tokenOk(url.searchParams.get('t') || req.headers['x-czek-token'] || (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1])) return json(res, 403, { ok: false, error: 'token' });
    let p = url.pathname; try { p = decodeURIComponent(p); } catch {}
    if (p === '/__czek/web.js') {
      if (!script) script = buildScript(o.preloadFile, o.token);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(script);
    }
    if (p === '/__czek/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': czek\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    const m = p.match(/^\/__czek\/(ipc|ipcsync|send)\/([\w:.-]{1,60})$/);
    if (m) {
      const [, kind, ch] = m; if (process.env.CZEK_BRIDGE_DEBUG) log("[most] ipc", kind, ch, req.headers["sec-fetch-dest"] || "", req.headers.referer || "");
      try {
        const arg = req.method === 'POST' ? (JSON.parse((await readBody(req)) || '{}').arg ?? undefined) : undefined;
        if (kind === 'ipcsync') { const h = o.syncHandlers.get(ch); if (!h) return json(res, 404, { ok: false, error: 'no channel' }); const e = fakeEvent(); await h(e, arg); return json(res, 200, { ok: true, value: e.returnValue }); }
        if (kind === 'send') { const h = o.syncHandlers.get(ch); if (h) await h(fakeEvent(), arg); return json(res, 200, { ok: true }); }
        const h = o.handlers.get(ch);
        if (!h) return json(res, 404, { ok: false, error: 'no channel' });
        return json(res, 200, { ok: true, value: await h(fakeEvent(), arg) });
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (p === '/__czek/vscode/insert' && req.method === 'POST') {
      try { const d = JSON.parse(await readBody(req, 200000)); broadcast('vscode:insert', { text: String(d.text || '').slice(0, 100000), dir: String(d.dir || ''), send: !!d.send }); return json(res, 200, { ok: true, pages: clients.size }); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (p.startsWith('/__czek/v1/') && o.onModels) return o.onModels(req, res, p.slice('/__czek'.length));
    if (p === '/__czek/ping') return json(res, 200, { ok: true, oc: !!o.ocUrl(), pages: clients.size, ...(process.env.CZEK_BRIDGE_DEBUG ? { active: [...active].map((a) => a.url + ' ' + Math.round((Date.now() - a.at) / 1000) + 's ' + (a.ua || '')) } : {}) });
    return json(res, 404, { ok: false, error: 'not found' });
  }

  function proxy(req, res) {
    const rec = { url: req.method + " " + req.url.slice(0, 80), at: Date.now(), ua: String(req.headers["user-agent"] || "").includes("Headless") ? "chrome" : "" };
    active.add(rec); res.on("close", () => active.delete(rec));
    const base = o.ocUrl();
    if (!base) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('czek-ai: OpenCode ještě startuje…'); }
    const target = new URL(req.url, base);
    const wantsHtml = /text\/html/.test(String(req.headers.accept || ''));
    const headers = { ...req.headers, host: target.host };
    if (wantsHtml) headers['accept-encoding'] = 'identity';
    delete headers.origin; delete headers.referer; // OpenCode za proxy (jiný port) – stejné chování jako přímo
    const up = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (ur) => {
      const h = { ...ur.headers };
      delete h['x-frame-options'];
      if (h['content-security-policy']) h['content-security-policy'] = String(h['content-security-policy']).replace(/frame-ancestors[^;]*;?/i, '');
      const html = /text\/html/.test(String(h['content-type'] || '')) && !h['content-encoding'];
      if (!html) { res.writeHead(ur.statusCode, h); ur.pipe(res); return; }
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        const tag = `<script src="/__czek/web.js?t=${o.token}"></script>`;
        body = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + tag) : tag + body;
        delete h['content-length'];
        h['cache-control'] = 'no-store';
        res.writeHead(ur.statusCode, h);
        res.end(body);
      });
    });
    up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('czek-ai: OpenCode neodpovídá – ' + e.message); } else res.destroy(); });
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); return res.end(); }
    if (url.pathname.startsWith('/__czek/')) { czek(req, res, url).catch((e) => { try { json(res, 500, { ok: false, error: e.message }); } catch {} }); return; }
    proxy(req, res);
  });
  // websockety (terminál OpenCode) – syrově přeposlat
  server.on('upgrade', (req, sock, head) => {
    const base = o.ocUrl();
    if (!base) return sock.destroy();
    const t = new URL(base);
    const upSock = net.connect(Number(t.port), t.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${/^host$/i.test(req.rawHeaders[i]) ? t.host : req.rawHeaders[i + 1]}`);
      upSock.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upSock.write(head);
      sock.pipe(upSock).pipe(sock);
    });
    upSock.on('error', () => sock.destroy());
    sock.on('error', () => upSock.destroy());
  });

  function broadcast(ch, data) {
    const msg = `data: ${JSON.stringify({ ch, data })}\n\n`;
    for (const c of clients) { try { c.write(msg); } catch {} }
  }

  const listen = (port) => new Promise((resolve) => {
    const tryPort = (p, fallback) => {
      server.once('error', (e) => { if (fallback && e.code === 'EADDRINUSE') tryPort(0, false); else { log('[most] nejde spustit', e.message); resolve(null); } });
      server.listen(p, '127.0.0.1', () => resolve(server.address().port));
    };
    tryPort(port || 0, !!port);
  });
  return { server, listen, broadcast, close: () => new Promise((r) => { for (const c of clients) { try { c.end(); } catch {} } server.close(() => r()); }), clients };
}

module.exports = { createBridge, buildScript, BRIDGE_SENDER };
