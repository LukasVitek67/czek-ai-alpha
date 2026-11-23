// Ovládání okna appky přes CDP (Chrome DevTools Protocol) – pro testy i ruční zkoumání.
//   node test/app-cdp.js <cdpPort> targets
//   node test/app-cdp.js <cdpPort> eval <urlPart> "<js výraz>"
//   node test/app-cdp.js <cdpPort> shot <urlPart> <soubor.png>
'use strict';
const fs = require('fs');

async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { return []; }
}

async function call(t, method, params = {}) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const res = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }; ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  if (res.error) throw new Error(res.error.message);
  return res.result;
}

async function page(port, urlPart) {
  const ts = await targets(port);
  return ts.find((t) => t.type === 'page' && t.url.includes(urlPart)) || null;
}

async function evaluate(port, urlPart, expression) {
  const t = await page(port, urlPart);
  if (!t) throw new Error('no page ' + urlPart);
  const r = await call(t, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function shot(port, urlPart, file) {
  const t = await page(port, urlPart);
  if (!t) throw new Error('no page ' + urlPart);
  const r = await call(t, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

module.exports = { targets, call, page, evaluate, shot };

if (require.main === module) {
  const [port, cmd, a, b] = process.argv.slice(2);
  (async () => {
    if (cmd === 'targets') console.log((await targets(port)).map((t) => t.type + ' ' + t.url).join('\n'));
    else if (cmd === 'eval') { const v = await evaluate(port, a, b); console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1)); }
    else if (cmd === 'shot') console.log(await shot(port, a, b));
  })().catch((e) => { console.error('ERR', e.message); process.exitCode = 1; });
}
