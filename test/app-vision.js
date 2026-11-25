// Obrázek v CELÉ appce se skutečnými modely (kopie stavu uživatele, test/app-replica.js): uživatel pošle obrázek
// s nápisem, tier Max (model bez vidění) má odpovědět, co na něm je. Projde jen celý řetězec: plugin hlásí obrázky →
// OpenCode obrázek pošle → proxy závodu ho uloží do projektu a nechá popsat modelem s viděním (OmniRoute) → model
// tieru dostane popis. Živě 20. 11.: obrázek se k modelu nedostal vůbec („Cannot read image.png“).
//   node test/app-vision.js   (APP_EXE=none = ze zdrojáků; REPLICA_OC_PORT, výchozí 4423)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeReplica, launch, freePort } = require('./app-replica');
const cdp = require('./app-cdp');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const OC_PORT = Number(process.env.REPLICA_OC_PORT) || 4423;
  const rep = makeReplica({ ocPort: OC_PORT, cdpPort: freePort(9347), sessions: false, uiState: false });
  rep.env.CZEK_FULL_LOG = '1';
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-vision-proj-')));
  // obrázek s nápisem (System.Drawing)
  const png = path.join(work, 'src.png');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap 420,200; $g=[System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $g.FillRectangle([System.Drawing.Brushes]::Red,20,120,120,60); $f=New-Object System.Drawing.Font('Arial',30); $g.DrawString('FURRYBEE 42',$f,[System.Drawing.Brushes]::Black,20,30); $b.Save('${png}',[System.Drawing.Imaging.ImageFormat]::Png)`], { windowsHide: true });
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
  fs.unlinkSync(png);
  const child = launch(rep);
  const u = `http://127.0.0.1:${OC_PORT}`;
  const q = '?directory=' + encodeURIComponent(work);
  try {
    let ok = false;
    for (let i = 0; i < 300 && !ok; i++) { ok = !!(await cdp.page(rep.cdpPort, `127.0.0.1:${OC_PORT}`).catch(() => null)); if (!ok) await wait(1000); }
    assert.ok(ok, 'OpenCode window did not appear');
    await wait(8000);
    const s = await (await fetch(u + '/session' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const t0 = Date.now();
    const r = await fetch(u + `/session/${s.id}/message` + q, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(300000),
      body: JSON.stringify({ model: { providerID: 'opencode-omniroute', modelID: 'zdarma-max' }, parts: [
        { type: 'text', text: 'What text is written in the attached image, and what colour is the shape under it? Answer in one short sentence. Do not use any tools.' },
        { type: 'file', mime: 'image/png', filename: 'pic.png', url: dataUrl }] }) });
    const answer = await r.json().catch(() => ({}));
    const text = (answer.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
    console.log(`odpověď modelu (${Math.round((Date.now() - t0) / 1000)} s):`, JSON.stringify(text).slice(0, 300), answer.info?.error ? 'CHYBA ' + JSON.stringify(answer.info.error).slice(0, 200) : '');
    const imgDir = path.join(work, '.czek', 'obrazky');
    const files = fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : [];
    console.log('soubory v projektu:', files.join(', '));
    const desc = files.filter((f) => f.endsWith('.txt')).map((f) => JSON.parse(fs.readFileSync(path.join(imgDir, f), 'utf8')))[0];
    console.log('popis od modelu s viděním:', desc ? `${desc.model}: ${String(desc.text).slice(0, 200)}` : 'žádný');
    assert.ok(files.some((f) => f.endsWith('.png')), 'image saved in the project (.czek/obrazky)');
    assert.ok(desc && /FURRYBEE\s*42/i.test(desc.text), 'a vision model read the image');
    assert.match(text, /FURRYBEE\s*42/i, 'the tier model answered from the description');
    assert.match(text, /red/i, 'and knows the colour');
    console.log(`app-vision OK (obrázek → ${desc.model} → tier Max odpověděl „${text.trim().slice(0, 80)}“)`);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    setTimeout(() => { try { fs.rmSync(rep.base, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch {} }, 3000);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
