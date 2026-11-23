// Ověření webové aplikace z benchmarku: skrytě ji otevře v Electronu a projde ji jako uživatel.
// npx electron tools/verify-web.js <složka s index.html>  → na stdout JSON výsledek
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

const dir = path.resolve(process.argv[process.argv.length - 1]);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = { errors: [], steps: [] };
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, partition: 'verify-' + Date.now() } });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) out.errors.push(String(message).slice(0, 200)); });
  win.webContents.on('preload-error', (e, p, err) => out.errors.push(String(err).slice(0, 200)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  try {
    await win.loadFile(path.join(dir, 'index.html'));
    await wait(800);
    out.visibleText = (await ev('document.body ? document.body.innerText.trim().length : 0'));
    out.steps.push(['stránka není prázdná', out.visibleText > 0]);
    const has = await ev(`['new','add','list'].map(id => !!document.getElementById(id))`);
    out.steps.push(['prvky #new #add #list', has.every(Boolean)]);
    if (has.every(Boolean)) {
      const add = async (t) => ev(`(() => { const i = document.getElementById('new'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('add').click(); })()`);
      await add('koupit mléko'); await wait(150); await add('zavolat mámě'); await wait(150);
      const items = await ev(`[...document.querySelectorAll('#list li')].map(li => li.textContent.trim())`);
      out.steps.push(['přidání 2 úkolů', items.length === 2 && /koupit mléko/.test(items[0]) && /zavolat mámě/.test(items[1])]);
      const empty = await ev(`(() => { const n = document.querySelectorAll('#list li').length; document.getElementById('new').value = '   '; document.getElementById('add').click(); return document.querySelectorAll('#list li').length === n; })()`);
      out.steps.push(['prázdný text se nepřidá', empty]);
      await ev(`document.querySelector('#list li').click()`); await wait(150);
      out.steps.push(['kliknutí = hotovo (class done)', await ev(`document.querySelector('#list li').classList.contains('done')`)]);
      win.webContents.reload(); await wait(900);
      const after = await ev(`[...document.querySelectorAll('#list li')].map(li => [li.textContent.trim(), li.classList.contains('done')])`);
      out.steps.push(['po obnovení zůstane (localStorage)', after.length === 2 && after[0][1] === true && after[1][1] === false]);
    }
  } catch (e) { out.errors.push('načtení: ' + e.message); }
  out.steps.push(['bez chyb v konzoli', out.errors.length === 0]);
  out.ok = out.steps.every((s) => s[1]);
  process.stdout.write('VERIFY ' + JSON.stringify(out) + '\n');
  app.exit(0);
});
