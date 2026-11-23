// Jak dlouho čeká student na appku: CELÁ appka ze zdrojáků (skrytě, dočasný profil s klíči, OmniRoute už nainstalovaný),
// čas od spuštění do okna OpenCode s načteným výběrem modelů – 1. start (čistá data OmniRoute: zápis všech combo)
// a 2. start téhož profilu (combo už existují). Linux i Windows.
//   OPENCODE_BIN=<opencode> ZDARMA_OMNIROUTE_ROOT=<omniroute> node test/app-start-time.js [počet startů=2]
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./app-cdp');

const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = Number(process.env.STARTTIME_CDP_PORT) || 9357;
const OC_PORT = Number(process.env.STARTTIME_OC_PORT) || 4439;
const N = Number(process.argv[2]) || 2;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-starttime-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const ud = x('userdata');
let keys = {};
try { keys = require('../private/keys.json').providers || {}; } catch {}
const providers = Object.fromEntries(Object.entries(keys).map(([id, k]) => [id, { enabled: true, key: k }]));
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'omniroute', lang: 'cs', providers, wizardDone: true }));
const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: String(OC_PORT), ZDARMA_HIDDEN: '1' };
delete env.OPENCODE_CONFIG_DIR;

/** Kolik modelů nabízí OpenCode (plugin OmniRoute) – výběr modelů očima uživatele. */
async function offered() {
  try {
    const pv = await (await fetch(`http://127.0.0.1:${OC_PORT}/config/providers`, { signal: AbortSignal.timeout(5000) })).json();
    const p = (pv.providers || []).find((q) => /omniroute/.test(q.id));
    return p ? Object.keys(p.models || {}).length : 0;
  } catch { return 0; }
}

async function once(label) {
  const t0 = Date.now();
  const child = spawn(require('electron'), ['.', '--password-store=basic', `--remote-debugging-port=${CDP}`], { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' });
  const r = { label };
  try {
    for (let i = 0; i < 600 && r.windowS == null; i++) { if (await cdp.page(CDP, `127.0.0.1:${OC_PORT}`).catch(() => null)) r.windowS = (Date.now() - t0) / 1000; else await wait(500); }
    for (let i = 0; i < 300 && !r.models; i++) { const n = await offered(); if (n > 0) { r.models = n; r.modelsS = (Date.now() - t0) / 1000; } else await wait(500); }
    const log = fs.readFileSync(path.join(ud, 'zdarma.log'), 'utf8');
    const runs = log.split('[app] start').length - 1;
    const last = log.split('[app] start').pop();
    const sync = /\[omniroute\] sync: (\d+) požadavků za ([\d.]+) s/.exec(last);
    const combos = /zapsáno combo: (\d+)/.exec(last);
    r.syncS = sync ? Number(sync[2]) : null; r.syncRequests = sync ? Number(sync[1]) : null; r.combosWritten = combos ? Number(combos[1]) : null;
    r.appRuns = runs;
  } finally {
    try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {}
    await wait(3000);
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {}
    await wait(1000);
  }
  return r;
}

(async () => {
  const out = [];
  for (let i = 1; i <= N; i++) { const r = await once(`${i}. start`); out.push(r); console.log(JSON.stringify(r)); }
  assert.ok(out.every((r) => r.windowS != null && r.models > 0), 'OpenCode window with models on every start');
  if (out.length > 1) console.log(`app-start-time OK: 1. start ${out[0].modelsS} s, 2. start ${out[1].modelsS} s do výběru modelů (combo zapsáno ${out[0].combosWritten} → ${out[1].combosWritten})`);
  if (process.env.STARTTIME_KEEP_LOG) fs.copyFileSync(path.join(ud, 'zdarma.log'), process.env.STARTTIME_KEEP_LOG);
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('app-start-time FAILED:', e.message); process.exit(1); });
