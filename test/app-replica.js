// Kopie stavu uživatele + sestavená appka skrytě, s CDP. Skutečný profil se jen ČTE (kopíruje do dočasné
// složky), nic se do něj nezapisuje. Spustí appku a čeká; ovládání přes test/app-cdp.js nebo z testu.
//   node test/app-replica.js            → vypíše REPLICA {...} a běží, dokud se neukončí (Ctrl+C / kill)
// Kopíruje: settings.json + Local State (klíč k šifrovaným klíčům, stejný Windows účet), omniroute/
// (data OmniRoute), Partitions/opencode (localStorage webu OpenCode), auth.json + opencode.db OpenCode.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const REAL_UD = path.join(process.env.APPDATA, 'czek-ai');
const REAL_OC_DATA = path.join(os.homedir(), '.local', 'share', 'opencode');

/** První port od `from`, na kterém podle netstat nic neposlouchá (synchronně; jen Windows, jinde vrací `from`). */
function freePort(from) {
  let out = '';
  try { out = require('child_process').execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }); } catch { return from; }
  const busy = new Set([...out.matchAll(/:(\d+)\s+\S+\s+LISTENING/g)].map((m) => Number(m[1])));
  let p = from;
  while (busy.has(p)) p++;
  return p;
}

function makeReplica(o = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-replica-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const ud = x('userdata');
  // po souborech: zamčený soubor (běžící appka uživatele drží Partitions, OmniRoute) se přeskočí, ne celé kopírování
  const skipped = [];
  const cp = (from, to) => {
    let st;
    try { st = fs.statSync(from); } catch { return; }
    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const n of fs.readdirSync(from)) cp(path.join(from, n), path.join(to, n));
      return;
    }
    try { fs.copyFileSync(from, to); } catch { skipped.push(from); }
  };
  for (const f of ['settings.json', 'Local State', 'usage.json', 'usage-projects.json']) cp(path.join(REAL_UD, f), path.join(ud, f));
  if (o.omniroute !== false) cp(path.join(REAL_UD, 'omniroute'), path.join(ud, 'omniroute'));
  if (o.uiState !== false) cp(path.join(REAL_UD, 'Partitions', 'opencode'), path.join(ud, 'Partitions', 'opencode'));
  const ocData = path.join(x('data'), 'opencode');
  fs.mkdirSync(ocData, { recursive: true });
  for (const f of ['auth.json', ...(o.sessions !== false ? ['opencode.db', 'opencode.db-wal', 'opencode.db-shm'] : [])]) cp(path.join(REAL_OC_DATA, f), path.join(ocData, f));
  // OpenCode konfiguraci napíše appka sama (do dočasného XDG_CONFIG_HOME)
  const ocPort = o.ocPort || Number(process.env.REPLICA_OC_PORT) || 4419; // 4096 = stejný původ jako u uživatele → jeho localStorage webu OpenCode platí
  // Port CDP: první volný od 9341. Po násilně ukončeném běhu zůstává port „LISTENING“ pod neexistujícím PID
  // (zásuvku zdědil potomek) a Electron se na něj nepřipojí → test pak čeká na okno, které nevidí (15. 11. 2×).
  const cdpPort = o.cdpPort || Number(process.env.REPLICA_CDP_PORT) || freePort(9341);
  const env = {
    ...process.env,
    ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: path.join(base, 'data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
    ZDARMA_OC_PORT: String(ocPort), ZDARMA_HIDDEN: '1',
  };
  // Replika kopíruje jen DATA OmniRoute (omniroute/), ne jeho instalaci (omniroute-app/). Bez toho by appka
  // OmniRoute v dočasném profilu nenašla a 6 min ho instalovala → okno OpenCode naběhne pozdě a test spadne na
  // „window did not appear“ / timeout. Podstrčíme existující instalaci přes ZDARMA_OMNIROUTE_ROOT (když je).
  if (o.omniroute !== false && !env.ZDARMA_OMNIROUTE_ROOT) {
    const installed = path.join(REAL_UD, 'omniroute-app', 'node_modules', 'omniroute');
    if (fs.existsSync(path.join(installed, 'bin', 'omniroute.mjs'))) env.ZDARMA_OMNIROUTE_ROOT = installed;
  }
  delete env.OPENCODE_CONFIG_DIR;
  return { base, ud, env, ocPort, cdpPort, skipped };
}

function launch(rep, exe = process.env.APP_EXE || path.join(root, 'dist', 'win-unpacked', 'czek-ai.exe')) {
  const fromSrc = !fs.existsSync(exe);
  const bin = fromSrc ? require('electron') : exe;
  const args = [...(fromSrc ? ['.'] : []), `--remote-debugging-port=${rep.cdpPort}`];
  return spawn(bin, args, { cwd: root, env: rep.env, windowsHide: true, stdio: 'ignore' });
}

module.exports = { makeReplica, launch, freePort };

if (require.main === module) {
  const rep = makeReplica();
  const child = launch(rep);
  console.log('REPLICA ' + JSON.stringify({ base: rep.base, ocPort: rep.ocPort, cdpPort: rep.cdpPort, pid: child.pid }));
  child.on('exit', (c) => { console.log('app exited', c); process.exit(0); });
}
