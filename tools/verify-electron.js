// Ověření Electron aplikace z benchmarku: spustí její main.js uvnitř tohoto procesu, všechna okna
// skryje (průhledná, mimo obrazovku – nic nevyskočí) a projde aplikaci jako uživatel.
// <electron> tools/verify-electron.js <složka projektu> <dočasná userData>  → na stdout "VERIFY {json}"
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const [proj, userData] = process.argv.slice(-2).map((p) => path.resolve(p));
const out = { errors: [], mainErrors: [], steps: [] };
const step = (name, ok) => out.steps.push([name, !!ok]);
const finish = () => {
  step('bez chyb (konzole, main, pád rendereru)', !out.errors.length && !out.mainErrors.length);
  out.ok = out.steps.every((s) => s[1]);
  process.stdout.write('VERIFY ' + JSON.stringify(out) + '\n');
  app.exit(0);
};
process.on('uncaughtException', (e) => out.mainErrors.push(String(e?.stack || e).split('\n')[0].slice(0, 200)));
process.on('unhandledRejection', (e) => out.mainErrors.push(String(e?.stack || e).split('\n')[0].slice(0, 200)));
setTimeout(() => { out.errors.push('časový limit ověření'); finish(); }, 45000);

app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.on('browser-window-created', (_e, w) => {
  const hide = () => { try { w.setOpacity(0); w.setPosition(-30000, -30000); w.setSkipTaskbar(true); w.blur(); } catch {} };
  hide();
  w.on('show', hide);
  w.on('ready-to-show', hide);
  w.webContents.on('console-message', (e, level, message) => { if (level >= 3) out.errors.push(String(message).slice(0, 200)); });
  w.webContents.on('preload-error', (e, p, err) => out.errors.push('preload: ' + String(err).slice(0, 200)));
  w.webContents.on('render-process-gone', (e, d) => out.errors.push('renderer spadl: ' + d.reason));
});

let pkg = null;
try { pkg = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8')); } catch (e) { out.mainErrors.push('package.json: ' + e.message); }
step('package.json s "main"', pkg && pkg.main && fs.existsSync(path.join(proj, pkg.main)));
if (pkg?.main && fs.existsSync(path.join(proj, pkg.main))) {
  process.chdir(proj);
  // jako spuštění `electron .`: loadFile() a getAppPath() se vztahují ke složce projektu
  if (typeof app.setAppPath === 'function') app.setAppPath(proj);
  if (pkg.productName || pkg.name) app.setName(pkg.productName || pkg.name);
  app.setPath('userData', userData); // setName výše by userData jinak přesměroval
  try { require(path.join(proj, pkg.main)); } catch (e) { out.mainErrors.push('main.js: ' + String(e.message).slice(0, 200)); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 40 && !win; i++) { await wait(250); win = BrowserWindow.getAllWindows()[0] || null; }
  step('okno se otevře', win);
  if (!win) return finish();
  const wc = win.webContents;
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  await wait(1000);
  const ev = (js) => wc.executeJavaScript(js, true);
  try {
    step('okno není prázdné', (await ev('document.body ? document.body.innerText.trim().length : 0')) > 0);
    step('preload: window.notes (list/save/remove)', await ev(`!!(window.notes && ['list','save','remove'].every(k => typeof window.notes[k] === 'function'))`));
    step('bezpečnost: v okně není require/process', await ev(`typeof require === 'undefined' && typeof process === 'undefined'`));
    const has = await ev(`['title','body','save','notes'].map(id => !!document.getElementById(id))`);
    step('prvky #title #body #save #notes', has.every(Boolean));
    if (has.every(Boolean)) {
      const save = (title, body) => ev(`(() => { const t = document.getElementById('title'), b = document.getElementById('body'); t.value = ${JSON.stringify(title)}; b.value = ${JSON.stringify(body)}; t.dispatchEvent(new Event('input', {bubbles:true})); b.dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('save').click(); })()`);
      const titles = () => ev(`[...document.querySelectorAll('#notes li')].map(li => li.textContent)`);
      await save('Nákup', 'mléko, chleba'); await wait(600);
      await save('Práce', 'dopsat report'); await wait(600);
      const t1 = await titles();
      step('uložení 2 poznámek', t1.length === 2 && t1.some((x) => /Nákup/.test(x)) && t1.some((x) => /Práce/.test(x)));
      await save('   ', 'nic'); await wait(500);
      step('prázdný titulek se neuloží', (await titles()).length === t1.length);
      const file = path.join(userData, 'notes.json');
      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const diskText = JSON.stringify(disk || '');
      step('notes.json v userData obsahuje poznámky', /Nákup/.test(diskText) && /Práce/.test(diskText));
      wc.reload(); await new Promise((r) => wc.once('did-finish-load', r)); await wait(1000);
      const t2 = await titles();
      step('po znovunačtení poznámky zůstanou', t2.length === 2);
      await ev(`(() => { const li = [...document.querySelectorAll('#notes li')].find(l => /Nákup/.test(l.textContent)); li && li.querySelector('.delete') && li.querySelector('.delete').click(); })()`);
      await wait(700);
      const t3 = await titles();
      let disk2 = '';
      try { disk2 = fs.readFileSync(file, 'utf8'); } catch {}
      step('smazání (.delete) odstraní z okna i ze souboru', t3.length === 1 && !/Nákup/.test(t3.join()) && !/Nákup/.test(disk2) && /Práce/.test(disk2));
    }
  } catch (e) { out.errors.push('ověření: ' + String(e.message).slice(0, 200)); }
  finish();
});
