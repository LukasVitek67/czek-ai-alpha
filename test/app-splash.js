// Celá aplikace skrytě (izolovaný profil, bez OpenCode v systému): úvodní okno se ukáže hned, OpenCode se
// sám stáhne, pak se otevře okno OpenCode a úvodní okno zmizí. Snímky úvodního okna jdou do SPLASH_SHOTS.
// node test/app-splash.js   (~1–2 min, stahuje ~70 MB; s OPENCODE_BIN přeskočí stahování)
// Bez OmniRoute (izolované APPDATA) úvodní okno počká na jeho instalaci a ukáže průběh (počet balíčků);
// okno OpenCode se pak otevře rovnou s OmniRoute (~3–10 min, npm cache zrychlí). ZDARMA_OMNIROUTE_ROOT = přeskočit.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
// DIACRITIC=1: profil v cestě s diakritikou a mezerou (student „Šimon Novák“). Se systémovým Node 24.12 padala
// instalace OmniRoute (fs.cpSync v postinstall); czek-ai má přejít na přenosný Node (log „padá na fs.cpSync“).
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), process.env.DIACRITIC ? 'zd-splash-účet Šimon Novák-' : 'zd-splash-')));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const shots = process.env.SPLASH_SHOTS || x('shots');
const cdpPort = 9339;
const env = {
  ...process.env,
  ZDARMA_USER_DATA: x('userdata'), XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: '4319', ZDARMA_HIDDEN: '1', APPDATA: x('appdata'), // APPDATA: ani globální npm OpenCode/OmniRoute
};
delete env.OPENCODE_CONFIG_DIR;
// PLUG=1: čistý PC i bez Gitu a Node.js → appka stáhne OpenCode + PortableGit, otevře okno, na pozadí
// stáhne Node.js + OmniRoute a po instalaci OpenCode přepne na OmniRoute (~5–15 min).
const PLUG = !!process.env.PLUG;
if (process.env.WIZ === '1') env.ZDARMA_WIZARD = '1';
if (PLUG) { env.ZDARMA_IGNORE_SYSTEM_GIT = '1'; env.ZDARMA_IGNORE_SYSTEM_NODE = '1'; }
if (!process.env.KEEP_PATH) env.PATH = String(process.env.PATH).split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'opencode.exe'))).join(path.delimiter);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// OFFLINE_MS=25000: prvních N ms „bez internetu“ (lokální registr npm zavírá spojení), pak propouští na
// registry.npmjs.org → appka má v úvodním okně ukázat „Není připojení…“, zkoušet znovu a OpenCode stáhnout.
// OMNI_ROOT=<…/node_modules/omniroute> přeskočí 7min instalaci OmniRoute (test je o stahování OpenCode).
const OFFLINE_MS = Number(process.env.OFFLINE_MS) || 0;
const offline = { refused: 0, sawMsg: '' };
if (OFFLINE_MS) {
  const http = require('http');
  offline.until = () => offline.start + OFFLINE_MS;
  const srv = http.createServer(async (req, res) => {
    if (!offline.start || Date.now() < offline.until()) { offline.refused++; req.socket.destroy(); return; }
    try {
      const r = await fetch('https://registry.npmjs.org' + req.url, { headers: { accept: req.headers.accept || '*/*' } });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502); res.end(String(e)); }
  }).listen(0, '127.0.0.1');
  srv.on('listening', () => { env.ZDARMA_NPM_REGISTRY = `http://127.0.0.1:${srv.address().port}`; });
  env.ZDARMA_OFFLINE_RETRY_MS = '3000';
  srv.unref();
}
if (process.env.OMNI_ROOT) env.ZDARMA_OMNIROUTE_ROOT = process.env.OMNI_ROOT;
// CLASS=<složka czek-ai-cache z --priprav-tridu>: instalace ze složky pro třídu bez internetu. OpenCode: registr
// czek-ai na mrtvém portu. npm: proxy na mrtvém portu (registr musí zůstat registry.npmjs.org, je v klíčích cache),
// takže projde jen to, co je ve složce; Node.js a Git musí přijít z ní (log [třída]).
const CLASS = process.env.CLASS || '';
if (CLASS) {
  env.ZDARMA_CLASS_CACHE = CLASS;
  env.ZDARMA_NPM_REGISTRY = 'http://127.0.0.1:9';
  env.npm_config_proxy = env.npm_config_https_proxy = 'http://127.0.0.1:9';
  env.npm_config_fetch_retries = '0';
}
const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); } catch { return []; } };
async function cdp(t, method, params = {}) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  // okno se může zavřít uprostřed dotazu (úvodní okno po startu) → bez onclose/limitu test visel navždy
  const res = await new Promise((r) => {
    const t = setTimeout(() => r({}), 5000);
    ws.onmessage = (m) => { clearTimeout(t); r(JSON.parse(m.data)); };
    ws.onclose = () => { clearTimeout(t); r({}); };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  try { ws.close(); } catch {}
  return res.result;
}

(async () => {
  // APP_EXE=dist/win-unpacked/czek-ai.exe otestuje sestavenou aplikaci místo zdrojáků
  const exe = process.env.APP_EXE || require('electron');
  const args = process.env.APP_EXE ? [`--remote-debugging-port=${cdpPort}`] : ['.', `--remote-debugging-port=${cdpPort}`];
  if (OFFLINE_MS) { while (!/:\d{2,}$/.test(env.ZDARMA_NPM_REGISTRY)) await wait(20); offline.start = Date.now(); }
  const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  const t0 = Date.now();
  const seen = { splashAt: 0, downloadShot: false, steps: null, ocAt: 0, wizAt: 0, splashGoneAt: 0, omniPct: 0, omniDetail: '', omniShot: false };
  try {
    for (let i = 0; i < 2400; i++) { // až 12 min (instalace OmniRoute)
      const ts = await targets();
      const sp = ts.find((t) => t.type === 'page' && t.url.includes('splash.html'));
      const oc = ts.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:4319'));
      if (sp) {
        if (!seen.splashAt) seen.splashAt = Date.now() - t0;
        const st = await cdp(sp, 'Runtime.evaluate', { expression: 'JSON.stringify([...document.querySelectorAll("li")].map(l => [l.dataset.id, l.className, l.querySelector(".detail")?.textContent || "", parseFloat(l.querySelector(".bar > i")?.style.width) || 0]))', returnByValue: true }).catch(() => null);
        const steps = st?.result?.value ? JSON.parse(st.result.value) : null;
        if (steps) seen.steps = steps;
        const off = steps?.find((s) => s[0] === 'opencode' && /Není připojení|No internet/.test(s[2]));
        if (off && !offline.sawMsg) offline.sawMsg = off[2];
        const dl = steps?.find((s) => s[0] === 'opencode' && s[1] === 'run' && /MB/.test(s[2]));
        const om = steps?.find((s) => s[0] === 'omni' && s[1] === 'run' && /balíčk|packages|MB/.test(s[2]));
        if (om && om[3] > seen.omniPct) { seen.omniPct = om[3]; seen.omniDetail = om[2]; }
        if (om && om[3] > 40 && !seen.omniShot) {
          const shot = await cdp(sp, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
          if (shot?.data) { fs.writeFileSync(path.join(shots, 'splash-omni.png'), Buffer.from(shot.data, 'base64')); seen.omniShot = true; }
        }
        if ((dl && !seen.downloadShot) || i === 2) {
          const shot = await cdp(sp, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
          if (shot?.data) fs.writeFileSync(path.join(shots, dl ? 'splash-download.png' : 'splash-start.png'), Buffer.from(shot.data, 'base64'));
          if (dl) seen.downloadShot = true;
        }
      }
      if (oc && !seen.ocAt) seen.ocAt = Date.now() - t0;
      if (!seen.wizAt && ts.find((t) => t.type === 'page' && t.url.includes('index.html'))) seen.wizAt = Date.now() - t0;
      if (seen.ocAt && !sp) { seen.splashGoneAt = Date.now() - t0; break; }
      await wait(300);
    }
    const log = fs.readFileSync(path.join(env.ZDARMA_USER_DATA, 'zdarma.log'), 'utf8');
    assert.ok(seen.splashAt && seen.splashAt < 8000, 'splash shown quickly: ' + seen.splashAt);
    assert.ok(seen.ocAt, 'OpenCode window loaded');
    assert.ok(seen.splashGoneAt, 'splash closed after OpenCode window');
    if (!process.env.OPENCODE_BIN) {
      assert.match(log, /\[install\] OpenCode nainstalován/, 'auto-install in log');
      assert.ok(fs.existsSync(path.join(env.ZDARMA_USER_DATA, 'opencode-bin', 'opencode.exe')), 'binary in app data');
      if (!CLASS) assert.ok(seen.downloadShot, 'download progress was visible');
    }
    if (!env.ZDARMA_OMNIROUTE_ROOT) {
      // log čtený hned po zavření úvodního okna: instalace musí být hotová už teď (dřív okno zmizelo před ní)
      assert.ok(log.includes('[install] OmniRoute nainstalován'), 'OmniRoute installed while the splash was open: ' + (log.match(/\[install\] OmniRoute selhal.*/) || [''])[0]);
      if (process.env.DIACRITIC) console.log('  diakritika v profilu:', (log.match(/\[install\] Node\.js [^\n]*(padá|chybí)[^\n]*/) || ['systémový Node prošel zkouškou (cpSync v pořádku)'])[0].slice(0, 200));
      assert.ok(seen.omniPct > 40, 'package progress visible in the splash: ' + seen.omniPct + ' ' + seen.omniDetail);
      const cfg = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8'));
      assert.ok(cfg.plugin.some((p) => Array.isArray(p) && p[1]?.providerId === 'omniroute'), 'OpenCode opened straight with OmniRoute');
      console.log(`  úvodní okno: OmniRoute průběh až ${Math.round(seen.omniPct)} % („${seen.omniDetail}“), pak OpenCode rovnou s OmniRoute`);
    }
    if (OFFLINE_MS) {
      console.log(`  bez internetu ${OFFLINE_MS / 1000} s: odmítnuto ${offline.refused} spojení, úvodní okno: „${offline.sawMsg}“, OpenCode okno za ${Math.round(seen.ocAt / 1000)} s`);
      assert.ok(offline.refused > 0, 'the app tried while offline');
      assert.match(offline.sawMsg, /Není připojení/, 'Czech offline message on the splash');
      assert.ok(seen.ocAt > OFFLINE_MS, 'OpenCode window opened after the connection came back');
    }
    // WIZ=1 (profil bez klíčů): průvodce klíči se má na čistém PC otevřít během instalace OmniRoute, ne až po ní
    if (process.env.WIZ === '1') {
      console.log(`  průvodce klíči za ${Math.round(seen.wizAt / 1000)} s (OpenCode okno za ${Math.round(seen.ocAt / 1000)} s)`);
      assert.ok(seen.wizAt, 'key guide opened');
      if (PLUG) assert.ok(seen.wizAt < seen.ocAt - 60000, 'key guide opens during the OmniRoute install, not after it');
    }
    console.log(`app-splash OK (úvodní okno za ${seen.splashAt} ms, OpenCode okno za ${Math.round(seen.ocAt / 1000)} s, poslední kroky ${JSON.stringify(seen.steps)})`);
    if (PLUG) {
      assert.match(log, /\[install\] Git Bash nainstalován/, 'PortableGit installed');
      assert.ok(fs.existsSync(path.join(env.ZDARMA_USER_DATA, 'git', 'bin', 'bash.exe')));
      const cfgFile = path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
      let switched = false, lg = '';
      for (let i = 0; i < 1200 && !switched; i++) { // až 20 min
        await wait(1000);
        lg = fs.readFileSync(path.join(env.ZDARMA_USER_DATA, 'zdarma.log'), 'utf8');
        if (/\[install\] OmniRoute selhal/.test(lg)) break;
        try { switched = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).plugin.some((p) => Array.isArray(p) && p[1]?.providerId === 'omniroute'); } catch {}
        if (i % 60 === 0) console.log(`  … ${Math.round((Date.now() - t0) / 1000)} s`, (lg.match(/\[install\][^\n]*/g) || []).slice(-1)[0] || '');
      }
      assert.match(lg, /\[install\] Node\.js chybí/, 'portable Node path used');
      if (CLASS) {
        for (const re of [/\[třída\] instaluji ze složky/, /\[třída\] opencode ze složky/, /\[třída\] git ze složky/, /\[třída\] Node\.js ze složky/, /\[třída\] (cache npm zkopírována|OmniRoute rozbalen z archivu)/]) assert.match(lg, re, 'class folder used: ' + re);
        console.log('  složka pro třídu:', (lg.match(/\[třída\][^\n]*/g) || []).join(' | '));
      }
      assert.match(lg, /\[install\] OmniRoute nainstalován/, 'OmniRoute installed: ' + (lg.match(/\[install\] OmniRoute selhal[^\n]*/) || [''])[0]);
      assert.ok(switched, 'OpenCode config switched to OmniRoute');
      await wait(5000);
      const oc2 = (await targets()).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:4319'));
      assert.ok(oc2, 'OpenCode window still there after switch');
      console.log(`app-splash PLUG OK (OmniRoute nainstalován a OpenCode přepnut za ${Math.round((Date.now() - t0) / 1000)} s)`);
    }
    console.log('snímky:', shots);
  } finally {
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } else { try { child.kill('SIGKILL'); } catch {} }
    if (!process.env.SPLASH_SHOTS) setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 2000);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
