'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeTheme, Menu, session, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { ModelRegistry, Agent } = require('./agent');
const { PROVIDERS, scoreModel, chatUrlOf } = require('./providers');
const { streamChat } = require('./llm');
const horde = require('./horde');
const { createProxy, listen } = require('./proxy');
const opencode = require('./opencode');
const ocWatch = require('./ocWatch');
const { OpencodeServer } = require('./opencodeServer');
const ocPatch = require('./ocPatch');
const WIZARD = require('./wizard');
const { FullLog, collapseConsole } = require('./fullLog');
// Úplný log (src/fullLog.js). Vzniká po načtení nastavení; do té doby se nic nezapisuje.
let fullLog = null;
// Každá akce z oken appky (IPC): kanál, data, výsledek / chyba. Stejné opakované volání (dotazování po 3 s)
// se jen počítá a souhrn se zapíše jednou za 5 min – počet se neztratí.
{
  const lastArgs = new Map();
  const repeats = new Map();
  const argStr = (a) => { try { return JSON.stringify(a); } catch { return String(a); } };
  const note = (kind, ch, args) => {
    if (!fullLog) return false;
    const s = argStr(args);
    if (lastArgs.get(ch) === s) { repeats.set(ch, (repeats.get(ch) || 0) + 1); return false; }
    lastArgs.set(ch, s);
    fullLog.write('app', kind, `Akce v appce: ${ch}`, { channel: ch, args });
    return true;
  };
  setInterval(() => {
    if (!fullLog || !repeats.size) return;
    fullLog.write('app', 'ipc-repeats', 'Opakovaná stejná volání za posledních 5 min', Object.fromEntries(repeats));
    repeats.clear();
  }, 300000).unref?.();
  const h = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (ch, fn) => h(ch, async (e, ...args) => {
    const logged = note('ipc', ch, args);
    try {
      const r = await fn(e, ...args);
      if (logged && fullLog) fullLog.write('app', 'ipc-result', `Výsledek akce ${ch}`, { channel: ch, result: r });
      return r;
    } catch (err) {
      if (fullLog) fullLog.write('app', 'ipc-error', `Akce ${ch} SELHALA: ${err?.message || err}`, { channel: ch, args, error: err?.stack || String(err) });
      throw err;
    }
  });
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.on = (ch, fn) => on(ch, (e, ...args) => { note('ipc-send', ch, args); return fn(e, ...args); });
}
// Okno OpenCode má vlastní relaci: úprava načítání (protocol.handle) se tak týká jen jeho, ne ostatních oken.
const OC_PARTITION = 'persist:opencode';
const tiers = require('./tiers');
const { Usage } = require('./usage');
const skills = require('./skills');
const { OmniRoute, find: findOmni, findNode, setLocal: setOmniLocal, isTestRow } = require('./omniroute');
const { createRaceProxy } = require('./race');
const { CallLog } = require('./callLog');
const { Monitor, alertText } = require('./monitor');
// Úplný záznam volání modelů (src/callLog.js) – běží spolu s úplným logem; monitor (src/monitor.js) – vždy.
let callLog = null;
const monitor = new Monitor({ logDir: () => FULLLOG_DIR() }); // líně: testy mění profil až po načtení modulu
const I18N = require('./i18n');
const diag = require('./diagnostics');
const DIAG_DIR = () => path.join(DATA(), 'diagnostics');
let traceWrite = null; // záznam každého požadavku proxy (diagnostics/requests.jsonl)
// Živý záznam (proxy + kroky agenta v OpenCode) a plné zachycení požadavků/odpovědí – pro rozbor zvenku.
let liveW = null, fullW = null;
const LIVE_FILE = () => path.join(DIAG_DIR(), 'live.jsonl');
const FULL_FILE = () => path.join(DIAG_DIR(), 'full.jsonl');
const liveWrite = (r) => (liveW ||= diag.jsonlWriter(LIVE_FILE(), 20 * 1024 * 1024))(r);
const fullWrite = (r) => (fullW ||= diag.jsonlWriter(FULL_FILE(), 60 * 1024 * 1024))(r);
const { findOpencode, findGitBash, setLocalDir: setOcLocalDir, setLocalGitDir } = require('./opencodeServer');
const { installOpencode, installNode, installGit, installOmniroute, prepareClassCache, findClassCache, setClassCache, cpSyncBroken, classTar, NODE: PORTABLE_NODE } = require('./installer');

const VERSION = require('../package.json').version;
// `Zdarma.exe --proxy`: bez okna, jen lokální server pro OpenCode.
const HEADLESS = process.argv.includes('--proxy');
// Výchozí okno je OpenCode (proxy + server OpenCode na pozadí). `--classic` otevře původní chat Zdarmy.
// (`--opencode` zůstává kvůli starým zástupcům, dělá totéž co výchozí spuštění.)
const CLASSIC = process.argv.includes('--classic');

// Testy/harness mohou podstrčit vlastní profil, ať nesahají na skutečná data.
if (process.env.ZDARMA_USER_DATA) app.setPath('userData', process.env.ZDARMA_USER_DATA);
// Jazyk prohlížeče oken (data, „před 3 minutami“ v OpenCode) podle jazyka Zdarmy – musí být před startem.
try {
  const l = JSON.parse(require('fs').readFileSync(require('path').join(app.getPath('userData'), 'settings.json'), 'utf8')).lang;
  app.commandLine.appendSwitch('lang', l === 'en' ? 'en-US' : 'cs');
} catch {}
if (process.env.ZDARMA_HIDDEN) {
  // okno mimo obrazovku musí dál kreslit, jinak screenshoty přes CDP visí
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

const DATA = () => app.getPath('userData');
// Veřejný tierlist (src/publicTier.js): souhrn volání modelů na web, odtud odsunutí modelů, které jinde nefungují.
// Až za VERSION a DATA: dřív na začátku souboru → ReferenceError při načtení, appka nenastartovala (23. 11.).
const { PublicTier } = require('./publicTier');
const publicTier = new PublicTier({ dataDir: () => DATA(), version: VERSION, settings: () => settings, saveSettings: () => saveSettings(), getOmni: () => omni, log: (...a) => logLine(...a) });
let publicTierTimer = null;
/** Každých 10 min nové řádky volání z OmniRoute, každých 20 min odeslání + stažení souhrnu (server: max 4/h z instalace). */
function startPublicTier() {
  clearInterval(publicTierTimer);
  let n = 0;
  const tick = async () => {
    n++;
    if (omni?.ready) { try { publicTier.ingest(await omni.api('GET', '/api/usage/call-logs?limit=300')); } catch {} }
    if (n % 2 === 0) { await publicTier.flush(); await publicTier.pull(); }
  };
  publicTierTimer = setInterval(() => { tick().catch(() => {}); }, Number(process.env.ZDARMA_PUBLIC_TIER_MS) || 10 * 60000);
  publicTierTimer.unref?.();
  publicTier.pull().catch(() => {});
}

// Diagnostický log (pády oken, chyby načtení) – %APPDATA%\Zdarma\zdarma.log, max ~1 MB.
function logLine(...parts) {
  try {
    const f = path.join(DATA(), 'zdarma.log');
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.old'); } catch {}
    const text = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    fs.appendFileSync(f, `${new Date().toISOString()} ${text}\n`);
    if (fullLog) fullLog.write('app', 'log', text);
  } catch {}
}
function watchWindow(w, name) {
  w.webContents.on('render-process-gone', (_e, d) => { logLine(`[${name}] renderer gone`, d); if (name === 'opencode') recoverOpencodeGone(d && d.reason); });
  w.webContents.on('did-fail-load', (_e, code, desc, url) => logLine(`[${name}] did-fail-load`, code, desc, url));
  w.webContents.on('preload-error', (_e, p, err) => logLine(`[${name}] preload-error`, p, err?.stack || String(err)));
  w.webContents.on('console-message', (e, level, message) => {
    const m = typeof e?.message === 'string' ? e.message : message;
    const lv = e?.level ?? level;
    if (collapseConsole(m) === 'repeat') return; // šum (ResizeObserver, powerPreference): jen počet v souhrnu
    if (process.env.ZDARMA_DEBUG || lv === 'error' || lv === 3) logLine(`[${name}] console(${lv})`, String(m).slice(0, 500));
    else if (fullLog) fullLog.write(name, 'console', `Konzole okna ${name} (${lv}): ${m}`, { level: lv, message: String(m), line: e?.lineNumber, source: e?.sourceId });
    if (name === 'opencode') recoverOpencode(m); // jednorázový reload okna po pádu markdown workeru
  });
  w.webContents.on('did-navigate', (_e, url) => { if (fullLog) fullLog.write(name, 'navigate', `Okno ${name} načetlo ${url}`, { url }); });
  w.webContents.on('did-navigate-in-page', (_e, url) => { if (fullLog) fullLog.write(name, 'navigate', `Okno ${name} přešlo na ${url}`, { url }); });
  w.on('unresponsive', () => logLine(`[${name}] unresponsive`));
  if (process.env.ZDARMA_DEBUG) {
    for (const ev of ['did-start-loading', 'dom-ready', 'did-finish-load', 'did-stop-loading']) w.webContents.on(ev, () => logLine(`[${name}] ${ev}`, w.webContents.getURL().slice(-60)));
  }
}
process.on('uncaughtException', (e) => logLine('[main] uncaughtException', e.stack || String(e)));
process.on('unhandledRejection', (e) => logLine('[main] unhandledRejection', e?.stack || String(e)));
const SETTINGS_FILE = () => path.join(DATA(), 'settings.json');
const SESS_DIR = () => path.join(DATA(), 'sessions');

// ---------------------------------------------------------------- nastavení

let settings = null;
const DEFAULTS = {
  providers: {},
  customProviders: [],
  favorites: [],
  model: 'auto',
  mode: 'ask',
  fallback: true,
  temperature: '',
  lastCwd: '',
  recentCwds: [],
  unfiltered: false,
  uncensoredMarks: [],
  proxy: true,
  proxyPort: 4545,
  pinnedFolders: [], // rychlý přístup: ručně připnuté složky
  recentFolders: [], // rychlý přístup: naposledy otevřené projekty
  forgotFolders: [], // ručně odebrané z nedávných (OpenCode by je jinak vracel ze svého seznamu)
  ocClassicLayout: true, // OpenCode: chaty svisle vlevo místo tabů
  tiers: {}, // tierlisty: úpravy vestavěných (max/high/mid/low/unfiltered) + vlastní (viz tiers.js)
  ocOnlyTiers: true, // v nabídce modelů OpenCode jen tierlisty Zdarmy (ne stovky jednotlivých modelů)
  ocProviders: true, // v OpenCode nechat jeho dialog „Připojit poskytovatele“ (seznam webů, Z.AI…) – bez enabled_providers
  preferFamilies: ['kimi', 'deepseek-v4', 'glm'], // tyto rodiny modelů nahoru v Auto i ve všech tierlistech
  router: 'omniroute', // tierlisty směruje OmniRoute (když je nainstalovaný); 'zdarma' = vlastní směrování
  lang: 'cs', // jazyk oken, menu a panelu v OpenCode: 'cs' | 'en'
  showUnfiltered: false, // přepínač Unfiltered v chatu (Nastavení → Pokročilé)
  ocFullAuto: false, // plný automatický režim: agent OpenCode se na nic neptá (opencode.js FULL_AUTO)
  modelPopupWidth: 680, // šířka vyskakovací nabídky modelů v OpenCode (px)
  modelPopupHeight: 560, // výška vyskakovací nabídky modelů v OpenCode (px)
  keysFile: '', // private/keys.json v soukromém repu (src/keysync.js); prázdné = najít klon repa samo
};

let legacyKeyCache;
function legacyMasterKey() {
  if (legacyKeyCache !== undefined) return legacyKeyCache;
  legacyKeyCache = null;
  try {
    const lsFile = path.join(app.getPath('appData'), 'Zdarma', 'Local State');
    if (!fs.existsSync(lsFile)) return null;
    const encKeyB64 = JSON.parse(fs.readFileSync(lsFile, 'utf8'))?.os_crypt?.encrypted_key;
    if (!encKeyB64) return null;
    const raw = Buffer.from(encKeyB64, 'base64').subarray(5); // bez prefixu "DPAPI"
    const ps = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${raw.toString('base64')}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
    const r = require('child_process').spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const key = Buffer.from(String(r.stdout || '').trim(), 'base64');
    if (key.length === 32) legacyKeyCache = key;
  } catch {}
  return legacyKeyCache;
}

function decLegacy(s) {
  try {
    const key = legacyMasterKey();
    if (!key) return '';
    const buf = Buffer.from(s.slice(4), 'base64');
    if (buf.subarray(0, 3).toString('ascii') !== 'v10') return '';
    const d = require('crypto').createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(15, buf.length - 16)), d.final()]).toString('utf8');
  } catch { return ''; }
}

function enc(s) {
  if (!s) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64');
  return s;
}
function dec(s) {
  if (!s) return '';
  if (s.startsWith('enc:')) {
    try {
      const out = safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
      if (out) return out;
    } catch {}
    return decLegacy(s);
  }
  return s;
}

function loadSettings() {
  const cur = DATA();
  const oldDir = !process.env.ZDARMA_USER_DATA ? path.join(app.getPath('appData'), 'Zdarma') : null;
  if (oldDir && fs.existsSync(oldDir)) {
    try {
      fs.mkdirSync(cur, { recursive: true });
      for (const item of ['usage.json', 'usage-projects.json', 'sessions']) {
        const s = path.join(oldDir, item);
        const d = path.join(cur, item);
        if (fs.existsSync(s) && !fs.existsSync(d)) fs.cpSync(s, d, { recursive: true });
      }
    } catch {}
  }
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch {}
  let oldRaw = null;
  if (oldDir && fs.existsSync(path.join(oldDir, 'settings.json'))) {
    try { oldRaw = JSON.parse(fs.readFileSync(path.join(oldDir, 'settings.json'), 'utf8')); } catch {}
  }
  const s = { ...DEFAULTS, ...(oldRaw || {}), ...raw };
  s.providers = { ...(oldRaw?.providers || {}), ...(raw.providers || {}) };
  let recovered = false;
  for (const id of Object.keys(s.providers || {})) {
    let k = dec(raw.providers?.[id]?.key || '');
    if (!k && oldRaw?.providers?.[id]?.key) {
      k = dec(oldRaw.providers[id].key);
      if (k) recovered = true;
    }
    s.providers[id] = { ...(oldRaw?.providers?.[id] || {}), ...(raw.providers?.[id] || {}), key: k };
  }
  const rawCustom = (raw.customProviders && raw.customProviders.length) ? raw.customProviders : (oldRaw?.customProviders || []);
  s.customProviders = rawCustom.map((c) => ({ ...c, key: dec(c.key) }));
  // kdo měl Unfiltered zapnutý dřív, než se přepínač schoval do Pokročilých, ho nepřijde
  if (raw.showUnfiltered === undefined && raw.unfiltered) s.showUnfiltered = true;
  settings = s;
  I18N.setLang(s.lang);
  if (recovered) { try { saveSettings(); } catch {} }
}

function saveSettings() {
  const out = JSON.parse(JSON.stringify(settings));
  for (const id of Object.keys(out.providers || {})) out.providers[id].key = enc(out.providers[id].key);
  out.customProviders = (out.customProviders || []).map((c) => ({ ...c, key: enc(c.key) }));
  fs.mkdirSync(DATA(), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(out, null, 2));
  scheduleOmniSync(); // klíče / tierlisty se mohly změnit
  writeKeysFile();
}

// ---------------------------------------------------------------- OmniRoute (směrovací jádro)

let omni = null;
let omniTimer = null;
let omniStartPromise = null;
let lastOmniPort = 20129;
let omniWin = null;
const omniState = { error: '', starting: false };
let omniStartRetries = 0;

// Závod modelů (src/race.js): každý krok agenta jde současně na raceN modelů tieru, vyhraje první, který začne
// odpovídat. Proxy mezi pluginem OpenCode a OmniRoute běží pořád (stálý port → konfigurace OpenCode se nemění);
// vypínač v menu mění jen počet závodníků (0 = jen přeposílá), bez restartu OpenCode.
const RACE_PORT = 20139;
const raceN = () => (settings.race === false ? 0 : Math.min(4, Math.max(2, Number(settings.raceN) || 2))); // výchozí 2 (uživatel 20. 11.: šetřit free kvóty; 3 = ~3× dotazů)
let raceProxy = null;
let raceUrl = null;

// Vidění (src/vision.js, nástroj look v czek-guard): modely tieru (Nemotron 3 Ultra) obrázky nečtou. Obrázek popíše
// model s viděním přes OmniRoute – sjednocené combo modelu (OmniRoute samo zkusí všechny poskytovatele daného modelu).
// Pořadí podle sondy 20. 11. (obrázek s textem „FURRYBEE 42“ a červeným obdélníkem): Gemini Flash (nejlepší, když má
// denní kvótu), Qwen3-VL 0,9 s a Qwen2.5-VL 1,1 s (OVH bez klíče, správně), Gemini Flash Lite 2,3 s; Nemotron 3.5 VL
// a Gemma 4 nestihly 60 s; GLM-4.6V-Flash odpověděl, ale halucinoval čínsky → na konec. Selhaný model má pauzu.
const VISION_PREF = [/^gemini-3(-\d)?-flash(?!-lite)/, /^gemini-2-5-flash(?!-lite)/, /qwen3-vl/, /qwen2-5-vl/, /flash-lite/, /nemotron-3-5-super-vl/, /gemma-4/, /mistral-medium|pixtral/, /glm-4-6v/];
let visionList = { at: 0, ids: [] };
const visionCool = new Map();
async function visionCandidates() {
  if (Date.now() - visionList.at < 10 * 60000 && visionList.ids.length) return visionList.ids;
  const key = omni.apiKey || await omni.ensureKey();
  const r = await fetch(omni.url.replace(/\/$/, '') + '/v1/models', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  const score = (id) => { const i = VISION_PREF.findIndex((re) => re.test(id)); return i < 0 ? VISION_PREF.length : i; };
  const ids = (j.data || []).filter((m) => (m.input_modalities || []).includes('image') && omni.baseLists?.has(m.id) && !/^zdarma-|^auto\//.test(m.id)).map((m) => m.id).sort((a, b) => score(a) - score(b));
  visionList = { at: Date.now(), ids };
  return ids;
}
async function visionDescribe(images, prompt) {
  if (!omni?.ready) throw new Error('OmniRoute neběží');
  const key = omni.apiKey || await omni.ensureKey();
  const ids = await visionCandidates();
  if (!ids.length) throw new Error('v OmniRoute není žádný model s viděním');
  const errors = [];
  let tried = 0;
  for (const id of ids) {
    if ((visionCool.get(id) || 0) > Date.now()) continue;
    // všichni poskytovatelé modelu v pauze OmniRoute (20. 11.: OVH Qwen VL 41 dní) → OmniRoute by hned vrátil 429
    if (omni.comboPaused?.(id)) { errors.push(`${id}: pauza OmniRoute`); continue; }
    if (++tried > 5) break;
    try {
      const r = await fetch(omni.url.replace(/\/$/, '') + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: id, stream: false, max_tokens: 2000, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((u) => ({ type: 'image_url', image_url: { url: u } }))] }] }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => ({}));
      const m = j?.choices?.[0]?.message || {};
      const text = (Array.isArray(m.content) ? m.content.map((x) => x?.text || '').join('') : m.content) || m.reasoning_content || '';
      if (r.ok && String(text).trim()) { logLine('[vidění]', id, 'odpověděl,', String(text).length, 'znaků'); return { text: String(text).trim(), model: id }; }
      errors.push(`${id}: HTTP ${r.status} ${JSON.stringify(j.error || j).slice(0, 160)}`);
      visionCool.set(id, Date.now() + 10 * 60000);
    } catch (e) { errors.push(`${id}: ${e.message}`); visionCool.set(id, Date.now() + 5 * 60000); }
  }
  logLine('[vidění] žádný model neodpověděl:', errors.join(' | ').slice(0, 600));
  throw new Error('žádný model s viděním neodpověděl: ' + errors.join('; ').slice(0, 500));
}
async function startRace() {
  if (raceUrl) return raceUrl;
  raceProxy ||= createRaceProxy({
    target: () => (omni?.ready ? omni.url : null),
    candidates: (model, total, racers) => { try { return omni?.raceCandidates(model, total, racers) || []; } catch { return []; } },
    n: raceN,
    keyedCount: () => WIZARD.keyed(settings), // hláška při vyčerpaném limitu: s klíči / bez klíčů
    // každé hotové volání celé do úplného záznamu (dotaz, odpověď, časy, závod)
    onCall: (rec) => { if (callLog) callLog.record(rec); },
    vision: (images, prompt) => visionDescribe(images, prompt),
    imageDir: () => path.join(DATA(), 'obrazky'),
    log: (msg, data) => {
      if (fullLog) fullLog.write('race', 'race', msg, data);
      if (/selhalo/.test(msg)) logLine('[závod]', msg);
    },
  });
  try {
    raceUrl = await raceProxy.listen(RACE_PORT);
    process.env.CZEK_VISION_URL = raceUrl + '/czek/vision'; // nástroj look v czek-guard (proces OpenCode dědí prostředí)
    logLine('[závod] proxy', raceUrl, raceN() >= 2 ? `${raceN()} modely` : 'vypnutý');
  }
  catch (e) { logLine('[závod] proxy nenaběhla:', e.message); raceUrl = null; }
  return raceUrl;
}

async function startOmni() {
  if (omni?.ready) return omni;
  if (omniStartPromise) return omniStartPromise;
  omniState.error = '';
  if (settings.router === 'zdarma') return null;
  if (!findOmni()) { omniState.error = I18N.t(omniInstall.running ? 'main.omniInstalling' : 'main.omniMissing'); return null; }
  omniState.starting = true;
  omniStartPromise = (async () => {
    const eng = new OmniRoute({
      dataDir: path.join(DATA(), 'omniroute'),
      port: lastOmniPort,
      dashboard: true,
      log: (l) => logLine('[omniroute]', l),
      onExit: () => omniCrashed(eng),
    });
    try {
      await eng.start();
      lastOmniPort = eng.port;
      omni = eng;
      await startRace();
      await omniSync();
      omniStartRetries = 0;
      await runRebalance();
      // kontrola zdraví čela tierů (drobné dotazy): 402/404/429 → mrtvé a pauzy ven z čela dřív než první krok agenta
      omni.probeHeads().then(() => omni.syncCooldowns()).then(() => runRebalance())
        .catch((e) => logLine('[omniroute] kontrola zdraví:', e.message));
      // kontrola zdraví se opakuje (smyčka Strata, kolo 14): lokální pauzy z probeHeads vyprší a model se zkusí
      // znovu; nový mrtvý model v čele se najde dřív než v kroku agenta
      clearInterval(omniProbeTimer);
      omniProbeTimer = setInterval(() => {
        if (!omni?.ready) return;
        omni.probeHeads().then(() => omni.syncCooldowns()).then(() => runRebalance()).catch((e) => logLine('[omniroute] kontrola zdraví:', e.message));
      }, 30 * 60 * 1000);
      clearInterval(omniRebalanceTimer);
      omniRebalanceTimer = setInterval(() => runRebalance(), 2 * 60 * 1000);
      return omni;
    } catch (e) {
      omniState.error = e.message;
      logLine('[omniroute] start selhal:', e.message);
      eng.stop();
      omni = null;
      if (!quitting && omniStartRetries < 3 && settings.router !== 'zdarma' && findOmni()) {
        omniStartRetries++;
        logLine(`[omniroute] nový pokus o start za 15 s (${omniStartRetries}/3)`);
        setTimeout(() => { if (!omni && !quitting) startOmni(); }, 15000);
      }
      return null;
    } finally {
      omniState.starting = false;
      omniStartPromise = null;
      try { send('proxy:changed', proxyStatus()); } catch {}
    }
  })();
  return omniStartPromise;
}

/** Otevře nástěnku OmniRoute (správa poskytovatelů, OAuth, klíčů a směrování auto/coding) ve vlastním okně. */
async function openOmniDashboard() {
  if (!omni?.ready) await startOmni();
  if (!omni?.ready) {
    openZdarma('settings');
    return { ok: false, error: omniState.error || I18N.t('main.omniMissing') };
  }
  const dashUrl = `${omni.url}/dashboard`;
  if (omniWin && !omniWin.isDestroyed()) {
    if (omniWin.isMinimized()) omniWin.restore();
    omniWin.focus();
    return { ok: true, url: dashUrl };
  }
  omniWin = new BrowserWindow({
    width: 1320, height: 880, minWidth: 720, minHeight: 500,
    title: 'OmniRoute · czek-ai',
    show: !process.env.ZDARMA_HIDDEN,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131313' : '#fafafa',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  watchWindow(omniWin, 'omniroute-ui');
  if (process.env.ZDARMA_HIDDEN) { omniWin.setSkipTaskbar(true); omniWin.setPosition(-4000, -4000); omniWin.showInactive(); }
  const origin = omni.url;
  omniWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith(origin)) return { action: 'allow' };
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  omniWin.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(origin)) { e.preventDefault(); if (/^https?:/.test(u)) shell.openExternal(u); }
  });
  omniWin.on('closed', () => { omniWin = null; });
  await omniWin.loadURL(dashUrl);
  return { ok: true, url: dashUrl };
}

// OmniRoute skončil sám od sebe (pád, nebo ho zabil cizí program – agent spustil `taskkill /IM node.exe`).
// Do restartu směruje Zdarma sama; restart za 3 s, nejvýš OMNI_RESTARTS× za 10 min, ať se pád netočí dokola.
const OMNI_RESTARTS = 5;
const omniCrashes = [];
function omniCrashed(eng) {
  if (omni !== eng) return;
  clearInterval(omniRebalanceTimer);
  clearInterval(omniProbeTimer);
  omniRebalanceTimer = omniProbeTimer = null;
  omni = null;
  const now = Date.now();
  while (omniCrashes.length && now - omniCrashes[0] > 10 * 60e3) omniCrashes.shift();
  omniCrashes.push(now);
  try { send('proxy:changed', proxyStatus()); } catch {}
  if (omniCrashes.length > OMNI_RESTARTS) {
    omniState.error = I18N.t('main.omniCrashLoop');
    logLine('[omniroute] padá opakovaně, další restart až po zapnutí v Nastavení / restartu Zdarmy');
    return;
  }
  logLine('[omniroute] restart za 3 s');
  setTimeout(() => { if (!omni && settings.router !== 'zdarma') startOmni(); }, 3000);
}

function stopOmni() {
  clearTimeout(omniTimer);
  clearInterval(omniRebalanceTimer);
  clearInterval(omniProbeTimer);
  clearTimeout(omniSlowTimer);
  omniRebalanceTimer = omniSlowTimer = omniProbeTimer = null;
  if (omni) omni.stop();
  omni = null;
}

let omniRebalanceTimer = null;
let omniSlowTimer = null;
let omniProbeTimer = null;
let rebalancing = false;
async function runRebalance() {
  if (!omni?.ready || rebalancing) return;
  rebalancing = true;
  try {
    const r = await omni.rebalance();
    if (r.changed) try { send('proxy:changed', proxyStatus()); } catch {}
  } catch (e) { logLine('[omniroute] rebalance:', e.message); } finally { rebalancing = false; }
}
/** Po pomalém požadavku přes OmniRoute (> 40 s) přerovnat dřív než za 2 min (s odstupem, ať doběhne zápis logu). */
function scheduleSlowRebalance(delay = 5000) {
  if (!omni?.ready || omniSlowTimer) return;
  omniSlowTimer = setTimeout(() => { omniSlowTimer = null; runRebalance(); }, delay);
}

async function omniSync() {
  if (!omni?.ready) return;
  const t0 = Date.now();
  const { models } = await registry.list();
  await omni.sync({ registry, models, settings, listMs: Date.now() - t0 });
}

function scheduleOmniSync() {
  clearTimeout(omniTimer);
  if (!omni?.ready) return;
  omniTimer = setTimeout(() => omniSync().catch((e) => logLine('[omniroute] sync:', e.message)), 1500);
}

const mask = (k) => (k ? (k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-4) : '••••') : '');

function publicSettings() {
  // Pokud se v souboru na disku nebo v dřívější složce Zdarma objevily klíče, které v paměti chybí, načíst je.
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    for (const [id, p] of Object.entries(raw.providers || {})) {
      if (!settings.providers?.[id]?.key && p?.key) {
        const k = dec(p.key);
        if (k) settings.providers[id] = { ...(settings.providers[id] || {}), ...p, key: k };
      }
    }
  } catch {}
  const s = JSON.parse(JSON.stringify(settings));
  for (const id of Object.keys(s.providers)) { s.providers[id].hasKey = !!s.providers[id].key; s.providers[id].key = mask(s.providers[id].key); }
  s.customProviders = s.customProviders.map((c) => ({ ...c, hasKey: !!c.key, key: mask(c.key) }));
  s.providerDefs = PROVIDERS.map((p) => ({
    id: p.id, name: I18N.lang === 'en' && p.nameEn ? p.nameEn : p.name, note: p.note, noteEn: p.noteEn || '', keyUrl: p.keyUrl, keyHint: p.keyHint || '', needsKey: p.needsKey, local: !!p.local, baseUrl: p.baseUrl,
    envKey: !!process.env[`${p.id.toUpperCase()}_API_KEY`],
  }));
  return s;
}

// ---------------------------------------------------------------- relace

function sessPath(id) { return path.join(SESS_DIR(), id.replace(/[^a-z0-9_-]/gi, '') + '.json'); }

function listSessions() {
  fs.mkdirSync(SESS_DIR(), { recursive: true });
  return fs.readdirSync(SESS_DIR()).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESS_DIR(), f), 'utf8'));
      return { id: s.id, title: s.title, cwd: s.cwd, updated: s.updated };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updated - a.updated);
}

function loadSession(id) { return JSON.parse(fs.readFileSync(sessPath(id), 'utf8')); }

function saveSession(s) {
  s.updated = Date.now();
  fs.mkdirSync(SESS_DIR(), { recursive: true });
  const tmp = sessPath(s.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, sessPath(s.id));
}

// ---------------------------------------------------------------- okno

let win;
const registry = new ModelRegistry(() => settings);
const agent = new Agent(registry, () => settings);
const running = new Map(); // sessionId -> AbortController
const pendingPerm = new Map(); // reqId -> resolve

/** Okno předvolby a nastavení ček-ai (klíče s odkazy, sjednocené modely, velikost nabídky v OpenCode). */
function openZdarma(view = 'settings') {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    send('nav', view);
    return;
  }
  createWindow(view);
}

function createWindow(view = 'settings') {
  win = new BrowserWindow({
    width: 1180, height: 840, minWidth: 720, minHeight: 500,
    title: 'czek-ai · Předvolba a klíče pro OpenCode',
    show: !process.env.ZDARMA_HIDDEN,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#f7f6f3',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  if (process.env.ZDARMA_HIDDEN) {
    // Testovací režim: okno mimo obrazovku, bez fokusu a bez ikony na liště (kvůli screenshotům musí být „zobrazené“).
    win.setSkipTaskbar(true);
    win.setPosition(-4000, -4000);
    win.showInactive();
  }
  watchWindow(win, 'chat');
  const hash = ['settings', 'models', 'about', 'opencode', 'chat', 'wizard'].includes(view) ? view : 'settings';
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { hash });
  // Po zavření (typicky po úpravě klíčů) načte OpenCode čerstvý seznam modelů.
  win.on('closed', () => { win = null; if (ocWin && !ocWin.isDestroyed()) refreshOpencodeModels().catch(() => {}); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// ---------------------------------------------------------------- proxy pro OpenCode

const proxy = { server: null, port: null, error: '', log: [] };
let usageTracker = null; // využití limitů (usage.js), plní ho proxy

function proxyStatus() {
  const port = proxy.port || settings.proxyPort;
  return {
    enabled: settings.proxy !== false,
    running: !!proxy.server,
    port,
    url: `http://127.0.0.1:${port}/v1`,
    error: proxy.error,
    note: proxy.note || '',
    router: omni?.ready
      ? {
        engine: 'omniroute',
        url: `${omni.url}/dashboard`,
        slow: [...omni.slow],
        text: I18N.t('main.omniOn', { v: omni.inst?.version || '', info: omni.lastSync ? I18N.t('main.omniInfo', { p: omni.lastSync.providers, c: omni.lastSync.combos }) : I18N.t('main.omniSetting') })
          + (omni.slow.size ? I18N.t('main.omniSlow', { list: [...omni.slow].map((k) => { const i = omni.slowInfo.get(k); return k + (i?.medianMs ? ` (~${Math.round(i.medianMs / 1000)} s)` : i?.bad ? I18N.t('main.omniNoAnswer', { n: i.bad }) : ''); }).join(', ') }) : ''),
      }
      : { engine: 'zdarma', text: omniState.starting ? I18N.t('main.omniStarting') : (omniState.error || I18N.t('main.ownRouting')) },
    log: proxy.log.slice(-30),
    opencodeConfigured: opencode.isConfigured(port, omni?.ready ? omni.url : undefined),
    opencodeFile: opencode.CONFIG_FILE(),
  };
}

async function stopProxy() {
  const s = proxy.server;
  proxy.server = null;
  proxy.port = null;
  if (s) await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
}

async function proxyHealth(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; }
}

/**
 * @param {{fallbackPort?: boolean}} [o]  fallbackPort: když port drží něco jiného než Zdarma stejné verze
 *   (typicky starší Zdarma, která pořád běží), poslouchat na volném portu. OpenCode se nastaví na něj.
 */
async function startProxy(o = {}) {
  await stopProxy();
  proxy.error = '';
  proxy.portBusy = false;
  proxy.note = '';
  if (settings.proxy === false) return proxyStatus();
  const port = Number(settings.proxyPort) || DEFAULTS.proxyPort;
  usageTracker ||= new Usage(path.join(DATA(), 'usage.json'), path.join(DATA(), 'usage-projects.json'));
  const server = createProxy({
    registry, getSettings: () => settings, version: VERSION, usage: usageTracker,
    omni: () => (omni?.ready ? omni : null),
    trace: (rec) => {
      (traceWrite ||= diag.traceWriter(DIAG_DIR()))(rec);
      const okA = (rec.attempts || []).find((a) => a.ok);
      liveWrite({ src: 'proxy', kind: 'res', via: rec.via, requested: rec.requested, model: rec.model || rec.combo, ok: rec.ok, ms: rec.ms, status: rec.status, error: rec.error, tokIn: okA?.inTok, tokOut: okA?.outTok, toolCalls: okA?.toolCalls, fixedArgs: okA?.fixedArgs, badArgs: okA?.badArgs, finish: okA?.finish, failedAttempts: (rec.attempts || []).filter((a) => !a.ok).map((a) => `${a.model}: ${a.kind || ''} ${a.msg || ''}`.trim()) });
    },
    capture: (rec) => fullWrite(rec),
    live: (rec) => liveWrite(rec),
    diagApi: {
      diag: (sid) => diagData(sid),
      live: (n) => diag.readJsonl(LIVE_FILE(), n, 8 * 1024 * 1024),
      full: (n) => diag.readJsonl(FULL_FILE(), n, 64 * 1024 * 1024),
      requests: (n) => diag.readTrace(DIAG_DIR(), n),
    },
    onLog: (e) => {
      proxy.log.push(e);
      if (proxy.log.length > 200) proxy.log.splice(0, proxy.log.length - 200);
      if (HEADLESS) console.log(`[proxy] ${e.ok ? 'OK ' : 'ERR'} ${e.requested} → ${e.model || '-'} ${e.ms} ms${e.error ? ' ' + e.error : ''}`);
      if (e.ms > 40000 && omni?.ready && (e.tried || []).some((t) => String(t).startsWith('zdarma-'))) scheduleSlowRebalance();
      send('proxy:changed', proxyStatus());
    },
  });
  try {
    proxy.port = await listen(server, port);
    writeEndpoint();
    proxy.server = server;
  } catch (e) {
    proxy.portBusy = e.code === 'EADDRINUSE';
    proxy.error = proxy.portBusy ? I18N.t('main.portBusy', { port }) : e.message;
    if (e.code === 'EADDRINUSE' && o.fallbackPort) {
      const h = await proxyHealth(port);
      const same = h?.name === 'zdarma-proxy' && h.version === VERSION; // stejná Zdarma: proxy půjčit
      if (!same) {
        try {
          proxy.port = await listen(server, 0);
          proxy.server = server;
          proxy.error = '';
          proxy.note = h?.name === 'zdarma-proxy'
            ? I18N.t('main.portOld', { port, v: h.version, p: proxy.port })
            : I18N.t('main.portOther', { port, p: proxy.port });
        } catch (e2) { proxy.error = e2.message; }
      }
    }
  }
  send('proxy:changed', proxyStatus());
  return proxyStatus();
}

// ---------------------------------------------------------------- okno OpenCode

const ocServer = new OpencodeServer();
let ocWin = null;
// Auto-zotavení okna OpenCode z pádu markdown workeru: jednou za život okna, jen když neběží relace (nepřeruší
// odpověď modelu). Vypínatelné settings.ocAutoRecover = false. Počítadlo se nuluje při vytvoření okna.
let ocWorkerReloads = 0;
function recoverOpencode(message) {
  if (settings.ocAutoRecover === false || ocWorkerReloads >= 1) return;
  if (!require('./ocRecover').markdownWorkerFailed(message)) return;
  ocWorkerReloads++;
  (async () => {
    const busy = (proxy.server && (proxy.server.inflight > 0 || Date.now() - proxy.server.lastAt < 15000)) || await ocServer.busy().catch(() => true);
    if (busy) { logLine('[opencode] markdown worker selhal, ale běží relace → reload odložen'); return; }
    if (ocWin && !ocWin.isDestroyed()) { logLine('[opencode] markdown worker selhal → jednorázový reload okna'); ocWin.webContents.reload(); }
  })();
}
// Pád rendereru okna OpenCode: při skutečném pádu okno jednou reloadnout (relace žije na serveru), při čistém
// konci / našem zabití (reload, konec appky) ne. Jednou za život okna, ne během ukončování.
let ocGoneReloads = 0;
function recoverOpencodeGone(reason) {
  if (settings.ocAutoRecover === false || quitting || ocGoneReloads >= 1) return;
  if (!require('./ocRecover').shouldReloadOnGone(reason)) return;
  ocGoneReloads++;
  if (ocWin && !ocWin.isDestroyed()) { logLine(`[opencode] renderer spadl (${reason}) → jednorázový reload okna`); ocWin.webContents.reload(); }
}

// Počítač a uživatel pro systémový prompt agenta (opencode.systemContext). Jen místní údaje, jednou za běh.
let sysInfoCache = null;
function sysInfo() {
  if (sysInfoCache?.shell) return sysInfoCache; // bez Git Bash znovu (PortableGit se mohl mezitím stáhnout)
  const os = require('os');
  const build = Number(os.release().split('.')[2]) || 0;
  // Windows 11 má v registru pořád „Windows 10 …“ (ProductName), pozná se podle sestavení ≥ 22000
  const osName = process.platform === 'win32' ? os.version().replace(/^Windows 10/, build >= 22000 ? 'Windows 11' : 'Windows 10') : `${os.type()} ${os.release()}`;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const has = (n) => dirs.some((d) => {
    if (/^python3?$/.test(n) && /WindowsApps/i.test(d)) return false; // jen odkaz do Microsoft Store
    return exts.some((e) => { try { return fs.statSync(path.join(d, n + e)).size > 0; } catch { return false; } });
  });
  const pathOf = (k) => { try { return app.getPath(k); } catch { return null; } };
  sysInfoCache = {
    os: `${osName} (${os.release()}, ${os.arch()})`,
    shell: findGitBash(),
    user: os.userInfo().username,
    home: os.homedir(),
    desktop: pathOf('desktop'), documents: pathOf('documents'), downloads: pathOf('downloads'),
    locale: (app.getPreferredSystemLanguages?.() || [])[0] || app.getLocale(),
    tools: ['node', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'git', 'cargo', 'rustc', 'python', 'py', 'go', 'java', 'dotnet', 'gcc'].filter(has),
  };
  return sysInfoCache;
}

/** Zapíše do konfigurace OpenCode oficiální plugin OmniRoute (auto/coding), nebo záložně poskytovatele "zdarma". */
// Skills, které agent uvidí v systémovém promptu: přibalené (bez rodiny caveman – ta je zapnutá trvale přes
// pokyny) + vestavěný customize-opencode. Soukromé skills uživatele z ~/.claude/skills (video, …) se nevypisují;
// v menu „Všechny skills“ (settings.ocAllSkills) to vrátí. Viz opencode.applySkills.
function leanSkills() {
  if (settings.ocAllSkills === true) return null;
  const names = skills.bundled(SKILLS_BUNDLE()).filter((n) => !/^(caveman|cavecrew)/.test(n));
  return names.length ? [...names, 'customize-opencode'] : null;
}

async function syncOpencodeConfig(so = {}) {
  if (omni?.ready) {
    const apiKey = omni.apiKey || await omni.ensureKey().catch(() => null);
    if (apiKey) {
      return opencode.writeConfig(proxy.port || settings.proxyPort, [], {
        // ZDARMA_TEST_PLUGIN_URL jen pro test/app-models.js: plugin jde přes proxy testu, který řídí,
        // jestli OmniRoute „odpovídá“ (start appky, kdy /v1/models nestihne odpovědět)
        // jinak přes proxy závodu modelů (src/race.js), která vše kromě kroků agenta jen přeposílá
        omniUrl: process.env.ZDARMA_TEST_PLUGIN_URL || raceUrl || omni.url,
        omniKey: apiKey,
        builtinFree: settings.ocBuiltinFree === true,
        onlyTiers: settings.ocOnlyTiers !== false,
        fullAuto: settings.ocFullAuto === true,
        routed: settings.ocDirectProviders === true ? [] : routedOcProviders(),
        freshModels: !!so.fresh, // změna klíčů/modelů → smazat diskovou cache katalogu pluginu
        todo: settings.ocTodo === true,
        reviewer: settings.ocReviewer !== false, // kontroloví subagenti reviewer a reviewer-alt (výchozí zapnuto)
        caveman: settings.caveman !== false, // skill caveman trvale zapnutý (vypíná se v menu)
        cavemanSkill: path.join(SKILLS_BUNDLE(), 'caveman', 'SKILL.md'),
        sysInfo: settings.sysContext !== false ? sysInfo() : null,
        skillsAllow: leanSkills(),
      });
    }
  }
  let models = [];
  try { models = (await registry.list()).models; } catch {}
  const r = opencode.writeConfig(proxy.port || settings.proxyPort, models, {
    tiers: tiers.overview(models, settings, registry),
    onlyTiers: settings.ocOnlyTiers !== false,
    ocProviders: settings.ocProviders !== false, // dialog „Připojit poskytovatele“ v OpenCode viditelný
    reviewer: settings.ocReviewer !== false, // kontroloví subagenti reviewer a reviewer-alt (výchozí zapnuto)
    migrateDefault: !settings.ocDefaultMaxDone, // jednou: dřívější výchozí High → Max
    fullAuto: settings.ocFullAuto === true,
    sysInfo: settings.sysContext !== false ? sysInfo() : null,
    settings,
    registry,
  });
  if (!settings.ocDefaultMaxDone) { settings.ocDefaultMaxDone = true; saveSettings(); }
  return r;
}

const ocOrigin = () => (ocServer.url ? new URL(ocServer.url).origin : 'http://127.0.0.1:0');
const ocCwd = () => {
  const c = settings.lastCwd;
  if (c && fs.existsSync(c)) return c;
  const docs = path.join(app.getPath('documents'), 'Claude code');
  return fs.existsSync(docs) ? docs : app.getPath('documents');
};

let refreshTimer = null;
/**
 * Znovu zapíše seznam modelů. OpenCode konfiguraci načte jen při startu serveru, a restart
 * by shodil rozdělanou práci agenta – proto se čeká, dokud neběží žádná relace ani požadavek na model.
 */
async function refreshOpencodeModels() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  registry.invalidate();
  const { changed } = await syncOpencodeConfig({ fresh: true });
  if (!changed || !ocServer.child) return false;
  const proxyBusy = proxy.server && (proxy.server.inflight > 0 || Date.now() - proxy.server.lastAt < 15000);
  if (proxyBusy || await ocServer.busy()) {
    refreshTimer = setTimeout(() => refreshOpencodeModels().catch(() => {}), 20000);
    return false;
  }
  await ocServer.restart();
  if (ocWin && !ocWin.isDestroyed()) await ocWin.loadURL(ocServer.url);
  return true;
}

function opencodeMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'czek-ai',
      submenu: [
        { label: I18N.t('menu.wizard'), click: () => openZdarma('wizard') },
        { label: I18N.t('menu.keys'), accelerator: 'Ctrl+,', click: () => openZdarma('settings') },
        { label: I18N.t('menu.models'), accelerator: 'Ctrl+Shift+M', click: () => openZdarma('models') },
        { label: I18N.t('menu.omni'), accelerator: 'Ctrl+Shift+O', click: () => openOmniDashboard() },
        { label: I18N.t('menu.reload'), click: () => refreshOpencodeModels().catch((e) => dialog.showErrorBox('czek-ai', e.message)) },
        { label: I18N.t('menu.skills'), accelerator: 'Ctrl+Shift+K', click: () => openSkillsWindow() },
        { type: 'separator' },
        {
          // veřejný tierlist: anonymní souhrn modelů (src/publicTier.js); zapnuté bez ptaní (uživatel 23. 11.)
          label: I18N.t('menu.shareStats'), type: 'checkbox', checked: settings.shareStats !== false,
          click: (item) => { settings.shareStats = item.checked; saveSettings(); logLine('[tierlist] odesílání', item.checked ? 'zapnuté' : 'vypnuté'); },
        },
        { label: I18N.t('menu.publicTier'), click: () => shell.openExternal(publicTier.url()) },
        { label: I18N.t('menu.bench'), click: () => { benchFromMenu().catch(() => {}); } },
        {
          label: I18N.t('menu.fullLog'), type: 'checkbox', checked: !!fullLog,
          click: (item) => { settings.fullLog = item.checked; saveSettings(); if (item.checked) startFullLog(); else stopFullLog(); },
        },
        { label: I18N.t('menu.monitor'), accelerator: 'Ctrl+Shift+D', click: () => openMonitorWindow() },
        { label: I18N.t('menu.openLogs'), click: () => { fs.mkdirSync(FULLLOG_DIR(), { recursive: true }); shell.openPath(FULLLOG_DIR()); } },
        {
          label: I18N.t('menu.selfReport'),
          click: () => { const dir = reportOutDir(); writeSelfReport('menu').then(() => { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); }); },
        },
        {
          // pokyny se čtou při startu serveru OpenCode → zápis + restart, až nic neběží (refreshOpencodeModels)
          label: I18N.t('menu.caveman'), type: 'checkbox', checked: settings.caveman !== false,
          click: (item) => { settings.caveman = item.checked; saveSettings(); logLine('[opencode] caveman', item.checked ? 'zapnutý' : 'vypnutý'); refreshOpencodeModels().catch(() => {}); },
        },
        {
          // živě: proxy čte raceN() u každého dotazu
          label: I18N.t('menu.race'), type: 'checkbox', checked: settings.race !== false,
          click: (item) => { settings.race = item.checked; saveSettings(); logLine('[závod]', item.checked ? `zapnutý (${raceN()} modely)` : 'vypnutý'); },
        },
        {
          label: I18N.t('menu.allSkills'), type: 'checkbox', checked: settings.ocAllSkills === true,
          click: (item) => { settings.ocAllSkills = item.checked; saveSettings(); logLine('[opencode] všechny skills v promptu', item.checked ? 'ano' : 'ne (jen přibalené)'); refreshOpencodeModels().catch(() => {}); },
        },
        { label: I18N.t('menu.about'), click: () => openZdarma('about') },
        { type: 'separator' },
        { label: I18N.t('menu.quit'), accelerator: 'Ctrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: I18N.t('menu.view'),
      submenu: [
        {
          label: I18N.t('menu.classicLayout'), type: 'checkbox', checked: settings.ocClassicLayout !== false,
          click: (item) => { settings.ocClassicLayout = item.checked; saveSettings(); ocWin?.webContents.reload(); },
        },
        { type: 'separator' },
        { label: I18N.t('menu.reloadPage'), accelerator: 'Ctrl+R', click: () => ocWin?.webContents.reload() },
        { type: 'separator' },
        { label: I18N.t('menu.zoomIn'), role: 'zoomIn' },
        { label: I18N.t('menu.zoomOut'), role: 'zoomOut' },
        { label: I18N.t('menu.zoomReset'), role: 'resetZoom' },
        { type: 'separator' },
        { label: I18N.t('menu.fullscreen'), role: 'togglefullscreen' },
        { label: I18N.t('menu.devtools'), accelerator: 'F12', click: () => ocWin?.webContents.toggleDevTools() },
      ],
    },
  ]);
}

// Plugin OmniRoute si katalog stáhne při vzniku každé instance OpenCode (limit 10–30 s); když OmniRoute
// po startu ještě skládá tierlisty a neodpoví, instance zůstane bez modelů (reprodukováno test/app-models.js
// INDUCE=startup). Proto OpenCode startuje až ve chvíli, kdy /v1/models opravdu vrací modely (max 60 s).
async function waitOmniCatalog() {
  const t0 = Date.now();
  let key = null;
  try { key = omni.apiKey || await omni.ensureKey(); } catch {}
  let last = '';
  while (Date.now() - t0 < 60000) {
    try {
      const r = await fetch(omni.url.replace(/\/$/, '') + '/v1/models', { headers: key ? { authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(10000) });
      const j = r.ok ? await r.json() : null;
      const n = Array.isArray(j?.data) ? j.data.length : 0;
      if (n > 0) { logLine(`[omniroute] katalog pro OpenCode připraven za ${Date.now() - t0} ms (${n} modelů)`); return true; }
      last = r.ok ? 'prázdný katalog' : 'HTTP ' + r.status;
    } catch (e) { last = e.message; }
    await new Promise((res) => setTimeout(res, 2000));
  }
  logLine('[omniroute] katalog pro OpenCode nepřipraven ani po 60 s:', last);
  return false;
}

// ---------------------------------------------------------------- úplný log
const FULLLOG_DIR = () => path.join(DATA(), 'logs');
// Zapnutý: nastavení fullLog; když není nastavené, tak na PC vlastníka (našel se klon soukromého repa).
// CZEK_FULL_LOG=1 vynutí (testy). Sdílená verze u spolužáků ho tak nemá, dokud si ho nezapnou v menu.
const fullLogWanted = () => process.env.CZEK_FULL_LOG === '1' || (settings.fullLog ?? !!keysFilePath());
let omniCallTimer = null;
const omniCallSeen = new Set();
let fullLogSince = 0;
function startFullLog() {
  if (fullLog || !fullLogWanted()) return;
  fullLogSince = Date.now();
  fullLog = new FullLog({
    dir: FULLLOG_DIR(),
    secrets: () => [...Object.values(settings.providers || {}).map((p) => p?.key), omni?.apiKey].filter(Boolean),
  });
  callLog = new CallLog({ dir: path.join(FULLLOG_DIR(), 'calls'), secrets: () => [...Object.values(settings.providers || {}).map((p) => p?.key), omni?.apiKey].filter(Boolean) });
  fullLog.write('app', 'start', `czek-ai ${VERSION} – úplný log zapnutý (${FULLLOG_DIR()})`, { version: VERSION, exe: process.execPath, electron: process.versions.electron, os: process.platform, settings: { ...settings, providers: Object.fromEntries(Object.entries(settings.providers || {}).map(([k, v]) => [k, { ...v, key: v?.key ? '***' : '' }])) } });
  // rozhodnutí czek-guard (plugin v OpenCode zapisuje do guard.jsonl, viz src/guard/index.mjs)
  const guardFile = path.join(FULLLOG_DIR(), 'guard.jsonl');
  try { fs.writeFileSync(guardFile, ''); } catch {}
  process.env.CZEK_GUARD_LOG = guardFile; // dostane ho proces OpenCode (serveEnv kopíruje process.env)
  fullLog.follow(guardFile, 'czek-guard', 'guard', (l, d) => (d?.msg ? `czek-guard: ${d.msg}` : l));
  // výstup procesu OmniRoute
  fullLog.follow(path.join(DATA(), 'omniroute', 'zdarma-omniroute.log'), 'omniroute', 'proces', (l) => `OmniRoute: ${l}`);
  // záznamy volání OmniRoute: který model, stav, doba, chyba (= proč selhal / proč záloha)
  clearInterval(omniCallTimer);
  omniCallTimer = setInterval(async () => {
    if (!fullLog || !omni?.ready) return;
    try {
      const rows = await omni.api('GET', '/api/usage/call-logs?limit=200');
      monitor.addOmniRows(rows); omniRowsAt = Date.now();
      for (const r of (Array.isArray(rows) ? rows : []).slice().reverse()) {
        const id = r.id ?? `${r.timestamp}|${r.provider}|${r.model}|${r.status}`;
        if (omniCallSeen.has(id)) continue;
        // jen volání od startu logu (jinak by se při každém startu znovu zapsalo posledních 200 starých)
        const at = Date.parse(r.timestamp || '') || 0;
        if (at && at < fullLogSince - 60000) { omniCallSeen.add(id); continue; }
        omniCallSeen.add(id);
        const prov = omni.nodeToProvider?.get(r.provider) || r.provider || '';
        fullLog.write('omniroute', 'call', `OmniRoute volání: ${r.requestedModel || r.requested_model || '?'} → ${prov}/${r.model || '?'}, stav ${r.status}, ${r.duration ?? '?'} ms${r.error ? ' – CHYBA: ' + r.error : ''}`, r);
      }
      if (omniCallSeen.size > 20000) omniCallSeen.clear();
    } catch (e) { fullLog.write('omniroute', 'call-logs-error', `Záznamy volání OmniRoute nejdou načíst: ${e.message}`); }
  }, 10000);
  // výstup serveru OpenCode (s --print-logs, viz opencodeServer.js)
  ocServer.onOutput = (d) => { if (fullLog) fullLog.write('opencode-server', 'out', String(d).trimEnd()); };
  ocServer.extraArgs = ['--print-logs', '--log-level', 'INFO'];
}
function stopFullLog() {
  if (!fullLog) return;
  fullLog.write('app', 'stop', 'Úplný log vypnutý');
  fullLog.stop();
  fullLog = null;
  callLog = null;
  clearInterval(omniCallTimer);
  ocServer.onOutput = null;
  ocServer.extraArgs = [];
  delete process.env.CZEK_GUARD_LOG;
}

// ---------------------------------------------------------------- report o výkonu (self-report)
let sawModelActivity = false; // v tomhle běhu byl model (krok OpenCode)
/** Složka reportů: klon soukromého repa (private/keys.json → docs/self-report), jinak data appky. */
function reportOutDir() {
  const kf = keysFilePath();
  if (kf && path.basename(path.dirname(kf)).toLowerCase() === 'private') return path.join(path.dirname(path.dirname(kf)), 'docs', 'self-report');
  return path.join(DATA(), 'self-report');
}
/** Napíše report za posledních `days` dnů (výchozí jen dnešek = aktuální stav; když dnešek nemá běh, okno se
 *  rozšíří, ať report ukáže poslední skutečnou relaci a ne prázdno ani starou historii). Nikdy nehodí chybu;
 *  vrací cestu k souboru, nebo ''. */
async function writeSelfReport(reason, days = 1) {
  if (settings.selfReport === false) return '';
  try {
    const { generateReport } = require('./selfReport');
    let r = await generateReport({ dir: FULLLOG_DIR(), days, outDir: reportOutDir() });
    // dnešek bez aktivity (appka jen otevřená) → rozšiř okno na poslední dny s během, jinak by byl report prázdný
    if (!r.steps && days < 3) r = await generateReport({ dir: FULLLOG_DIR(), days: 3, outDir: reportOutDir() });
    logLine('[self-report]', reason, r.file, `${r.findings} nálezů`);
    return r.file;
  } catch (e) { logLine('[self-report] chyba', reason, e.message); return ''; }
}

let watchBusy = false;
const watchLast = new Map(); // složka → poslední zapsaný stav (do logu jen změny)
let watchFails = 0; // kolikrát po sobě zahození instance nepomohlo
const watchRestarts = []; // časy restartů serveru OpenCode vynucených hlídačem
async function watchInstances(why = 'timer') {
  if (watchBusy || !ocServer.url || !ocWin || ocWin.isDestroyed()) return false;
  let model = null;
  try { model = JSON.parse(fs.readFileSync(opencode.CONFIG_FILE(), 'utf8').replace(/^\uFEFF/, '')).model; } catch {}
  const providerID = ocWatch.providerOf(model);
  if (providerID !== 'opencode-omniroute' && providerID !== 'zdarma') return false; // vlastní model uživatele nehlídáme
  watchBusy = true;
  let bad = false;
  try {
    const base = ocOrigin();
    const current = ocWatch.dirFromUrl(ocWin.webContents.getURL());
    const dirs = [...new Set([current, ocCwd()].filter(Boolean))];
    const results = await Promise.all(dirs.map((dir) => ocWatch.heal(base, dir, providerID, { tries: 1 })));
    for (const [i, dir] of dirs.entries()) {
      const r = results[i];
      if (!r.ok) bad = true;
      // dedup podle stabilního klíče (bez textu chyby), ať „bez modelů" při výpadku sítě nezaplaví log; UI
      // událost se loguje zvlášť v oc:noModels, tady už ji nevynucujeme (jen přechod stavu nebo znovu-načtení)
      const key = ocWatch.stateKey(r);
      const state = ocWatch.stateText(r);
      if (r.healed || watchLast.get(dir) !== key) {
        logLine(`[opencode] hlídač (${why}): ${dir}${dir === current ? ' [otevřená]' : ''} → ${state}${r.healed ? ', instance znovu načtena' : ''}`);
        watchLast.set(dir, key);
      }
      // web ukazuje prázdný výběr, i když server modely má (web si je načetl dřív) → znovu načíst stránku
      const reload = r.ok && dir === current && (r.healed || why === 'ui');
      if (reload && ocWin && !ocWin.isDestroyed()) { logLine('[opencode] stránka znovu načtena (výběr modelu)'); ocWin.webContents.reload(); }
    }
    // Zahození instance nepomohlo 3× po sobě = chyba není v instanci (15. 11.: plugin OmniRoute se nenačetl a server
    // si neúspěšný import pamatoval; hlídač pak instanci zahazoval každých 6,6 s donekonečna). Pomůže jen nový
    // proces serveru. Nejvýš 2× za 15 min, jen když OmniRoute běží a v OpenCode nic nepracuje.
    if (!bad) watchFails = 0;
    else if (results.some((r) => !r.ok && r.healed)) watchFails++;
    if (watchFails >= 3) {
      const now = Date.now();
      const recent = watchRestarts.filter((t) => now - t < 15 * 60000);
      if (recent.length < 2 && omni?.ready && !(await ocServer.busy().catch(() => true))) {
        watchFails = 0;
        watchRestarts.splice(0, watchRestarts.length, ...recent, now);
        logLine('[opencode] hlídač: instance bez modelů ani po 3 zahozeních → restart serveru OpenCode');
        await ocServer.restart();
        if (ocWin && !ocWin.isDestroyed()) await ocWin.loadURL(ocServer.url).catch(() => {});
      }
    }
  } finally { watchBusy = false; }
  return bad;
}

async function openOpencodeWindow() {
  if (ocWin && !ocWin.isDestroyed()) { if (ocWin.isMinimized()) ocWin.restore(); ocWin.focus(); return; }
  if (settings.router !== 'zdarma' && !omni?.ready) await startOmni();
  if (!omni?.ready && !proxy.server) {
    // Záložní cesta jen když OmniRoute není k dispozici.
    const st = await startProxy({ fallbackPort: true });
    if (!st.running && !proxy.portBusy) throw new Error(`Proxy se nespustila: ${st.error}`);
  }
  if (!findOpencode()) await ensureOpencode(); // chybí → stáhnout (i když se okno otevírá později z menu)
  splashSet('server', 'run');
  const { changed } = await syncOpencodeConfig();
  if (changed && ocServer.child) await ocServer.restart(); // nové modely načte jen čerstvý server
  // ZDARMA_OC_PORT jen pro testy (ať se nepřipojí k OpenCode, které má uživatel zrovna otevřené)
  if (omni?.ready) await waitOmniCatalog();
  const url = await ocServer.start(Number(process.env.ZDARMA_OC_PORT) || 4096, ocCwd());
  splashSet('server', 'done');
  splashSet('window', 'run');
  startOcEvents();
  ocWorkerReloads = 0; ocGoneReloads = 0; // nové okno: znovu povolit jednorázové auto-zotavení
  const withSplash = splashOpen(); // okno ukázat až načtené, do té doby je vidět úvodní okno
  ocWin = new BrowserWindow({
    width: 1400, height: 920, minWidth: 720, minHeight: 500,
    title: 'czek-ai',
    show: !process.env.ZDARMA_HIDDEN && !withSplash,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131313' : '#fafafa',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    // Cizí obsah (web OpenCode): sandbox, bez Node; preload nabízí jen výběr složky.
    webPreferences: { partition: OC_PARTITION, preload: path.join(__dirname, 'ocPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  ocWin.setMenu(opencodeMenu());
  watchWindow(ocWin, 'opencode');
  if (process.env.ZDARMA_HIDDEN) { ocWin.setSkipTaskbar(true); ocWin.setPosition(-4000, -4000); ocWin.showInactive(); }
  const external = (u) => { if (/^https?:/.test(u)) shell.openExternal(u); };
  ocWin.webContents.setWindowOpenHandler(({ url: u }) => { if (u.startsWith(ocOrigin())) return { action: 'allow' }; external(u); return { action: 'deny' }; });
  ocWin.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(ocOrigin())) { e.preventDefault(); external(u); } });
  ocWin.webContents.on('page-title-updated', (e) => { e.preventDefault(); });
  // Titulek okna: který model právě pracuje (nebo naposledy pracoval).
  const shortModel = (k) => String(k || '').slice(String(k || '').indexOf('/') + 1);
  const titleTimer = setInterval(() => {
    if (!ocWin || ocWin.isDestroyed()) { clearInterval(titleTimer); return; }
    const a = activeInfo();
    let t = 'czek-ai';
    const c = a?.current?.[0];
    if (c) t = I18N.t('win.working', { model: shortModel(c.model), prov: `${c.providerName}${c.tier ? ` · ${a.tierNames[c.tier] || c.tier}` : ''}`, s: Math.round((a.now - c.since) / 1000) });
    else if (a?.last?.ok) t = I18N.t('win.last', { model: shortModel(a.last.model), prov: `${a.last.providerName}${a.last.tier ? ` · ${a.tierNames[a.last.tier] || a.last.tier}` : ''}` });
    if (settings.ocFullAuto) t = `⚠ ${I18N.t('oc.fullAuto')} · ` + t;
    if (omniInstall.running) t = `⏳ ${I18N.t('win.omniInstalling', { min: Math.floor((Date.now() - omniInstall.started) / 60000) })} · ` + t;
    if (ocWin.getTitle() !== t) ocWin.setTitle(t);
  }, 1000);
  // Hlídání instancí: složka bez modelů („No model results“) → instance znovu načtená (viz ocWatch.js)
  // Kontrola každých 30 s, když je vše v pořádku; když nějaká instance nemá modely, každých 5 s (měřeno
  // test/app-models.js INDUCE=startup: s 30 s intervalem a 10 s čekáním trvalo zotavení 56 s).
  let watchTimer = null;
  const watchLoop = async (delay) => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(async () => {
      const bad = await watchInstances().catch(() => true);
      if (ocWin && !ocWin.isDestroyed()) watchLoop(bad ? 5000 : 30000);
    }, delay);
  };
  watchLoop(5000);
  ocWin.webContents.on('did-navigate-in-page', () => watchLoop(2000));
  ocWin.on('closed', () => { ocWin = null; clearInterval(titleTimer); clearTimeout(watchTimer); });
  ocWin.webContents.on('dom-ready', () => { ocWin?.webContents.insertCSS(ocPatch.OC_CSS + (settings.ocTodo === true ? '' : ocPatch.TODO_HIDE_CSS)).catch(() => {}); });
  // Při úplně prvním spuštění OpenCode jednorázově přepne nové instalace na nové rozvržení (a přepíše
  // volbu z ocPreload.js). Další načtení už to nedělá, takže stačí jednou znovu načíst.
  let layoutFixes = 0;
  ocWin.webContents.on('did-finish-load', async () => {
    if (settings.ocClassicLayout === false || layoutFixes >= 1) return;
    await new Promise((r) => setTimeout(r, 1500));
    if (!ocWin || ocWin.isDestroyed()) return;
    const v = await ocWin.webContents.executeJavaScript(
      "(() => { try { return JSON.parse(localStorage.getItem('settings.v3') || '{}').general?.newLayoutDesigns; } catch { return null; } })()",
    ).catch(() => null);
    if (v === true) { layoutFixes++; ocWin.webContents.reload(); }
  });
  try {
    await ocWin.loadURL(url);
  } finally {
    if (ocWin && !ocWin.isDestroyed() && withSplash && !process.env.ZDARMA_HIDDEN) ocWin.show();
    splashSet('window', 'done');
    closeSplash();
  }
}

// ---------------------------------------------------------------- skills (přibalené, s návody)

const SKILLS_BUNDLE = () => (app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(__dirname, '..', 'skills'));
const SKILLS_TARGET = () => path.join(path.dirname(opencode.CONFIG_FILE()), 'skills');
let skillStatus = [];
let skillsWin = null;

/** Nainstaluje / aktualizuje přibalené skills do složky skills v konfiguraci OpenCode. */
function syncSkills() {
  try { skillStatus = skills.sync({ bundleDir: SKILLS_BUNDLE(), targetDir: SKILLS_TARGET(), version: VERSION }); } catch (e) { console.warn('[skills]', e.message); }
  return skillStatus;
}

/** Katalog skills v jazyce aplikace: angličtina z catalog.en.json přes české texty (co chybí, zůstane česky). */
function skillsCatalog() {
  const c = skills.catalog(SKILLS_BUNDLE());
  if (I18N.lang !== 'en' || !c) return c;
  let en = null;
  try { en = JSON.parse(fs.readFileSync(path.join(SKILLS_BUNDLE(), 'catalog.en.json'), 'utf8')); } catch { return c; }
  return {
    ...c,
    groups: (c.groups || []).map((g) => ({ ...g, title: en.groups?.[g.id] || g.title })),
    skills: (c.skills || []).map((s) => ({ ...s, ...(en.skills?.[s.name] || {}) })),
  };
}

function skillsData() {
  return {
    catalog: skillsCatalog(),
    status: Object.fromEntries(skillStatus.map((s) => [s.name, s])),
    targetDir: SKILLS_TARGET(),
    claudeDir: skills.CLAUDE_SKILLS(),
    lang: I18N.lang,
  };
}

function openSkillsWindow() {
  if (skillsWin && !skillsWin.isDestroyed()) { if (skillsWin.isMinimized()) skillsWin.restore(); skillsWin.focus(); return; }
  if (!skillStatus.length) syncSkills();
  skillsWin = new BrowserWindow({
    width: 980, height: 820, minWidth: 560, minHeight: 420, title: I18N.t('win.skills'),
    show: !process.env.ZDARMA_HIDDEN, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#f7f6f3',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'skillsPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  skillsWin.setMenu(null);
  watchWindow(skillsWin, 'skills');
  if (process.env.ZDARMA_HIDDEN) { skillsWin.setSkipTaskbar(true); skillsWin.setPosition(-4000, -4000); skillsWin.showInactive(); }
  skillsWin.webContents.on('will-navigate', (ev) => ev.preventDefault());
  skillsWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  skillsWin.on('closed', () => { skillsWin = null; });
  skillsWin.loadFile(path.join(__dirname, 'renderer', 'skills.html'));
}

const fromSkills = (e) => skillsWin && !skillsWin.isDestroyed() && e.sender === skillsWin.webContents;
ipcMain.handle('skills:data', (e) => (fromSkills(e) ? skillsData() : null));
ipcMain.handle('skills:resync', (e) => { if (!fromSkills(e)) return null; syncSkills(); return skillsData(); });
ipcMain.handle('skills:openFolder', (e) => { if (fromSkills(e)) shell.openPath(SKILLS_TARGET()); });
ipcMain.handle('skills:copy', (e, text) => { if (fromSkills(e) && typeof text === 'string') require('electron').clipboard.writeText(text.slice(0, 5000)); });
ipcMain.handle('skills:openUrl', (e, url) => { if (fromSkills(e) && /^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url); });
ipcMain.handle('skills:show', () => { openSkillsWindow(); return true; });

// ---------------------------------------------------------------- monitor (src/monitor.js)
// Okno „Monitor“: stav součástí, modely (fungují? rychlost, chyby), právě běžící dotazy, poslední volání s celým
// obsahem (úplný záznam, src/callLog.js), relace, zásahy guardu, upozornění. Stejný snímek každých 15 s do
// logs/monitor-now.json (čte ho i Claude při ladění) a nová / skončená upozornění do úplného logu.
let monitorWin = null;
let omniRowsAt = 0;
let monitorBusy = null;
async function monitorSnapshot() {
  if (monitorBusy) return monitorBusy;
  monitorBusy = (async () => {
    if (omni?.ready && Date.now() - omniRowsAt > 8000) {
      omniRowsAt = Date.now();
      try { monitor.addOmniRows(await omni.api('GET', '/api/usage/call-logs?limit=300')); } catch {}
    }
    let diskFree = null;
    try { const st = fs.statfsSync(DATA()); diskFree = st.bavail * st.bsize; } catch {}
    return monitor.snapshot({
      version: VERSION,
      omni: { ready: !!omni?.ready, url: omni?.url || '', error: omniState.error, starting: omniState.starting, providers: omni?.nodeToProvider?.size || 0, combos: omni?.baseLists?.size || 0 },
      omniEngine: omni,
      opencode: { url: ocServer.url || '', running: !!ocServer.port, expected: !!(ocWin && !ocWin.isDestroyed()), restarts: watchRestarts.length },
      race: raceProxy ? { url: raceUrl, n: raceN(), stats: raceProxy.stats, cool: raceProxy.cool, lag: raceProxy.lag, active: raceProxy.active() } : null,
      fullLog: { on: !!fullLog, file: fullLog ? fullLog.file() : '' },
      callLog: { on: !!callLog, todayBytes: callLog ? callLog.todayBytes() : 0, dir: callLog ? callLog.dir : '' },
      calls: callLog ? callLog.recent : [],
      keyHealth,
      diskFree,
    });
  })();
  try { return await monitorBusy; } finally { monitorBusy = null; }
}
// Pauzy modelů v OmniRoute (OmniRoute.syncCooldowns): závod a vidění vynechají model, který OmniRoute drží v pauze
// (po 429 až do resetu podle poskytovatele, OVH bez klíče do 1. 1.), monitor ukáže do kdy; delší pauzu po 30 min smaže.
let cooldownErr = '';
setInterval(async () => {
  if (!omni?.ready || !omni.syncCooldowns) return;
  try {
    await omni.syncCooldowns();
    cooldownErr = '';
  } catch (e) {
    if (e.message !== cooldownErr) { cooldownErr = e.message; logLine('[omniroute] pauzy modelů nejde načíst:', e.message); }
  }
}, 20000).unref?.();
setInterval(async () => {
  if (!fullLog) return;
  try {
    const snap = await monitorSnapshot();
    const { added, ended } = monitor.alertChanges(snap.alerts);
    for (const a of added) fullLog.write('monitor', 'alert', `Monitor – upozornění (${a.level}): ${alertText(a)}`, a);
    for (const k of ended) fullLog.write('monitor', 'alert-end', `Monitor – upozornění skončilo: ${k}`, { key: k });
    const { omniEngine, ...light } = snap;
    fs.writeFileSync(path.join(FULLLOG_DIR(), 'monitor-now.json'), JSON.stringify(light, null, 1));
  } catch {}
}, 15000).unref?.();

function openMonitorWindow() {
  if (monitorWin && !monitorWin.isDestroyed()) { if (monitorWin.isMinimized()) monitorWin.restore(); monitorWin.focus(); return; }
  monitorWin = new BrowserWindow({
    width: 1280, height: 900, minWidth: 720, minHeight: 480, title: I18N.t('win.monitor'),
    show: !process.env.ZDARMA_HIDDEN, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#f7f6f3',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'monitorPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  monitorWin.setMenu(null);
  watchWindow(monitorWin, 'monitor');
  if (process.env.ZDARMA_HIDDEN) { monitorWin.setSkipTaskbar(true); monitorWin.setPosition(-4000, -4000); monitorWin.showInactive(); }
  monitorWin.webContents.on('will-navigate', (ev) => ev.preventDefault());
  monitorWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  monitorWin.on('closed', () => { monitorWin = null; });
  monitorWin.loadFile(path.join(__dirname, 'renderer', 'monitor.html'));
}
const fromMonitor = (e) => monitorWin && !monitorWin.isDestroyed() && e.sender === monitorWin.webContents;
ipcMain.handle('monitor:snapshot', async (e) => {
  if (!fromMonitor(e)) return null;
  const { omniEngine, ...snap } = await monitorSnapshot();
  return { ...snap, lang: I18N.lang };
});
ipcMain.handle('monitor:call', (e, id) => (fromMonitor(e) && callLog && typeof id === 'string' ? callLog.read(id) : null));
ipcMain.handle('monitor:openLogs', (e) => { if (fromMonitor(e)) { fs.mkdirSync(FULLLOG_DIR(), { recursive: true }); shell.openPath(FULLLOG_DIR()); } });
ipcMain.handle('monitor:openCalls', (e) => { if (fromMonitor(e)) { const d = path.join(FULLLOG_DIR(), 'calls'); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } });
ipcMain.handle('monitor:report', async (e) => { if (!fromMonitor(e)) return ''; const f = await writeSelfReport('monitor'); if (f) shell.openPath(f); return f; });
ipcMain.handle('monitor:copy', (e, text) => { if (fromMonitor(e) && typeof text === 'string') require('electron').clipboard.writeText(text.slice(0, 2_000_000)); });
ipcMain.handle('monitor:fullLog', (e, on) => { if (!fromMonitor(e)) return false; settings.fullLog = !!on; saveSettings(); if (on) startFullLog(); else stopFullLog(); return !!fullLog; });
ipcMain.handle('oc:openMonitor', (e) => { if (ocWin && !ocWin.isDestroyed() && e.sender === ocWin.webContents) { openMonitorWindow(); return true; } return false; });

// Hlavní skript rozhraní OpenCode se při načtení upraví (viz ocPatch.js); ostatní požadavky projdou beze změny.
let ocPatchInstalled = false;
function installOcPatch() {
  if (ocPatchInstalled) return;
  ocPatchInstalled = true;
  const ses = session.fromPartition(OC_PARTITION); // jen okno OpenCode, ostatní okna se nedotkne
  // Mini přehrávač: YouTube odmítá vložené video, když stránka rodiče je místní adresa (http://127.0.0.1) –
  // chyba 153 / „This video is unavailable“ (ověřeno 14. 11. i v běžném Chromiu; na https stránce hraje).
  // Jen u požadavků na domény YouTube se místní referrer nahradí https adresou přehrávače.
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.youtube-nocookie.com/*', 'https://*.youtube.com/*'] }, (d, cb) => {
    const h = d.requestHeaders;
    const ref = h.Referer || h.referer || '';
    if (!ref || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(ref)) { delete h.referer; h.Referer = 'https://www.youtube-nocookie.com/'; }
    cb({ requestHeaders: h });
  });
  ses.protocol.handle('http', async (req) => {
    const res = await ses.fetch(req, { bypassCustomProtocolHandlers: true });
    // mini přehrávač nad promptem (ocPreload.initVideoDock): povolit jen rámeček YouTube, nic dalšího
    const csp = res.headers.get('content-security-policy');
    if (csp && req.url.startsWith(ocOrigin()) && !/frame-src/i.test(csp)) {
      const headers = new Headers(res.headers);
      headers.set('content-security-policy', csp + '; frame-src https://www.youtube-nocookie.com https://www.youtube.com');
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(await res.arrayBuffer(), { status: res.status, headers });
    }
    if (!res.ok || !ocPatch.isMainBundle(req.url) || !req.url.startsWith(ocOrigin())) return res;
    const { code, patched } = ocPatch.patchBundle(await res.text());
    if (!patched) console.warn('[opencode] Vzor pro výběr složky v této verzi OpenCode nenalezen, zůstává původní výběr.');
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(code, { status: res.status, headers });
  });
}

// ---------------------------------------------------------------- výběr složky (rychlý přístup + dialog Windows)

let picker = null; // { win, resolve, multiple }
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const uniqPaths = (list) => { const out = []; for (const p of list) if (p && !out.some((x) => samePath(x, p))) out.push(path.resolve(p)); return out; };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

async function ocProjects() {
  if (!ocServer.url) return [];
  try {
    const list = await (await fetch(ocServer.url + 'project', { signal: AbortSignal.timeout(2000) })).json();
    return (Array.isArray(list) ? list : []).sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)).map((p) => p.worktree).filter(Boolean);
  } catch { return []; }
}

// Složka s víc projekty uvnitř (např. „Claude code“ se zdarma, lossless-player…): agent v ní bloudí mezi
// projekty (změřeno v chatu uživatele 7.–8. 11.). Výběr složky na to upozorní a nabídne konkrétní projekty.
const PROJECT_MARKERS = ['package.json', '.git', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', '*.sln', '*.csproj'];
function isProjectDir(p) {
  try {
    const names = fs.readdirSync(p);
    return PROJECT_MARKERS.some((m) => (m.startsWith('*') ? names.some((n) => n.endsWith(m.slice(1))) : names.includes(m)));
  } catch { return false; }
}
function subProjects(p) {
  if (isProjectDir(p)) return [];
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => path.join(p, d.name)).filter(isProjectDir).slice(0, 12);
  } catch { return []; }
}

async function pickerData() {
  const forgot = settings.forgotFolders || [];
  const pinned = uniqPaths(settings.pinnedFolders || []).filter(isDir);
  const recent = uniqPaths([...(settings.recentFolders || []), ...(await ocProjects()), ...(settings.recentCwds || [])])
    .filter((p) => isDir(p) && !forgot.some((f) => samePath(f, p))).slice(0, 25);
  const multi = {};
  for (const p of [...pinned, ...recent]) { const s = subProjects(p); if (s.length >= 2) multi[p] = s; }
  return { pinned, recent, multi, lang: I18N.lang };
}

function rememberFolder(p) {
  settings.recentFolders = uniqPaths([p, ...(settings.recentFolders || [])]).filter(isDir).slice(0, 20);
  settings.forgotFolders = (settings.forgotFolders || []).filter((f) => !samePath(f, p));
  settings.lastCwd = path.resolve(p);
  saveSettings();
}

function finishPicker(result) {
  const pk = picker;
  if (!pk) return;
  picker = null;
  const list = [].concat(result || []).filter(isDir);
  list.forEach(rememberFolder);
  pk.resolve(list.length ? (list.length > 1 ? list : list[0]) : null);
  if (!pk.win.isDestroyed()) pk.win.destroy();
}

ipcMain.on('oc:prefs', (e) => {
  // texty panelu v OpenCode přeložené předem (sandboxovaný preload si soubor s překlady načíst nemůže)
  const strings = Object.fromEntries(I18N.keys().filter((k) => k.startsWith('oc.')).map((k) => [k, I18N.t(k)]));
  e.returnValue = ocWin && !ocWin.isDestroyed() && e.sender === ocWin.webContents
    ? {
      classicLayout: settings.ocClassicLayout !== false,
      videoDock: settings.videoDock !== false,
      lang: I18N.lang,
      locale: I18N.locale(),
      strings,
      modelPopupWidth: Number(settings.modelPopupWidth) || 680,
      modelPopupHeight: Number(settings.modelPopupHeight) || 560,
    }
    : {};
});
// web OpenCode hlásí prázdný výběr modelu („No model results“ bez hledání) → hlídač hned, s reakcí
let uiNoModelsAt = 0;
ipcMain.on('oc:noModels', (e) => {
  if (!ocWin || ocWin.isDestroyed() || e.sender !== ocWin.webContents) return;
  if (Date.now() - uiNoModelsAt < 20000) return;
  uiNoModelsAt = Date.now();
  logLine('[opencode] výběr modelu je prázdný (No model results) –', ocWin.webContents.getURL().slice(-80));
  watchInstances('ui').catch(() => {});
});
// Novější sestavení na ploše (czek-ai-X.Y.Z.exe vedle běžící czek-ai.exe) → lišta v okně OpenCode s restartem.
const upgrade = require('./upgrade');
const DESKTOP_DIR = () => process.env.CZEK_DESKTOP_DIR || app.getPath('desktop');
ipcMain.handle('app:update', () => {
  // nainstalovaná verze (instalátor czek-ai-X.Y.Z-setup.exe) se aktualizuje novým instalátorem, ne výměnou exe
  if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE) return null;
  const nb = upgrade.newerBuild(DESKTOP_DIR(), VERSION);
  return nb ? { current: VERSION, version: nb.version } : null;
});
ipcMain.handle('app:upgrade', (e) => {
  if (!ocWin || ocWin.isDestroyed() || e.sender !== ocWin.webContents) return false;
  const nb = upgrade.newerBuild(DESKTOP_DIR(), VERSION);
  // spuštěná přenosná exe (electron-builder portable); nová jde vždy na czek-ai.exe (viz upgradeTarget)
  const { to: target, old } = upgrade.upgradeTarget(process.env.PORTABLE_EXECUTABLE_FILE);
  if (!nb || !target) { logLine('[app] přechod na novou verzi nejde:', !nb ? 'žádná novější na ploše' : 'neběží přenosná exe'); return false; }
  const cmdFile = path.join(require('os').tmpdir(), `czek-upgrade-${Date.now()}.cmd`);
  fs.writeFileSync(cmdFile, upgrade.upgradeScript({ from: nb.file, to: target, old }));
  require('child_process').spawn('cmd.exe', ['/c', cmdFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  logLine('[app] přechod na verzi', nb.version, '→', target);
  setTimeout(() => app.quit(), 300);
  return true;
});
ipcMain.handle('oc:openSettings', (_e, page) => { openZdarma(page === 'models' ? 'models' : 'settings'); return true; });
ipcMain.handle('oc:setPopupSize', (_e, d) => {
  const w = Math.max(320, Math.min(1400, Number(d?.w) || 680));
  const h = Math.max(260, Math.min(1100, Number(d?.h) || 560));
  settings.modelPopupWidth = w;
  settings.modelPopupHeight = h;
  saveSettings();
  if (ocWin && !ocWin.isDestroyed()) ocWin.webContents.send('oc:popupSize', { w, h });
  return { w, h };
});
ipcMain.handle('win:close', () => {
  if (ocWin && !ocWin.isDestroyed() && win && !win.isDestroyed()) {
    win.close();
    if (ocWin.isMinimized()) ocWin.restore();
    ocWin.focus();
    return { closed: true };
  }
  return { closed: false };
});

const fromPicker = (e) => picker && !picker.win.isDestroyed() && e.sender === picker.win.webContents;

ipcMain.handle('oc:pickFolder', (e, opts) => {
  if (!ocWin || ocWin.isDestroyed() || e.sender !== ocWin.webContents) return null;
  if (picker) { picker.win.focus(); return null; }
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      parent: ocWin, modal: true, width: 620, height: 560, minWidth: 420, minHeight: 360,
      title: opts?.title || I18N.t('picker.title'), show: false, autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#f7f6f3',
      icon: path.join(__dirname, 'renderer', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'pickerPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.setMenu(null);
    picker = { win: w, resolve, multiple: !!opts?.multiple };
    w.on('closed', () => finishPicker(null));
    w.once('ready-to-show', () => { if (process.env.ZDARMA_HIDDEN) { w.setPosition(-3800, -3800); w.showInactive(); } else w.show(); });
    w.webContents.on('will-navigate', (ev) => ev.preventDefault());
    w.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
  });
});

ipcMain.handle('picker:data', (e) => (fromPicker(e) ? pickerData() : null));
ipcMain.handle('picker:choose', (e, p) => { if (fromPicker(e) && isDir(p)) finishPicker(p); });
ipcMain.handle('picker:cancel', (e) => { if (fromPicker(e)) finishPicker(null); });
ipcMain.handle('picker:browse', async (e) => {
  if (!fromPicker(e)) return;
  const r = await dialog.showOpenDialog(picker.win, {
    title: I18N.t('picker.dlgPick'),
    defaultPath: isDir(settings.lastCwd) ? settings.lastCwd : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory', ...(picker?.multiple ? ['multiSelections'] : [])],
  });
  if (picker && !r.canceled && r.filePaths.length) finishPicker(r.filePaths);
});
ipcMain.handle('picker:addPinned', async (e) => {
  if (!fromPicker(e)) return null;
  const r = await dialog.showOpenDialog(picker.win, {
    title: I18N.t('picker.dlgAdd'),
    defaultPath: isDir(settings.lastCwd) ? settings.lastCwd : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory', 'multiSelections'],
  });
  if (!r.canceled) { settings.pinnedFolders = uniqPaths([...(settings.pinnedFolders || []), ...r.filePaths]); saveSettings(); }
  return pickerData();
});
ipcMain.handle('picker:pin', (e, p, on) => {
  if (!fromPicker(e) || typeof p !== 'string') return null;
  const rest = (settings.pinnedFolders || []).filter((x) => !samePath(x, p));
  settings.pinnedFolders = on ? uniqPaths([...rest, p]) : rest;
  saveSettings();
  return pickerData();
});
ipcMain.handle('picker:forget', (e, p) => {
  if (!fromPicker(e) || typeof p !== 'string') return null;
  settings.recentFolders = (settings.recentFolders || []).filter((x) => !samePath(x, p));
  settings.forgotFolders = uniqPaths([...(settings.forgotFolders || []), p]).slice(-100);
  saveSettings();
  return pickerData();
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:set', (_e, patch) => {
  const p = patch || {};
  for (const k of ['model', 'mode', 'fallback', 'temperature', 'favorites', 'lastCwd', 'recentCwds', 'unfiltered', 'uncensoredMarks']) if (k in p) settings[k] = p[k];
  if ('tiers' in p) settings.tiers = tiers.sanitize(p.tiers);
  if ('preferFamilies' in p && Array.isArray(p.preferFamilies)) {
    settings.preferFamilies = p.preferFamilies.map((s) => String(s).trim()).filter((s) => s && s.length <= 60).slice(0, 20);
  }
  if ('wizardDone' in p) settings.wizardDone = !!p.wizardDone;
  if ('benchSkipped' in p) settings.benchSkipped = !!p.benchSkipped; // nabídka benchmarku po průvodci: Přeskočit
  if ('ocOnlyTiers' in p) settings.ocOnlyTiers = !!p.ocOnlyTiers;
  if ('ocProviders' in p) settings.ocProviders = !!p.ocProviders;
  if ('showUnfiltered' in p) settings.showUnfiltered = !!p.showUnfiltered;
  if ('modelPopupWidth' in p || 'modelPopupHeight' in p) {
    if ('modelPopupWidth' in p) settings.modelPopupWidth = Math.max(320, Math.min(1400, Number(p.modelPopupWidth) || 680));
    if ('modelPopupHeight' in p) settings.modelPopupHeight = Math.max(260, Math.min(1100, Number(p.modelPopupHeight) || 560));
    if (ocWin && !ocWin.isDestroyed()) ocWin.webContents.send('oc:popupSize', { w: settings.modelPopupWidth, h: settings.modelPopupHeight });
  }
  if ('lang' in p) {
    settings.lang = p.lang === 'en' ? 'en' : 'cs';
    I18N.setLang(settings.lang);
    if (ocWin && !ocWin.isDestroyed()) { ocWin.setMenu(opencodeMenu()); ocWin.webContents.reload(); } // menu i panel v OpenCode
    setTimeout(() => refreshOpencodeModels().catch(() => {}), 0); // názvy tierlistů v nabídce modelů OpenCode (restart až v klidu)
  }
  if ('ocFullAuto' in p && !!p.ocFullAuto !== !!settings.ocFullAuto) {
    settings.ocFullAuto = p.ocFullAuto === true;
    logLine('[full-auto]', settings.ocFullAuto ? 'ZAPNUTO' : 'vypnuto');
    // OpenCode čte konfiguraci jen při startu → zapsat a restartovat jeho server, až nebude nic rozpracované
    setTimeout(() => refreshOpencodeModels().catch((e) => logLine('[full-auto] zápis selhal', e.message)), 0);
  }
  if ('router' in p) {
    settings.router = p.router === 'zdarma' ? 'zdarma' : 'omniroute';
    if (settings.router === 'zdarma') stopOmni(); else setTimeout(() => startOmni(), 0);
    setTimeout(() => send('proxy:changed', proxyStatus()), 50);
  }
  if (p.provider) {
    const { id, key, enabled } = p.provider;
    settings.providers[id] = settings.providers[id] || {};
    if (key !== undefined) settings.providers[id].key = WIZARD.cleanKey(key); // i v Nastavení: „Bearer …“, uvozovky, NAZEV=…
    if (enabled !== undefined) settings.providers[id].enabled = !!enabled;
    registry.invalidate();
  }
  if (p.custom) {
    const c = p.custom;
    const list = settings.customProviders;
    const i = list.findIndex((x) => x.id === c.id);
    if (c.remove) { if (i >= 0) list.splice(i, 1); } else {
      const prev = i >= 0 ? list[i] : {};
      const item = { id: c.id || 'custom-' + Date.now().toString(36), name: c.name ?? prev.name, baseUrl: c.baseUrl ?? prev.baseUrl, models: c.models ?? prev.models ?? '', key: c.key !== undefined ? String(c.key).trim() : prev.key || '' };
      if (i >= 0) list[i] = item; else list.push(item);
    }
    registry.invalidate();
  }
  const proxyChanged = ('proxy' in p && p.proxy !== settings.proxy) || ('proxyPort' in p && Number(p.proxyPort) !== settings.proxyPort);
  if ('proxy' in p) settings.proxy = !!p.proxy;
  if ('proxyPort' in p) {
    const n = Number(p.proxyPort);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) settings.proxyPort = n;
  }
  saveSettings();
  if (proxyChanged) startProxy({ fallbackPort: true });
  return publicSettings();
});

ipcMain.handle('proxy:status', () => proxyStatus());

// Tierlisty pro editor v nastavení: definice s aktuálním pořadím + všechny použitelné modely.
ipcMain.handle('tiers:get', async (_e, force) => {
  const { models } = await registry.list(!!force);
  return {
    tiers: tiers.overview(models, settings, registry),
    united: tiers.uniteModels(models, settings, registry),
    models: models.filter((m) => m.usable).map((m) => ({
      key: m.key, id: m.id, provider: m.provider, providerName: m.providerName, context: m.context, tools: m.tools,
      local: m.local, strength: tiers.classify(m), uncensored: registry.isUncensored(m),
    })),
    onlyTiers: settings.ocOnlyTiers !== false,
  };
});

// Využití limitů pro panel Kontext v okně OpenCode (vkládá ho ocPreload.js).
// Panel Kontext v OpenCode: součty tokenů a volání modelu (relace / projekt / dnes / vše) z databáze OpenCode
// a dnešní pokusy přes OmniRoute po modelech (každý pokus vč. neúspěšných a záložních). Dřív se to bralo
// z vlastní proxy czek-ai, přes kterou ale od napojení pluginu OmniRoute nic nejde („Nothing has gone through
// czek-ai“, 14. 11.).
let totalsCache = { key: '', at: 0, val: null };
let omniTodayCache = { at: 0, val: null };
async function omniToday() {
  if (!omni?.ready) return null;
  if (Date.now() - omniTodayCache.at < 10000) return omniTodayCache.val;
  omniTodayCache.at = Date.now();
  try {
    const rows = await omni.api('GET', '/api/usage/call-logs?limit=2000');
    const mid = new Date(); mid.setHours(0, 0, 0, 0);
    const per = new Map();
    let calls = 0, ok = 0, errors = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (isTestRow(r) || !(Date.parse(r.timestamp) >= mid.getTime()) || !r.model || r.model === 'model-sync') continue;
      const prov = omni.nodeToProvider.get(r.provider) || r.provider || '?';
      const key = `${prov}/${r.model}`;
      const m = per.get(key) || { key, providerName: registry.provider(prov)?.p?.name || prov, calls: 0, ok: 0, errors: 0, tokens: 0, ms: 0, lastError: '' };
      const st = Number(r.status) || 0;
      m.calls++; calls++;
      if (st >= 200 && st < 300) { m.ok++; ok++; } else { m.errors++; errors++; if (!m.lastError) m.lastError = `${st} ${String(r.error || '').slice(0, 140)}`; }
      m.tokens += (Number(r.tokens?.in ?? r.tokensIn ?? r.tokens_in) || 0) + (Number(r.tokens?.out ?? r.tokensOut ?? r.tokens_out) || 0);
      m.ms += Number(r.duration) || 0;
      per.set(key, m);
    }
    omniTodayCache.val = { calls, ok, errors, models: [...per.values()].sort((a, b) => b.calls - a.calls) };
  } catch (e) { omniTodayCache.val = { error: e.message }; }
  return omniTodayCache.val;
}
ipcMain.handle('oc:limits', async (e, dir, sessionId) => {
  if (!ocWin || ocWin.isDestroyed() || e.sender !== ocWin.webContents) return null;
  const key = `${dir}|${sessionId}`;
  if (totalsCache.key !== key || Date.now() - totalsCache.at > 5000) totalsCache = { key, at: Date.now(), val: diag.usageTotals({ sessionId, dir }) };
  return { totals: totalsCache.val, omni: await omniToday() };
});

// Který model právě pracuje (pro štítek u výběru modelu v OpenCode a titulek okna).
let omniLast = null;
let omniLastAt = 0;
let omniFailSeen = new Set(); // id řádků se selháním, které už přepočet spustily
let omniFailRebalanceAt = 0;
function pollOmniLast() {
  if (!omni?.ready || Date.now() - omniLastAt < 3000) return;
  omniLastAt = Date.now();
  omni.api('GET', '/api/usage/call-logs?limit=12').then((rows) => {
    // 499 do 30 s = dotaz zrušil klient: poražení v závodě modelů (src/race.js), uživatel přerušil – ne selhání modelu
    const aborted = (x) => Number(x.status) === 499 && (Number(x.duration) || 0) < 30000;
    const list = (Array.isArray(rows) ? rows : []).filter((x) => x?.model && x.model !== 'model-sync' && !isTestRow(x) && !aborted(x));
    // Nové selhání (5xx, 429, visení…) → přepočítat pořadí hned, ne až při pravidelném přepočtu za 2 min.
    // Změřeno 15. 11. (stejný úkol 2×): první dotazy relace ztratily 84 a 126 s, protože GLM 4.7 Flash (529) a tři
    // poskytovatelé Nemotronu (503/504 po 30–45 s) zůstali v čele combo do prvního přepočtu.
    let fresh = false;
    for (const x of list) {
      const st = Number(x.status) || 0;
      if (st === 0 || (st >= 200 && st < 300) || [400, 413, 422].includes(st)) continue;
      const id = String(x.id || `${x.timestamp}|${x.model}|${st}`);
      if (!omniFailSeen.has(id)) { omniFailSeen.add(id); fresh = true; }
    }
    if (omniFailSeen.size > 400) omniFailSeen = new Set([...omniFailSeen].slice(-200));
    if (fresh && Date.now() - omniFailRebalanceAt > 15000) { omniFailRebalanceAt = Date.now(); scheduleSlowRebalance(1500); }
    const r = list[0];
    if (!r) return;
    const provId = omni.nodeToProvider.get(r.provider) || r.provider || 'omniroute';
    const provName = registry.provider(provId)?.p?.name || provId;
    // vítěz závodu má v OmniRoute jako požadovaný model sám sebe → tier podle závodu
    const req = r.requestedModel || r.requested_model || '';
    const rl = raceProxy?.stats.last;
    omniLast = {
      ok: Number(r.status) >= 200 && Number(r.status) < 300,
      model: `${provId}/${r.model}`,
      providerName: provName,
      tier: rl && rl.winner === req && Date.now() - rl.at < 10 * 60000 ? rl.combo : req,
      ms: Number(r.duration) || 0,
      error: String(r.error || '').slice(0, 120),
    };
  }).catch(() => {});
}
function activeInfo() {
  pollOmniLast();
  const a = proxy.server?.activity;
  const names = Object.fromEntries(tiers.tierDefs(settings).map((d) => [d.id, d.name]));
  const cur = a ? [...a.current.values()].sort((x, y) => y.since - x.since) : [];
  return { current: cur, last: omniLast || a?.last || null, tierNames: names, now: Date.now(), fullAuto: settings.ocFullAuto === true };
}
ipcMain.handle('oc:active', (e) => (ocWin && !ocWin.isDestroyed() && e.sender === ocWin.webContents ? activeInfo() : null));
ipcMain.handle('proxy:opencode', async () => {
  try {
    const { file } = await syncOpencodeConfig({ fresh: true });
    return { ok: true, file, status: proxyStatus() };
  } catch (e) { return { ok: false, error: e.message, status: proxyStatus() }; }
});
ipcMain.handle('opencode:open', async () => {
  try { syncSkills(); installOcPatch(); await openOpencodeWindow(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('omni:open', () => openOmniDashboard());

// Klíče, které si uživatel připojil přímo v OpenCode (dialog „Připojit poskytovatele“), převzít i do
// czek-ai, pokud tu pro téhož poskytovatele žádný není: jinak model běží mimo OmniRoute bez zálohy
// (9. 11.: Z.ai připojený jen v OpenCode). Čte se jen na tomto počítači, uloží se šifrovaně jako ostatní.
// poskytovatel v OpenCode (auth.json) → poskytovatel czek-ai / OmniRoute
const OC_PROVIDER_MAP = { zai: 'zai', 'zai-coding-plan': null, groq: 'groq', mistral: 'mistral', openrouter: 'openrouter', cerebras: 'cerebras', google: 'gemini', nvidia: 'nvidia', huggingface: 'huggingface' };
// poskytovatelé OpenCode, jejichž klíč má czek-ai (a tedy OmniRoute) → v OpenCode skrýt, ať jdou přes OmniRoute
const routedOcProviders = () => Object.entries(OC_PROVIDER_MAP).filter(([, id]) => id && settings.providers?.[id]?.key).map(([oc]) => oc);

function importOpencodeKeys() {
  try {
    const file = path.join(process.env.XDG_DATA_HOME || path.join(require('os').homedir(), '.local', 'share'), 'opencode', 'auth.json');
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = OC_PROVIDER_MAP;
    const got = [];
    for (const [ocId, id] of Object.entries(map)) {
      const a = auth[ocId];
      if (!id || !a || a.type !== 'api' || !a.key) continue;
      settings.providers[id] = settings.providers[id] || {};
      if (settings.providers[id].key) continue;
      settings.providers[id].key = String(a.key).trim();
      got.push(id);
    }
    if (got.length) { saveSettings(); logLine('[klíče] převzato z OpenCode:', got.join(', ')); }
  } catch {}
}

// Služba kontroly klíčů: každých 30 min (a 2 min po startu) nechá OmniRoute ověřit každý uložený klíč
// a spočítá využití za 24 h. Výsledek je v Nastavení u každého poskytovatele; neplatný klíč jde do logu.
let keyHealth = { at: 0, items: [] };
let keyHealthBusy = false;
async function runKeyHealth(test = true) {
  if (!omni?.ready || keyHealthBusy) return keyHealth;
  keyHealthBusy = true;
  try {
    const items = await omni.keyHealth({ test });
    keyHealth = { at: Date.now(), items };
    const bad = items.filter((i) => !i.ok);
    if (bad.length) logLine('[klíče] neplatné nebo odmítnuté:', bad.map((b) => b.provider + ' (' + (b.error || b.status) + ')').join(', '));
    try { send('keys:health', keyHealth); } catch {}
  } catch (e) { logLine('[klíče] kontrola selhala:', e.message); } finally { keyHealthBusy = false; }
  return keyHealth;
}
setTimeout(() => runKeyHealth(true), 2 * 60e3);
setInterval(() => runKeyHealth(true), 30 * 60e3);
// ---------------------------------------------------------------- klíče v soukromém repu (private/keys.json)
const keysync = require('./keysync');
let keysFileInfo = { file: '', at: 0, imported: [], error: '' };
/** Cesta k souboru s klíči: CZEK_KEYS_FILE → nastavení → klon repa na disku (ne v testovacím profilu). */
function keysFilePath() {
  if (process.env.CZEK_KEYS_FILE) return process.env.CZEK_KEYS_FILE;
  if (settings.keysFile) return settings.keysFile;
  if (process.env.ZDARMA_USER_DATA) return ''; // testy nikdy nesahají na skutečné repo
  if (keysFilePath.searched) return '';
  keysFilePath.searched = true;
  const f = keysync.findRepoFile();
  if (f) { settings.keysFile = f; logLine('[klíče] soubor v repu nalezen', f); }
  return f || '';
}
function writeKeysFile() {
  const file = keysFilePath();
  if (!file) return false;
  try {
    const w = keysync.write(file, settings);
    if (w) logLine('[klíče] uloženo do', file);
    keysFileInfo = { ...keysFileInfo, file, at: Date.now(), error: '' };
    return w;
  } catch (e) { keysFileInfo.error = e.message; logLine('[klíče] zápis selhal', e.message); return false; }
}
/** Doplní chybějící klíče ze souboru a soubor srovná s místními klíči. */
function syncKeysFile() {
  const file = keysFilePath();
  if (!file) return [];
  let got = [];
  try { got = keysync.merge(file, settings); } catch (e) { keysFileInfo.error = e.message; }
  keysFileInfo = { file, at: Date.now(), imported: got, error: keysFileInfo.error };
  if (got.length) logLine('[klíče] doplněno ze souboru v repu:', got.join(', '));
  saveSettings(); // uloží šifrovaně + zapíše soubor (writeKeysFile)
  return got;
}
const keysFileState = () => {
  const file = keysFilePath();
  const j = file ? keysync.read(file) : null;
  return { ...keysFileInfo, file, exists: !!j, count: j ? Object.keys(j.providers || {}).length + (j.customProviders || []).length : 0, updatedAt: j?.updatedAt || '' };
};
ipcMain.handle('keysfile:get', () => keysFileState());
ipcMain.handle('keysfile:sync', () => { syncKeysFile(); return keysFileState(); });
ipcMain.handle('keysfile:pick', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(w, {
    title: I18N.t('kf.pickTitle'),
    defaultPath: keysFilePath() || path.join(app.getPath('documents'), 'keys.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return keysFileState();
  settings.keysFile = r.filePath;
  syncKeysFile();
  return keysFileState();
});

ipcMain.handle('keys:health', (_e, force) => (force || !keyHealth.at ? runKeyHealth(true) : keyHealth));

ipcMain.handle('models:list', async (_e, force) => {
  const r = await registry.list(!!force);
  const order = registry.autoOrder(r.models, !!settings.unfiltered).map((m) => m.key);
  const united = tiers.uniteModels(r.models, settings, registry).map((u) => ({
    ...u,
    activeKey: registry.stickyUnited.get(u.slug) || u.usable[0]?.key || null,
  }));
  return {
    models: r.models.map((m) => ({ ...m, uncensored: registry.isUncensored(m) })),
    united,
    status: r.status,
    autoOrder: order,
    cooling: [...registry.cooldown.entries()].filter(([, v]) => v.until > Date.now()).map(([k, v]) => ({ key: k, until: v.until, reason: v.reason })),
  };
});

// Lehký benchmark po průvodci (uživatel 23. 11.: „po first startupu dát nabídku modely lehce benchmarknout, nebo
// vynechat … velmi nenáročný, ať nesežere usage“): jeden dotaz s max_tokens 1 na prvních BENCH_K modelů každého tieru
// (OmniRoute.probeHeads, stejně jako kontrola zdraví, jen hlouběji). Nefunkční → pauza / konec combo hned, ne až
// v prvním kroku agenta; volání jdou přes OmniRoute, takže je veřejný tierlist (src/publicTier.js) dostane hned.
const BENCH_K = Number(process.env.ZDARMA_BENCH_K) || 15;
let benchRunning = null;
function runBench() {
  if (benchRunning) return benchRunning;
  benchRunning = (async () => {
    if (!omni?.ready) return { ok: false, reason: omniInstall.running ? 'installing' : 'omni' };
    const t0 = Date.now();
    const r = await omni.probeHeads({ k: BENCH_K, force: true }); // force: i modely s čerstvým dokladem (gating kontroly zdraví)
    await omni.syncCooldowns().catch(() => {});
    await runRebalance().catch(() => {});
    const statuses = Object.values(r.results || {});
    const working = statuses.filter((s) => s === 200).length;
    let shared = 0;
    if (publicTier.sharing()) {
      try { publicTier.ingest(await omni.api('GET', '/api/usage/call-logs?limit=300')); shared = await publicTier.flush(); } catch {}
    }
    settings.benchAt = new Date().toISOString();
    saveSettings();
    const out = { ok: true, probed: r.probed || 0, working, broken: (r.probed || 0) - working, ms: Date.now() - t0, shared };
    logLine('[benchmark] modely:', JSON.stringify(out));
    return out;
  })().catch((e) => ({ ok: false, reason: 'error', error: e.message })).finally(() => { benchRunning = null; });
  return benchRunning;
}
ipcMain.handle('models:bench', () => runBench());
/** Z menu: benchmark kdykoli, výsledek systémovým oznámením (bez okna, na které by se muselo klikat). */
async function benchFromMenu() {
  const r = await runBench();
  const body = r.ok ? I18N.t('wiz.benchOk', { working: r.working, probed: r.probed, broken: r.broken, s: Math.round(r.ms / 1000) })
    : r.reason === 'installing' ? I18N.t('wiz.benchInstalling') : r.reason === 'omni' ? I18N.t('wiz.benchNoOmni') : I18N.t('wiz.benchErr', { err: r.error || r.reason });
  if (!process.env.ZDARMA_HIDDEN && Notification.isSupported()) new Notification({ title: 'czek-ai', body }).show();
}

// Průvodce klíči: „Vyzkoušet, že appka funguje“ = jeden krátký dotaz STEJNOU cestou, jakou pak jde agent:
// OmniRoute běží → závodní proxy → combo tieru Max (jako plugin v OpenCode), jinak záložní proxy czek-ai (tier Max).
// Student se tak dozví hned, ne až uprostřed práce, jestli klíče a směrování opravdu dají odpověď modelu.
ipcMain.handle('wizard:smoke', async () => {
  const t0 = Date.now();
  let url, model, headers = { 'content-type': 'application/json' }, via;
  try {
    if (omni?.ready && raceUrl) {
      url = raceUrl + '/v1/chat/completions';
      model = omni.comboFor('max') || 'zdarma-max';
      const key = omni.apiKey || await omni.ensureKey().catch(() => null);
      if (key) headers.authorization = 'Bearer ' + key;
      via = 'omniroute';
    } else {
      if (!proxy.server) await startProxy({ fallbackPort: true });
      url = proxyStatus().url + '/chat/completions';
      model = 'max';
      via = 'proxy';
    }
    const r = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(90000),
      body: JSON.stringify({ model, stream: false, max_tokens: 64, messages: [{ role: 'user', content: I18N.t('main.testPrompt') }] }) });
    const raw = await r.text();
    let j = null; try { j = JSON.parse(raw); } catch {}
    if (!r.ok) return { ok: false, via, status: r.status, error: String(j?.error?.message || raw).slice(0, 400) };
    const reply = String(j?.choices?.[0]?.message?.content || j?.choices?.[0]?.message?.reasoning_content || '').trim();
    const answered = r.headers.get('x-omniroute-model') || j?.model || model;
    logLine('[průvodce] zkouška appky:', via, answered, `${Date.now() - t0} ms`);
    return { ok: true, via, model: answered, ms: Date.now() - t0, reply: reply.slice(0, 120) };
  } catch (e) {
    return { ok: false, via, error: e.name === 'TimeoutError' ? I18N.t('wiz.smokeTimeout') : e.message };
  }
});

ipcMain.handle('provider:test', async (_e, id, modelId) => {
  const prov = registry.provider(id);
  if (!prov) return { ok: false, error: I18N.t('main.unknownProvider') };
  try {
    let mid = modelId;
    if (!mid) {
      const list = await prov.p.listModels(prov.key);
      if (!list.length) return { ok: false, error: I18N.t('main.noFree') };
      mid = (list.find((m) => m.tools) || list[0]).id;
    }
    const t0 = Date.now();
    const ctrl = new AbortController();
    if (prov.p.kind === 'horde') {
      // Stejné pořadí jako Auto (kratší fronta, víc workerů); fronta se mění, proto až 3 pokusy.
      const list = (await prov.p.listModels(prov.key)).sort((x, y) => scoreModel(y) - scoreModel(x));
      const cands = modelId ? list.filter((x) => x.id === modelId) : list.slice(0, 3);
      let last;
      for (const m of cands) {
        try {
          const r = await horde.chat({ key: prov.key, model: m.id, ctx: m.context, maxLen: 60, signal: ctrl.signal, timeoutMs: 90000, queueTimeoutMs: 40000,
            messages: [{ role: 'user', content: I18N.t('main.testPrompt') }] });
          return { ok: true, model: m.id, ms: Date.now() - t0, reply: (r.content || r.reasoning).trim().slice(0, 120) };
        } catch (e) { last = e; }
      }
      return { ok: false, error: last ? last.message : I18N.t('main.noModel') };
    }
    // Bez zadaného modelu až 3 kandidáti: první model ze seznamu poskytovatele nemusí na jeho API běžet
    // (22. 11.: NVIDIA, Kimi K3.1 Pro z extraModels → 404 „page not found“ i se správným klíčem, takže průvodce
    // klíči hlásil dobrý klíč jako nefunkční). Chyba přihlášení = špatný klíč → hned konec.
    const cands = [mid];
    if (!modelId) {
      const list = await prov.p.listModels(prov.key).catch(() => []);
      const rest = list.filter((m) => m.id !== mid).sort((x, y) => scoreModel(y) - scoreModel(x));
      for (const m of [...rest.filter((m) => m.tools), ...rest]) if (cands.length < 3 && !cands.includes(m.id)) cands.push(m.id);
    }
    let last;
    for (const m of cands) {
      try {
        const r = await streamChat({
          url: chatUrlOf(prov.p, prov.key),
          headers: prov.p.headers(prov.key),
          body: { model: m, messages: [{ role: 'user', content: I18N.t('main.testPrompt') }], max_tokens: 400 },
          signal: ctrl.signal,
          timeoutMs: cands.length > 1 ? 25000 : 60000,
        });
        return { ok: true, model: m, ms: Date.now() - t0, reply: (r.content || r.reasoning).trim().slice(0, 120) };
      } catch (e) {
        last = e;
        if (/\b(401|403)\b|unauthori|forbidden|invalid.{0,20}(key|token)|api.?key/i.test(e.message)) break;
      }
    }
    return { ok: false, error: last ? last.message : I18N.t('main.noModel') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sessions:list', () => listSessions());
ipcMain.handle('sessions:get', (_e, id) => { try { return loadSession(id); } catch { return null; } });
ipcMain.handle('sessions:delete', (_e, id) => { try { fs.unlinkSync(sessPath(id)); } catch {} return listSessions(); });
ipcMain.handle('sessions:rename', (_e, id, title) => { const s = loadSession(id); s.title = String(title).slice(0, 120); saveSession(s); return listSessions(); });

ipcMain.handle('workspace:pick', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: current || app.getPath('documents') });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

// ---------------------------------------------------------------- diagnostika (Nastavení → Diagnostika)

/** Kde diagnostiku najít zvenku (port proxy se může lišit, když 4545 drží jiný program). */
function writeEndpoint() {
  try {
    fs.mkdirSync(DIAG_DIR(), { recursive: true });
    const base = `http://127.0.0.1:${proxy.port}`;
    fs.writeFileSync(path.join(DIAG_DIR(), 'endpoint.json'), JSON.stringify({
      version: VERSION, pid: process.pid, at: new Date().toISOString(), proxy: base,
      diag: base + '/zdarma/diag', live: base + '/zdarma/live?n=200', full: base + '/zdarma/full?n=5', requests: base + '/zdarma/requests?n=100',
      files: { live: LIVE_FILE(), full: FULL_FILE(), requests: path.join(DIAG_DIR(), 'requests.jsonl'), zdarmaLog: path.join(DATA(), 'zdarma.log'), opencodeDb: diag.opencodeDbPath(), omnirouteLog: path.join(DATA(), 'omniroute', 'logs', 'application', 'app.log') },
    }, null, 2));
  } catch {}
}

// Živé události OpenCode (/global/event) → živý záznam: kroky agenta, nástroje s výsledkem a chybou, stav relace.
let ocEvAbort = null;
function startOcEvents() {
  if (ocEvAbort) return;
  const ctrl = new AbortController();
  ocEvAbort = ctrl;
  const summarize = diag.opencodeEventSummarizer((r) => liveWrite(r));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    while (!ctrl.signal.aborted) {
      const base = ocServer.url;
      if (!base) { await wait(3000); continue; }
      try {
        const r = await fetch(base.replace(/\/?$/, '/') + 'global/event', { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const ev = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = ev.split('\n').find((l) => l.startsWith('data:'));
            if (line) { if (/"step-finish"/.test(line)) sawModelActivity = true; try { const obj = JSON.parse(line.slice(5)); summarize(obj); monitor.onOcEvent(obj); if (fullLog) fullLog.ocEvent(obj); } catch {} }
          }
        }
      } catch {}
      await wait(3000);
    }
  })();
}

async function diagData(sessionId) {
  const records = diag.readTrace(DIAG_DIR(), 2000);
  const stats = diag.modelStats(records);
  let models = { models: [], status: {} };
  try { models = await registry.list(); } catch {}
  const provStatus = Object.entries(models.status || {}).map(([id, s]) => ({ id, name: registry.provider(id)?.p?.name || id, state: s.state, count: s.count || 0, error: s.error || '' }));
  let omniAttempts = [];
  if (omni?.ready) {
    try {
      const rows = await omni.api('GET', '/api/usage/call-logs?limit=120');
      omniAttempts = (Array.isArray(rows) ? rows : []).filter((r) => !isTestRow(r)).map((r) => ({
        at: r.timestamp, status: r.status, model: (omni.nodeToProvider.get(r.provider) || r.provider || '') + '/' + (r.model || ''),
        requested: r.requestedModel || r.requested_model || '', ms: r.duration, ttft: r.ttftMs ?? r.ttft_ms ?? null,
        tokIn: r.tokens?.in ?? r.tokensIn ?? r.tokens_in ?? null, tokOut: r.tokens?.out ?? r.tokensOut ?? r.tokens_out ?? null,
        error: String(r.error || '').slice(0, 200),
      }));
    } catch (e) { omniAttempts = [{ error: e.message }]; }
  }
  const ses = diag.sessions(diag.opencodeDbPath(), 60);
  const sid = sessionId || ses.list.find((s) => !s.parent)?.id;
  const detail = sid ? diag.sessionDetail(sid, diag.opencodeDbPath()) : null;
  const sizes = {
    userData: diag.sizeOf(DATA()), diagnostics: diag.sizeOf(DIAG_DIR()), omnirouteData: diag.sizeOf(path.join(DATA(), 'omniroute')),
    opencodeDb: diag.sizeOf(diag.opencodeDbPath()) + diag.sizeOf(diag.opencodeDbPath() + '-wal'),
  };
  const health = {
    proxy: { running: !!proxy.server, port: proxy.port || settings.proxyPort, error: proxy.error || '', note: proxy.note || '', inflight: proxy.server?.inflight || 0 },
    opencode: { running: !!ocServer.child, url: ocServer.url || '', version: aboutCache?.opencode || '' },
    omniroute: { enabled: settings.router !== 'zdarma', ready: !!omni?.ready, port: omni?.port || null, version: omni?.inst?.version || '', lastSync: omni?.lastSync || null, slow: omni ? [...(omni.slow || [])] : [], error: omniState.error || '' },
    active: activeInfo(),
    models: { usable: (models.models || []).filter((m) => m.usable).length, total: (models.models || []).length },
    cooling: [...registry.cooldown.entries()].filter(([, v]) => v.until > Date.now()).map(([k, v]) => ({ key: k, until: v.until, reason: v.reason })),
    version: VERSION, electron: process.versions.electron, node: process.versions.node, platform: `${process.platform} ${require('os').release()}`,
    settings: { router: settings.router, lang: settings.lang, ocFullAuto: !!settings.ocFullAuto, ocOnlyTiers: settings.ocOnlyTiers !== false, ocProviders: settings.ocProviders !== false, showUnfiltered: !!settings.showUnfiltered, preferFamilies: settings.preferFamilies, proxyPort: settings.proxyPort, model: settings.model },
  };
  return {
    at: Date.now(), health, stats, requests: records.slice(-200).reverse(), omniAttempts, providers: provStatus,
    sessions: ses, detail, sizes,
    logs: { zdarma: diag.tailFile(path.join(DATA(), 'zdarma.log'), 150), omniroute: diag.omniErrors(path.join(DATA(), 'omniroute', 'logs', 'application', 'app.log'), 80) },
    findings: diag.findings({ stats, detail, sessionsList: ses.list, sizes, health }),
  };
}
ipcMain.handle('diag:data', (_e, sessionId) => diagData(sessionId));
ipcMain.handle('diag:export', async () => {
  const d = await diagData();
  const file = path.join(app.getPath('desktop'), `czek-ai-diagnostika-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify(d, null, 2)); // klíče v nastavení nejsou (health.settings je bez nich)
  return file;
});
ipcMain.handle('diag:openFolder', () => { fs.mkdirSync(DIAG_DIR(), { recursive: true }); return shell.openPath(DIAG_DIR()); });

let aboutCache = null;
ipcMain.handle('app:about', () => {
  if (!aboutCache) {
    const ver = (bin) => { try { return require('child_process').spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).stdout.trim().split(/\r?\n/)[0].trim(); } catch { return ''; } };
    const oc = findOpencode();
    aboutCache = { opencode: oc ? ver(oc) || '?' : '', omniroute: findOmni()?.version || '', node: findNode()?.version || '' };
  }
  return { version: VERSION, electron: process.versions.electron, dataDir: DATA(), ...aboutCache };
});
ipcMain.handle('app:openData', () => shell.openPath(DATA()));
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('open:path', (_e, p) => { if (p && fs.existsSync(p)) shell.openPath(p); });
ipcMain.handle('open:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); });

ipcMain.handle('agent:send', async (_e, { sessionId, newId, text, model, mode, cwd, unfiltered }) => {
  let session;
  if (sessionId) { try { session = loadSession(sessionId); } catch {} }
  if (!session) {
    const id = /^[a-z0-9]{6,24}$/.test(newId || '') ? newId : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    session = { id, title: '', cwd, messages: [], created: Date.now() };
  }
  if (running.has(session.id)) return { error: I18N.t('main.agentRunning') };
  if (cwd && !session.messages.length) session.cwd = cwd;
  if (!session.cwd || !fs.existsSync(session.cwd)) return { error: I18N.t('main.noCwd') };
  if (!session.title && text) session.title = text.replace(/\s+/g, ' ').slice(0, 70);
  saveSession(session);

  const ctrl = new AbortController();
  running.set(session.id, ctrl);
  const sid = session.id;
  const emit = (ev) => send('agent:event', { sessionId: sid, ...ev });
  const askPermission = (req) => new Promise((resolve) => {
    const reqId = `${sid}:${req.id}`;
    pendingPerm.set(reqId, resolve);
    emit({ type: 'permission', reqId, ...req });
    ctrl.signal.addEventListener('abort', () => { if (pendingPerm.delete(reqId)) resolve({ decision: 'deny' }); });
  });

  // Běží na pozadí; renderer dostává události.
  (async () => {
    // Průběžné ukládání, ať se nic neztratí při pádu.
    const saver = setInterval(() => { try { saveSession(session); } catch {} }, 3000);
    try {
      await agent.run({ session, text, model, mode, unfiltered: !!unfiltered, emit, askPermission, signal: ctrl.signal });
    } catch (e) {
      emit({ type: 'error', text: I18N.t('main.internal', { e: e.stack || e.message }) });
    } finally {
      clearInterval(saver);
      running.delete(sid);
      try { saveSession(session); } catch {}
      emit({ type: 'idle' });
      send('sessions:changed', listSessions());
    }
  })();
  return { sessionId: sid };
});

ipcMain.handle('agent:stop', (_e, sessionId) => { running.get(sessionId)?.abort(); return true; });
ipcMain.handle('agent:running', () => [...running.keys()]);
ipcMain.handle('permission:reply', (_e, reqId, decision, note) => {
  const r = pendingPerm.get(reqId);
  if (r) { pendingPerm.delete(reqId); r({ decision, note }); }
  return true;
});

// ---------------------------------------------------------------- úvodní okno (načítání)
// Hned po startu: kroky (nastavení → OpenCode → OmniRoute → server → okno), u stahování průběh.
// Dřív se 60–80 s nedělo nic viditelného, okno OpenCode naskočilo až po startu OmniRoute.

let splash = null;
const SPLASH_STEPS = ['setup', 'opencode', 'git', 'omni', 'server', 'window'];
const splashState = { started: Date.now(), steps: Object.fromEntries(SPLASH_STEPS.map((id) => [id, { state: 'wait', detail: '', progress: null }])) };

const splashLabels = () => ({
  setup: I18N.t('splash.setup'), opencode: I18N.t('splash.opencode'), git: I18N.t('splash.git'), omni: I18N.t('splash.omni'),
  server: I18N.t('splash.server'), window: I18N.t('splash.window'),
});
function splashPush() {
  if (!splash || splash.isDestroyed()) return;
  const labels = splashLabels();
  splash.webContents.send('splash:state', {
    lang: I18N.lang,
    version: VERSION,
    started: splashState.started,
    title: I18N.t('splash.title') + '…',
    hint: splashState.hint || I18N.t('splash.hint'),
    steps: SPLASH_STEPS.map((id) => ({ id, label: labels[id], ...splashState.steps[id] })),
  });
}
function splashSet(id, state, detail = '', progress = null) {
  Object.assign(splashState.steps[id], { state, detail, progress });
  splashPush();
}
function showSplash() {
  if (splash && !splash.isDestroyed()) return;
  splashState.started = Date.now();
  const hidden = !!process.env.ZDARMA_HIDDEN;
  splash = new BrowserWindow({
    width: 440, height: 380, frame: false, resizable: false, maximizable: false, fullscreenable: false,
    show: false, center: true, title: 'czek-ai', skipTaskbar: hidden,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1a' : '#f7f6f3',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'splashPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.setMenu(null);
  splash.webContents.on('did-finish-load', splashPush);
  splash.once('ready-to-show', () => {
    if (!splash || splash.isDestroyed()) return;
    if (hidden) { splash.setPosition(-4000, -4000); splash.showInactive(); } else splash.show();
  });
  splash.on('closed', () => { splash = null; });
  splash.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
}
function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}
const splashOpen = () => !!(splash && !splash.isDestroyed());

// ---------------------------------------------------------------- automatická instalace OpenCode

// Plug and play: co na PC chybí, czek-ai stáhne do svých dat (%APPDATA%\czek-ai), nic globálně, bez admina.
const OC_LOCAL_DIR = () => path.join(DATA(), 'opencode-bin');
const GIT_LOCAL_DIR = () => path.join(DATA(), 'git');
const NODE_LOCAL_DIR = () => path.join(DATA(), 'node');
const OMNI_LOCAL_DIR = () => path.join(DATA(), 'omniroute-app');
function setLocalToolDirs() {
  setOcLocalDir(OC_LOCAL_DIR());
  setLocalGitDir(GIT_LOCAL_DIR());
  setOmniLocal({ omniDir: OMNI_LOCAL_DIR(), nodeDir: NODE_LOCAL_DIR() });
  // Profil s diakritikou: i `omniroute serve` při každém dalším startu musí běžet na Node, který nepadá na fs.cpSync
  // (jinak by po instalaci přenosným Node další start vzal zase systémový 24.12). Zkouška ~0,3 s jen u ne-ASCII cesty.
  if (/[^\x00-\x7f]/.test(DATA())) findSafeNode(DATA());
  // Složka pro třídu (czek-ai-cache vedle exe, i na sdíleném disku): instalace bez stahování z internetu.
  const cc = findClassCache([process.env.ZDARMA_CLASS_CACHE, CLASS_DIR(), setupClassDir()]);
  setClassCache(cc);
  if (cc) logLine('[třída] instaluji ze složky pro třídu', cc);
  // OmniRoute nainstalovaný jinou hlavní verzí Node, než je teď systémová (archiv pro třídu = přenosný 24) → přenosný
  try {
    const want = JSON.parse(fs.readFileSync(path.join(OMNI_LOCAL_DIR(), 'czek-install.json'), 'utf8')).node;
    const nd = !process.env.ZDARMA_IGNORE_SYSTEM_NODE && findNode();
    if (nd && nodeMajor(nd.version) !== nodeMajor(want) && fs.existsSync(path.join(NODE_LOCAL_DIR(), 'node.exe'))) {
      logLine('[install] OmniRoute je pro Node', want, ', systémový je', nd.version, '→ přenosný');
      process.env.ZDARMA_IGNORE_SYSTEM_NODE = '1';
    }
  } catch {}
}
const nodeMajor = (v) => Number(String(v || '').replace(/^v/, '').split('.')[0]) || 0;
// Složka exe: u přenosné verze ta, kde leží czek-ai.exe (ne rozbalená kopie v %TEMP%).
const CLASS_DIR = () => path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath), 'czek-ai-cache');
// Nainstalovaná verze: instalátor zapsal svou složku (build/installer.nsh, UTF-16LE) → czek-ai-cache vedle setup.exe.
function setupClassDir() {
  try {
    const b = fs.readFileSync(path.join(path.dirname(process.execPath), 'setup-dir.txt'));
    const dir = (b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b.toString('utf8')).replace(/\0/g, '').trim();
    return dir ? path.join(dir, 'czek-ai-cache') : null;
  } catch { return null; }
}
const mb = (b) => (b / 1048576).toFixed(0);

// Systémový Node.js, který padá na diakritice v cestě (installer.cpSyncBroken: Node 24.12 + C:\Users\Šimon\…),
// se pro OmniRoute nepoužije: od té chvíle findNode bere jen přenosný (stáhne se jako na PC bez Node).
function findSafeNode(dir) {
  const nd = findNode();
  if (nd && !process.env.ZDARMA_IGNORE_SYSTEM_NODE && cpSyncBroken(nd.node, dir)) {
    logLine('[install] Node.js', nd.version, 'padá na fs.cpSync s diakritikou v cestě', dir, '→ přenosný Node.js');
    process.env.ZDARMA_IGNORE_SYSTEM_NODE = '1';
    return findNode();
  }
  return nd;
}

/** Učitel: czek-ai.exe --priprav-tridu[=<složka>] → složka pro třídu (installer.prepareClassCache), průběh v úvodním okně. */
async function prepareClassFolder(dir) {
  logLine('[třída] připravuji složku pro třídu', dir);
  splashState.hint = I18N.t('splash.classHint', { dir });
  splashSet('setup', 'done');
  try {
    let nd = findSafeNode(require('os').tmpdir());
    if (!nd) {
      await installNode({ dir: NODE_LOCAL_DIR(), onProgress: (p) => { if (p.phase === 'download') splashSet('omni', 'run', I18N.t('splash.omniNode', { done: mb(p.done), total: p.total ? mb(p.total) : '?' }), null); } });
      nd = findNode();
      if (!nd) throw new Error('přenosný Node.js nejde spustit');
    }
    const t0 = Date.now();
    await prepareClassCache({
      dir, node: nd.node,
      onProgress: (p) => (p.phase === 'pack'
        ? splashSet('omni', 'run', I18N.t('splash.classPack', { min: Math.floor((p.elapsed || 0) / 60000) }), 99)
        : splashSet('opencode', 'run', I18N.t('splash.classDl', { what: p.what, done: mb(p.done), total: p.total ? mb(p.total) : '?' }), p.total ? (p.done / p.total) * 100 : null)),
      onNpm: (p) => { if (splashState.steps.opencode.state !== 'done') splashSet('opencode', 'done'); omniSplashProgress(p); },
      onLine: (l) => logLine('[třída] npm', l.slice(0, 300)),
    });
    splashSet('opencode', 'done');
    splashSet('omni', 'done');
    logLine('[třída] hotovo za', Math.round((Date.now() - t0) / 1000), 's:', dir);
    if (!process.env.ZDARMA_HIDDEN) await dialog.showMessageBox({ type: 'info', title: 'czek-ai', message: I18N.t('class.done', { dir }) });
  } catch (e) {
    logLine('[třída] selhalo', e.message);
    splashSet('omni', 'error', e.message);
    if (!process.env.ZDARMA_HIDDEN) await dialog.showMessageBox({ type: 'error', title: 'czek-ai', message: I18N.t('class.fail', { err: e.message }) });
  }
}
/** Průběh stahování do kroku úvodního okna (nejvýš ~7× za s). */
function splashDownload(step) {
  let last = 0;
  return (p) => {
    if (p.phase === 'download') {
      const now = Date.now();
      if (now - last < 150 && p.done !== p.total) return;
      last = now;
      splashSet(step, 'run', I18N.t('splash.dl', { done: mb(p.done), total: p.total ? mb(p.total) : '?' }), p.total ? (p.done / p.total) * 100 : null);
    } else if (p.phase === 'cache') { logLine('[třída]', step, 'ze složky pro třídu, bez stahování'); splashSet(step, 'run', I18N.t('splash.fromClass'), 100); }
    else if (p.phase === 'extract' || p.phase === 'verify') splashSet(step, 'run', I18N.t('splash.ocVerify'), 100);
  };
}

// Bez připojení (školní Wi-Fi při prvním startu ještě nenaskočila, kabel vypadl): stahování nesmí skončit
// anglickým „fetch failed“ a oknem s chybou. Síťová chyba → česká hláška v úvodním okně a nový pokus
// každých ~10 s, nejdéle ZDARMA_OFFLINE_WAIT_MIN (výchozí 30 min). Jiné chyby (kontrolní součet…) hned ven.
const NET_ERR = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR|socket hang up|terminated|network|timeout|aborted due to timeout/i;
const isNetErr = (e) => NET_ERR.test(`${e?.message || ''} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`);
async function retryOffline(step, fn) {
  const until = Date.now() + (Number(process.env.ZDARMA_OFFLINE_WAIT_MIN) || 30) * 60000;
  const every = Number(process.env.ZDARMA_OFFLINE_RETRY_MS) || 10000;
  for (let n = 1; ; n++) {
    try { return await fn(); } catch (e) {
      if (!isNetErr(e) || Date.now() + every > until) throw e;
      logLine(`[install] ${step}: bez připojení (${e.cause?.code || e.message}), pokus ${n}, znovu za ${every / 1000} s`);
      splashSet(step, 'run', I18N.t('splash.offline', { s: Math.round(every / 1000), n }), null);
      await new Promise((r) => setTimeout(r, every));
    }
  }
}

/** Git Bash chybí → přenosný Git for Windows (nástroj bash v OpenCode jinak běží v PowerShellu). */
let gitInstallPromise = null;
async function ensureGit() {
  if (process.platform !== 'win32') return true;
  if (findGitBash()) { splashSet('git', 'done'); return true; }
  if (gitInstallPromise) return gitInstallPromise;
  splashSet('git', 'run', I18N.t('splash.gitMissing'), 0);
  logLine('[install] Git Bash chybí, stahuji PortableGit do', GIT_LOCAL_DIR());
  gitInstallPromise = retryOffline('git', () => installGit({ dir: GIT_LOCAL_DIR(), onProgress: splashDownload('git') })).then((bash) => {
    logLine('[install] Git Bash nainstalován', bash);
    splashSet('git', 'done', I18N.t('splash.ocInstalled'));
    return true;
  }, (e) => {
    logLine('[install] Git selhal', e.message);
    splashSet('git', 'skip', I18N.t('splash.gitFail', { err: e.message }));
    return false;
  }).finally(() => { gitInstallPromise = null; });
  return gitInstallPromise;
}

// OmniRoute chybí → na pozadí: (přenosný Node.js, když systémový chybí nebo je starý) + npm install do dat czek-ai.
// Trvá 3–10 min, proto se na něj nečeká: OpenCode se otevře hned se záložním směrováním czek-ai a po
// instalaci se přepne na OmniRoute, až agent nic nedělá (refreshOpencodeModels čeká na nečinnost).
const omniInstall = { running: false, started: 0, phase: '', error: '', abort: null };
/**
 * Průběh npm install do úvodního okna (installer.installOmniroute; váhy podle změřených časů 14. 11.):
 * Node.js 0–5 % (jen když chybí), zjišťování balíčků 5–20 %, stažení 20–30 %, rozbalení na disk 30–95 %
 * (nejdelší část), instalační skripty 95–98 %. Text podle toho, co npm právě dělá.
 */
function omniSplashProgress(p) {
  const min = Math.floor(p.elapsed / 60000);
  const fr = (a, b) => Math.min(1, b > 0 ? a / b : 0);
  omniInstall.phase = `npm ${p.meta}/${p.metaTotal} ${p.tgz}/${p.total} ${mb(p.written)}/${mb(p.size)} MB ${p.scriptsDone}/${p.scriptsTotal}`;
  if (!splashOpen()) return;
  const pct = 5 + 15 * fr(p.meta, p.metaTotal) + 10 * fr(p.tgz, p.total) + 65 * fr(p.written, p.size) + 3 * fr(p.scriptsDone, p.scriptsTotal);
  let txt;
  if (p.scripts.length) txt = I18N.t('splash.omniScripts', { list: p.scripts.join(', '), min });
  else if (!p.tgz) txt = I18N.t('splash.omniResolve', { n: Math.min(p.meta, p.metaTotal), total: p.metaTotal, min });
  else if (p.tgz < p.total) txt = I18N.t('splash.omniPkgs', { done: p.tgz, total: p.total, min });
  else if (p.written < p.size * 0.99) txt = I18N.t('splash.omniExtract', { done: mb(p.written), total: mb(p.size), min });
  else txt = I18N.t('splash.omniFinish', { min });
  splashSet('omni', 'run', txt, Math.min(98, pct));
}
async function installOmniBackground() {
  if (omniInstall.running || findOmni() || settings.router === 'zdarma') return;
  Object.assign(omniInstall, { running: true, started: Date.now(), phase: 'node', error: '' });
  omniState.error = I18N.t('main.omniInstalling');
  logLine('[install] OmniRoute chybí, instaluji na pozadí do', OMNI_LOCAL_DIR());
  try {
    let nd = findSafeNode(DATA());
    // archiv ze složky pro třídu je nainstalovaný přenosným Node X → spouštět stejnou hlavní verzí (nativní moduly)
    if (nd && classTar() && nodeMajor(nd.version) !== nodeMajor(PORTABLE_NODE.version)) {
      logLine('[třída] systémový Node.js', nd.version, 'nesedí na archiv OmniRoute (Node', PORTABLE_NODE.version + ') → přenosný');
      process.env.ZDARMA_IGNORE_SYSTEM_NODE = '1';
      nd = findNode();
    }
    if (!nd) {
      logLine('[install] Node.js chybí nebo je starý, stahuji přenosný do', NODE_LOCAL_DIR());
      await installNode({ dir: NODE_LOCAL_DIR(), onProgress: (p) => {
        if (p.phase === 'cache') logLine('[třída] Node.js ze složky pro třídu, bez stahování');
        if (p.phase !== 'download') return;
        omniInstall.phase = `node ${mb(p.done)}/${mb(p.total || 0)} MB`;
        if (splashOpen()) splashSet('omni', 'run', I18N.t('splash.omniNode', { done: mb(p.done), total: p.total ? mb(p.total) : '?' }), p.total ? (p.done / p.total) * 5 : null);
      } });
      nd = findNode();
      if (!nd) throw new Error('přenosný Node.js nejde spustit');
    }
    omniInstall.phase = 'npm';
    omniInstall.abort = new AbortController(); // konec czek-ai během instalace ukončí i npm
    await installOmniroute({ dir: OMNI_LOCAL_DIR(), node: nd.node, signal: omniInstall.abort.signal, onLine: (l) => logLine('[install] npm', l.slice(0, 300)), onProgress: omniSplashProgress });
    // kterým Node se instalovalo (z archivu: připnutý přenosný) → další starty spustí OmniRoute stejnou hlavní verzí
    try { fs.writeFileSync(path.join(OMNI_LOCAL_DIR(), 'czek-install.json'), JSON.stringify({ node: classTar() ? 'v' + PORTABLE_NODE.version : nd.version, at: new Date().toISOString() })); } catch {}
    logLine('[install] OmniRoute nainstalován za', Math.round((Date.now() - omniInstall.started) / 1000), 's');
    omniInstall.running = false;
    omniState.error = '';
    aboutCache = null;
    if (splashOpen()) splashSet('omni', 'run', I18N.t('splash.omniWait'), null);
    const o = await startOmni();
    if (!o?.ready) splashSet('omni', 'skip', omniState.error || I18N.t('main.omniMissing'));
    if (o?.ready) {
      splashSet('omni', 'done');
      await refreshOpencodeModels().catch((e) => logLine('[install] přepnutí na OmniRoute', e.message));
    }
  } catch (e) {
    omniInstall.error = e.message;
    omniState.error = I18N.t('main.omniInstallFail', { err: e.message });
    logLine('[install] OmniRoute selhal', e.message);
    splashSet('omni', 'skip', omniState.error);
  } finally {
    omniInstall.running = false;
    splashState.hint = '';
    splashPush();
    try { send('proxy:changed', proxyStatus()); } catch {}
  }
}

let ocInstallPromise = null;
/** OpenCode chybí → stáhne oficiální binárku z registru npm do dat czek-ai (src/installer.js). */
async function ensureOpencode() {
  setOcLocalDir(OC_LOCAL_DIR());
  if (findOpencode()) { splashSet('opencode', 'done'); return true; }
  if (ocInstallPromise) return ocInstallPromise;
  splashSet('opencode', 'run', I18N.t('splash.ocMissing'), 0);
  logLine('[install] OpenCode chybí, stahuji do', OC_LOCAL_DIR());
  ocInstallPromise = retryOffline('opencode', () => installOpencode({ dir: OC_LOCAL_DIR(), onProgress: splashDownload('opencode') })).then((exe) => {
    logLine('[install] OpenCode nainstalován', exe);
    splashSet('opencode', 'done', I18N.t('splash.ocInstalled'));
    aboutCache = null;
    return true;
  }, (e) => {
    logLine('[install] selhalo', e.message);
    splashSet('opencode', 'error', e.message);
    return false;
  }).finally(() => { ocInstallPromise = null; });
  return ocInstallPromise;
}

// ---------------------------------------------------------------- start

/** Hlavní okno: OpenCode. Když OpenCode chybí nebo nejde spustit, otevře se původní chat se zprávou. */
async function openMain() {
  syncSkills(); // před startem serveru OpenCode, ať skills rovnou načte
  try {
    installOcPatch();
    await openOpencodeWindow();
  } catch (e) {
    logLine('[app] OpenCode se neotevřel', e.message);
    if (splashOpen()) {
      const failed = SPLASH_STEPS.find((id) => splashState.steps[id].state === 'run') || 'server';
      splashSet(failed, 'error', e.message);
    }
    createWindow('chat');
    closeSplash();
    dialog.showErrorBox('czek-ai – OpenCode', I18N.t('dlg.ocFailed', { err: e.message }));
  }
}

// Jedna instance na profil: druhé spuštění jen přepne do už otevřeného okna.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--proxy')) return;
  // Okno vytvořené přímo uvnitř této události v zabalené appce hned po startu spadlo (renderer
  // STATUS_BREAKPOINT, viz zdarma.log) – proto až v dalším kole smyčky událostí.
  setTimeout(() => {
    if (argv.includes('--classic')) { openZdarma('chat'); return; }
    if (ocWin && !ocWin.isDestroyed()) { if (ocWin.isMinimized()) ocWin.restore(); ocWin.focus(); return; }
    openMain();
  }, 0);
});

app.on('will-quit', () => { omniInstall.abort?.abort(); clearTimeout(refreshTimer); ocEvAbort?.abort(); ocServer.stop(); stopOmni(); });
// Proč Zdarma skončila: 8. 11. 0.12.11 po 50 s zmizela a log neřekl nic (zavřené okno? pád?).
let quitting = false;
app.on('before-quit', () => { quitting = true; logLine('[app] ukončení (before-quit)'); });
app.on('render-process-gone', (_e, wc, d) => logLine('[app] renderer skončil', d?.reason, d?.exitCode, wc?.getURL?.() || ''));
app.on('child-process-gone', (_e, d) => logLine('[app] podproces skončil', d?.type, d?.reason, d?.exitCode, d?.name || ''));
process.on('uncaughtException', (e) => { try { logLine('[app] nezachycená chyba', e?.stack || String(e)); } catch {} });
process.on('unhandledRejection', (e) => { try { logLine('[app] nezachycené odmítnutí', e?.stack || String(e)); } catch {} });

app.whenReady().then(async () => {
  if (!gotLock) return;
  logLine('[app] start', VERSION, process.execPath);
  loadSettings();
  setLocalToolDirs();
  // Příkazová řádka (pro Clauda / skripty, bez okna): --keys-file=<cesta> uloží cestu, --export-keys=<soubor>
  // zapíše klíče do souboru, --import-keys=<soubor> z něj doplní chybějící. Pak konec.
  const argOf = (n) => { const a = process.argv.find((x) => x.startsWith(n + '=')); return a ? a.slice(n.length + 1) : null; };
  const kfArg = argOf('--keys-file'), exArg = argOf('--export-keys'), imArg = argOf('--import-keys');
  if (kfArg || exArg || imArg) {
    if (kfArg) { settings.keysFile = path.resolve(kfArg); syncKeysFile(); console.log('[klíče] soubor:', settings.keysFile); }
    if (imArg) { const got = keysync.merge(path.resolve(imArg), settings); saveSettings(); console.log('[klíče] doplněno:', got.join(', ') || 'nic'); }
    if (exArg) { keysync.write(path.resolve(exArg), settings); console.log('[klíče] zapsáno:', path.resolve(exArg)); }
    app.quit(); // ne app.exit: šifrovací klíč safeStorage (Local State) se zapíše až při řádném ukončení
    return;
  }
  // Report o výkonu z příkazové řádky (bez okna): --self-report nebo --self-report=<dny>
  const srArg = process.argv.find((x) => x === '--self-report' || x.startsWith('--self-report='));
  if (srArg) {
    const file = await writeSelfReport('cli', Number(srArg.split('=')[1]) || 2);
    console.log('[self-report]', file || 'nic nezapsáno (vypnuto nebo chyba, viz zdarma.log)');
    app.quit();
    return;
  }
  const ptArg = process.argv.find((x) => x === '--priprav-tridu' || x.startsWith('--priprav-tridu='));
  if (ptArg) {
    showSplash();
    await prepareClassFolder(ptArg.includes('=') ? path.resolve(ptArg.slice(ptArg.indexOf('=') + 1)) : CLASS_DIR());
    closeSplash();
    app.quit();
    return;
  }
  // úvodní okno až po příkazové řádce (export/import klíčů běží bez okna)
  const withSplash = !HEADLESS && !CLASSIC;
  if (withSplash) showSplash();
  syncKeysFile(); // klíče z private/keys.json v soukromém repu (jiný PC je tam mohl přidat)
  importOpencodeKeys();
  startFullLog();
  if (HEADLESS) {
    const portArg = process.argv.find((a) => /^--port=\d+$/.test(a));
    if (portArg) settings.proxyPort = Number(portArg.split('=')[1]);
    settings.proxy = true;
    const st = await startProxy();
    if (!st.running) {
      // Typicky už proxy běží v otevřené Zdarmě – to je v pořádku.
      console.log(`[proxy] ${st.error}`);
      app.exit(proxy.portBusy ? 0 : 1);
      return;
    }
    console.log(`[proxy] Zdarma ${VERSION} poslouchá na ${st.url} (Ctrl+C ukončí)`);
    startOmni().then(() => console.log(`[proxy] ${proxyStatus().router.text}`));
    return;
  }
  if (CLASSIC) { createWindow('chat'); startOmni(); startProxy({ fallbackPort: true }); return; }
  splashSet('setup', 'done');
  // OpenCode a Git Bash (stažení, když chybí) a OmniRoute (~60 s) najednou – jinak by se čekalo postupně
  const toolsReady = Promise.all([ensureOpencode(), ensureGit()]);
  let omniReady = null;
  if (settings.router === 'zdarma') splashSet('omni', 'skip', I18N.t('splash.omniOff'));
  else if (!findOmni()) {
    // Úvodní okno na instalaci počká a ukáže průběh (uživatel 14. 11.: „stahování přidej do loading screenu“;
    // dřív běžela na pozadí jen s časem v titulku okna a zavření appky ji 2× utnulo, pak začala znovu).
    splashState.hint = I18N.t('splash.omniHint');
    splashSet('omni', 'run', I18N.t('splash.omniInstall'), 0);
    omniReady = installOmniBackground();
  } else {
    splashSet('omni', 'run', I18N.t('splash.omniWait'));
    const o = await startOmni(); // OmniRoute s nástěnkou a auto/coding běží přímo pro OpenCode
    if (o?.ready) splashSet('omni', 'done');
    else splashSet('omni', 'skip', omniState.error || I18N.t('main.omniMissing'));
  }
  startProxy({ fallbackPort: true }); // záložní směrování (než je OmniRoute) a diagnostika
  await toolsReady;
  // Nováček bez jediného klíče z průvodce: průvodce klíči se otevře sám (bez klíčů ve škole free modely hned
  // narazí na limit na IP, docs/SCORECARD.md „Bez registrace“). Testy (ZDARMA_HIDDEN) jen se ZDARMA_WIZARD=1.
  let wizardOpened = false;
  const openWizardIfNeeded = (why) => {
    if (wizardOpened || !WIZARD.needsWizard(settings) || (process.env.ZDARMA_HIDDEN && process.env.ZDARMA_WIZARD !== '1')) return;
    wizardOpened = true;
    logLine('[průvodce] žádný klíč z průvodce → otevírám průvodce klíči', why);
    openZdarma('wizard');
  };
  // Čistý PC: instalace OmniRoute trvá ~7 min (Windows, PLUG=1 app-splash 22. 11.: 407 s). Průvodce se otevře
  // hned vedle úvodního okna, ať student mezitím založí účty a vloží klíče (ověření klíče OmniRoute nepotřebuje).
  if (omniReady) openWizardIfNeeded('(během instalace OmniRoute)');
  await omniReady; // instalace OmniRoute (jen když chyběl); po ní OpenCode rovnou s OmniRoute
  await openMain();
  openWizardIfNeeded('');
  startPublicTier();
  // Staré rozbalené kopie přenosné verze v %TEMP% (0,7 GB každá) – jen u zabaleného exe, chvíli po startu.
  if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE) {
    setTimeout(() => {
      try {
        const r = require('./cleanup').cleanStaleUnpacks();
        if (r.removed.length) logLine('[cleanup] smazány staré rozbalené kopie', r.removed.join(', '), `${Math.round(r.bytes / 1048576)} MB`);
      } catch (e) { logLine('[cleanup] chyba', e.message); }
    }, 30000);
  }
  // Diagnostika: otevřít okna tak, jak to dělá menu okna OpenCode (jen se ZDARMA_DEBUG_OPEN).
  if (process.env.ZDARMA_DEBUG_OPEN) {
    setTimeout(() => { logLine('[debug] open', process.env.ZDARMA_DEBUG_OPEN); if (/skills/.test(process.env.ZDARMA_DEBUG_OPEN)) openSkillsWindow(); if (/settings/.test(process.env.ZDARMA_DEBUG_OPEN)) openZdarma('settings'); }, 4000);
  }
});
app.on('window-all-closed', () => {
  if (HEADLESS) return;
  logLine('[app] všechna okna zavřená → konec');
  for (const c of running.values()) c.abort();
  // report jen když v tomhle běhu byl model; writeSelfReport nehází, takže quit vždy proběhne
  const quit = () => app.quit();
  // poslední souhrn volání na veřejný tierlist (max 4 s, nehází), pak report a konec
  const last = (async () => { if (omni?.ready && publicTier.sharing()) { try { publicTier.ingest(await omni.api('GET', '/api/usage/call-logs?limit=300')); } catch {} await publicTier.flush(4000); } })().catch(() => {});
  if (sawModelActivity) last.then(() => writeSelfReport('zavření')).then(quit, quit);
  else last.then(quit, quit);
});
