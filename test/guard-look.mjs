// Nástroj look (src/guard/look.mjs + look.ps1): snímek okna appky (PrintWindow, i okno mimo obrazovku / za jinými),
// ořez na vykreslenou oblast, popis od modelu s viděním přes czek-ai (/czek/vision), výchozí cíl = poslední spuštěná
// appka, nenalezené okno → jen názvy procesů (žádné titulky cizích oken k poskytovateli). Okno testu je mimo obrazovku
// a bez ikony na liště (uživatel nic nevidí).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { capture, lookTool, LOOK_PROMPT } from '../src/guard/look.mjs';

if (process.platform !== 'win32') { console.log('guard-look SKIP (jen Windows)'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-look-'));
const ps1 = path.join(dir, 'win.ps1');
const TITLE = 'CzekLookTest' + process.pid;
fs.writeFileSync(ps1, `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = '${TITLE}'; $f.ShowInTaskbar = $false; $f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(-3000, -3000); $f.Size = New-Object System.Drawing.Size(520, 320)
$f.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 46)
$l = New-Object System.Windows.Forms.Label; $l.Text = 'FURRYBEE LOOK 42'; $l.ForeColor = [System.Drawing.Color]::White
$l.Font = New-Object System.Drawing.Font('Arial', 22); $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point(20, 20); $f.Controls.Add($l)
$p = New-Object System.Windows.Forms.Panel; $p.BackColor = [System.Drawing.Color]::Red; $p.Location = New-Object System.Drawing.Point(20, 120); $p.Size = New-Object System.Drawing.Size(200, 100); $f.Controls.Add($p)
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 40000; $t.Add_Tick({ $f.Close() }); $t.Start()
[void]$f.ShowDialog()
`);
const win = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// falešné vidění czek-ai (/czek/vision)
const got = [];
const vis = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => { const b = JSON.parse(raw); got.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: 'Dark window, text "FURRYBEE LOOK 42" top-left, red rectangle below. Problems: none.', model: 'qwen3-vl-30b' })); });
});
await new Promise((r) => vis.listen(0, '127.0.0.1', r));
const visionUrl = `http://127.0.0.1:${vis.address().port}/czek/vision`;

try {
  let shot = { error: 'not found' };
  for (let i = 0; i < 20 && shot.error; i++) { await wait(500); shot = await capture({ target: TITLE, out: path.join(dir, 'a.png') }); }
  assert.ok(!shot.error, 'okno nalezeno: ' + JSON.stringify(shot));
  assert.strictEqual(shot.title, TITLE);
  assert.strictEqual(shot.method, 'PrintWindow', 'okno mimo obrazovku zachyceno bez přenesení do popředí');
  assert.ok(shot.width >= 500 && shot.width <= 540 && shot.height >= 300 && shot.height <= 340, 'oříznuto na vykreslenou oblast: ' + shot.width + '×' + shot.height);
  const png = fs.readFileSync(shot.file);
  assert.ok(png.slice(1, 4).toString() === 'PNG' && png.length > 2000, 'PNG');

  // nástroj tak, jak ho volá OpenCode (falešné API pluginu: tool(def) → def, schema → řetězec s optional/describe)
  const s = () => { const o = { optional: () => o, describe: () => o }; return o; };
  const plug = { tool: Object.assign((def) => def, { schema: { string: s } }) };
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-look-proj-'));
  const t = lookTool(plug, { directory: proj }, { lastApp: (id) => (id === 'ses1' ? TITLE : null), visionUrl: () => visionUrl });
  assert.match(t.description, /Never tell the user a GUI works without having looked/);
  let out = await t.execute({ question: 'Is the red panel visible?' }, { sessionID: 'ses1', directory: proj });
  assert.match(out, new RegExp(`Screenshot of "${TITLE}"`));
  assert.match(out, /qwen3-vl-30b/); assert.match(out, /FURRYBEE LOOK 42/);
  const saved = /saved as (.+?\.png)\./.exec(out)[1];
  assert.ok(saved.startsWith(path.join(proj, '.czek', 'screenshots')) && fs.existsSync(saved), 'PNG v projektu');
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].images[0].startsWith('data:image/png;base64,'), 'snímek jde jako data URL');
  assert.ok(got[0].prompt.startsWith(LOOK_PROMPT.slice(0, 40)) && /The developer asks: Is the red panel visible\?/.test(got[0].prompt), 'otázka agenta v dotazu');
  // bez cíle a bez spuštěné appky → pokyn
  out = await t.execute({}, { sessionID: 'jina', directory: proj });
  assert.match(out, /No app to look at/);
  // neexistující okno → jen názvy procesů, žádné titulky
  out = await t.execute({ target: 'NeexistujiciOkno' + process.pid }, { sessionID: 'x', directory: proj });
  assert.match(out, /No visible window found/);
  assert.ok(!out.includes(TITLE), 'titulky oken se nevypisují');
  assert.match(out, /powershell/i, 'názvy procesů ano');
  // vidění nedostupné → aspoň cesta k PNG
  const t2 = lookTool(plug, { directory: proj }, { lastApp: () => TITLE, visionUrl: () => undefined });
  out = await t2.execute({}, { sessionID: 's', directory: proj });
  assert.match(out, /No vision model is available/);
  console.log(`guard-look OK (okno mimo obrazovku ${shot.width}×${shot.height} přes PrintWindow, popis přes /czek/vision, výchozí cíl, bez titulků cizích oken)`);
} finally {
  try { win.kill(); } catch {}
  vis.close();
}
