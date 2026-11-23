// Mini CDP klient pro testování UI běžící appky (spuštěné s --remote-debugging-port).
// node tools/cdp.js <port> eval "<výraz>"   |   node tools/cdp.js <port> shot <soubor.png> [šířka výška]
// CDP_URL=<část adresy> vybere konkrétní okno (např. CDP_URL=picker.html), jinak první stránka.
const [port, cmd, arg, w, h] = process.argv.slice(2);
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const t = targets.find((x) => x.type === 'page' && (!process.env.CDP_URL || x.url.includes(process.env.CDP_URL)));
  if (!t) throw new Error(`Okno ${process.env.CDP_URL || ''} nenalezeno`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  if (cmd === 'eval') {
    const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
    console.log(r.result?.exceptionDetails ? 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 800) : JSON.stringify(r.result?.result?.value, null, 1));
  } else if (cmd === 'shot') {
    if (w) await call('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
    const r = await call('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
    console.log('ok', arg);
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
