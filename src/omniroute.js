// OmniRoute (MIT, github.com/diegosouzapw/OmniRoute) jako směrovací jádro Zdarmy.
//
// Zdarma nepřepisuje jejich router: spustí nainstalovaný `omniroute serve --headless` (jen 127.0.0.1,
// vlastní DATA_DIR), přes jejich management API do něj zapíše poskytovatele + klíče a z tierlistů udělá
// OmniRoute combo `zdarma-<tier>` (strategie lkgp = drží se modelu, který naposledy fungoval).
// Každý poskytovatel Zdarmy je v OmniRoute OpenAI-kompatibilní uzel `z-<id>` se stejnou adresou, jakou
// Zdarma ověřila – i bezklíčoví (Kilo, Pollinations, OVH, LLM7: prázdný klíč = bez hlavičky Authorization).
// Proxy Zdarmy pak tierlisty jen přeposílá (aktivita, tokeny za projekt a limity dál fungují).
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const tiers = require('./tiers');
const { chatUrlOf } = require('./providers');

const PREFIX = 'z-';
const COMBO = 'zdarma-';
const SKIP = new Set(['horde', 'omniroute']); // AI Horde není OpenAI API; OmniRoute sám sebe nepřidává
// Poskytovatelé, které má OmniRoute vestavěné nativně (s klíčem se zapíšou přímo jako nativní poskytovatelé OmniRoute).
const NATIVE = {
  opencode: 'opencode-zen',
  openrouter: 'openrouter',
  pollinations: 'pollinations',
  groq: 'groq',
  gemini: 'gemini',
  cerebras: 'cerebras',
  mistral: 'mistral',
  github: 'github',
  nvidia: 'nvidia',
  huggingface: 'huggingface',
  sambanova: 'sambanova',
  ovh: 'ovhcloud',
  llm7: 'llm7',
  kilo: 'kilo-gateway',
  zai: 'zai',
  cohere: 'cohere',
  unorouter: 'unorouter',
  requesty: 'requesty',
  orcarouter: 'orcarouter',
  routeway: 'routeway',
  bazaarlink: 'bazaarlink',
  airforce: 'api-airforce',
  xkiro: 'xkiro',
  tokenharbor: 'tokenharbor',
  nara: 'nara',
  agnes: 'agnes',
  arcee: 'arcee-ai',
  vercel: 'vercel-ai-gateway',
  together: 'together',
  fireworks: 'fireworks',
  deepinfra: 'deepinfra',
  novita: 'novita',
  hyperbolic: 'hyperbolic',
  aimlapi: 'aimlapi',
  deepseek: 'deepseek',
};
const NATIVE_IDS = new Set(Object.values(NATIVE));
const WIN = process.platform === 'win32';

// Vlastní instalace czek-ai (src/installer.js): OmniRoute v <data>/omniroute-app, přenosný Node v <data>/node.
// Nastaví main.js; globální instalace mají přednost.
const local = { omniDir: null, nodeDir: null };
const setLocal = (o) => Object.assign(local, o);

/** Nainstalovaný OmniRoute (npm i -g omniroute) → { root, bin, version } nebo null. */
function find() {
  const roots = [];
  if (process.env.ZDARMA_OMNIROUTE_ROOT) roots.push(process.env.ZDARMA_OMNIROUTE_ROOT);
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'omniroute'));
  if (local.omniDir) roots.push(path.join(local.omniDir, 'node_modules', 'omniroute'));
  for (const root of roots) {
    const bin = path.join(root, 'bin', 'omniroute.mjs');
    if (!fs.existsSync(bin)) continue;
    let version = '?';
    try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch {}
    return { root, bin, version };
  }
  return null;
}

/** Přibalený oficiální plugin OmniRoute pro OpenCode (@omniroute/opencode-plugin) → cesta ke složce nebo null. */
function findPlugin() {
  const inst = find();
  if (!inst) return null;
  const dir = path.join(inst.root, '@omniroute', 'opencode-plugin');
  return fs.existsSync(path.join(dir, 'dist', 'index.js')) ? dir : null;
}

/** Systémový Node (OmniRoute má nativní moduly pro systémový Node, ne pro Electron). Chce >=22.22.2 <23 nebo >=24. */
function findNode() {
  const cands = [];
  try {
    const r = spawnSync(WIN ? 'where' : 'which', ['node'], { encoding: 'utf8', windowsHide: true });
    cands.push(...String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch {}
  if (WIN) cands.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  if (process.env.ZDARMA_IGNORE_SYSTEM_NODE) cands.length = 0; // test: chovat se jako PC bez Node
  if (local.nodeDir) cands.push(path.join(local.nodeDir, WIN ? 'node.exe' : 'node'));
  if (local.nodeDir && !WIN) cands.push(path.join(local.nodeDir, 'bin', 'node')); // přenosný Node pro Linux (installer.installNodeLinux)
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    const v = spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() || '';
    const [maj, min, pat] = v.replace(/^v/, '').split('.').map(Number);
    const ok = maj >= 24 || (maj === 22 && (min > 22 || (min === 22 && pat >= 2)));
    if (ok) return { node: c, version: v };
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function canListen(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Adresa chatu poskytovatele → { baseUrl, chatPath } pro uzel OmniRoute. */
function splitChatUrl(url) {
  const u = new URL(url);
  if (/\/chat\/completions\/?$/.test(u.pathname)) return { baseUrl: u.origin + u.pathname.replace(/\/chat\/completions\/?$/, ''), chatPath: '' }; // '' = výchozí /chat/completions
  return { baseUrl: u.origin, chatPath: u.pathname };
}

/** Bez hlavičky s klíčem (tu dává OmniRoute z připojení). */
function extraHeaders(prov) {
  const h = { ...(prov.p.headers ? prov.p.headers('') : {}) };
  for (const k of Object.keys(h)) if (/^(authorization|x-api-key|api-key)$/i.test(k)) delete h[k];
  return Object.keys(h).length ? h : null;
}

// Měření rychlosti modelů (rebalance): okno a hranice „pomalého“ modelu
// 2 h: rychlost modelu se tak rychle nemění a po přestávce v práci (restart Zdarmy) se pomalý model
// jinak zapomněl a první požadavek na něj zase čekal (NVIDIA DeepSeek V4.1 Flash, 110 s → 504).
const SPEED_WINDOW_MS = 2 * 3600 * 1000;
const DEAD_WINDOW_MS = 6 * 3600 * 1000; // 402/404 platí dlouho: kredit ani přístup k modelu se během práce neobjeví
// 402 = účet bez kreditu (HuggingFace „Purchase pre-paid credits“): kredit se sám neobnoví. Po 6 h se HF vracel do
// combo i do nabídky (sjednocený „muse-spark“ jen od HF → uživatel ho 16. 11. vybral a dostal hned 402). 3 dny.
const CREDIT_WINDOW_MS = 72 * 3600 * 1000;
const SLOW_MS = 40000;
const HANG_WINDOW_MS = 20 * 60 * 1000; // „visel do limitu“ 2× po sobě: ven na 20 min od posledního (pak se zkusí znovu)
// Visí dál bez jediného úspěchu → ven na déle: 2× 20 min, 3× 2 h, 4× a víc 12 h (max HANG_HISTORY_MS).
// Živě 14. 11.: NVIDIA DeepSeek V4.1 Flash 39× visel, 0× odpověděl; po 20 min se vždy vrátil a stál další 2× 45 s.
const HANG_HISTORY_MS = 24 * 3600 * 1000;
// Řada visení se pamatuje i na disku (HANG_MEMO_MS): API vrací jen 500 posledních volání a paměť appky restart
// nepřežije, takže se chronicky visící model po 24 h nebo po restartu vrátil a stál další 2× 45 s (15. 11.: DeepSeek
// se 103 visením a 0 odpověďmi byl po 26 h zase první záloha; po přepnutí modelu uprostřed úkolu se navíc agent
// rozbil). Stupně: 2× 20 min, 3× 2 h, 4× 12 h, 5× 3 dny, dál 7 dní; návrat stojí jedno visení, ne dvě.
const HANG_MEMO_MS = 7 * 24 * 3600 * 1000;
const hangDeadMs = (n) => Math.min(HANG_MEMO_MS, HANG_WINDOW_MS * 6 ** (n - 2));
const LIMITED_MIN = 4; // pokusů za SPEED_WINDOW_MS, než se model počítá jako „limit vyčerpaný“
const LIMITED_SHARE = 0.75; // podíl odpovědí 429
// „Pomalý“ podle mediánu jen z aspoň tolika úspěšných pokusů: jeden 45s úspěch z dvou nesmí model přehodit
// (14. 11.: glm-4.7-flash měnil stav každé 2 min podle toho, který řádek zrovna spadl do 500 posledních).
const SLOW_MIN_SAMPLES = 3;
// závod modelů: závodníci jen z prvních RACE_TOP modelů combo v aktuálním pořadí (raceCandidates)
const RACE_TOP = 6;
const PROBE_RESERVE = 4; // kontrola zdraví bere i náhradníky závodu
// Souběžnost zapisování combo při startu (200 POSTů = 7 tierů + ~193 sjednocených modelů).
// Ladí se přes ZDARMA_SYNC_POOL. A/B měřeno 22. 11. 2026 (docs/research/loop-czek-perf/bench-syncpool.js,
// skutečný OmniRoute 3.8.53, čistá složka dat, 200 combo zapisů): span zapisů 6 → 10,0 s (průměr 296 ms),
// 16 → 10,2 s (787 ms), 32 → 18,1 s (2 665 ms, jeden zapis 18 s). OmniRoute zapisy serializuje (~20 combo/s),
// takže 6 je strop – vyšší souběžnost jen přidává čekání. Druhý start téže instance: skip logic = 0 zapisů, 0,3 s.
const SYNC_POOL = Math.max(1, Number(process.env.ZDARMA_SYNC_POOL) || 6);
// „Nespolehlivý“: za posledních FLAKY_WINDOW_MS aspoň FLAKY_MIN pokusů a FLAKY_SHARE z nich neskončilo odpovědí
// (5xx/529 přetížení, 429, visení). Jde za spolehlivé modely, ať je v čele combo model, který opravdu odpovídá.
// Změřeno 14. 11. (relace musicbee, tier Unlimited): GLM 4.7 Flash byl první v 85 ze 105 kroků s úspěšností 63 %
// (102× 529, 29× visení po 45 s, 25× 429) → na krok odpovídalo 6 různých modelů; GLM 4.5 Flash měl 95 %,
// Kilo Nemotron 96 %. OmniRoute u strategie priority relaci na úspěšném modelu nedrží (#15241), takže pořadí
// musí být správně už v combo.
const FLAKY_WINDOW_MS = 30 * 60 * 1000;
const FLAKY_MIN = 6;
const FLAKY_SHARE = 0.25;
// Pauzy modelů v OmniRoute (syncCooldowns): po 429 si OmniRoute model zablokuje na dobu z odpovědi poskytovatele
// (hlavička retry-after / x-ratelimit-reset, RetryInfo u Gemini) – hlavičková cesta nemá strop. Změřeno 20. 11. 2026:
// OVH bez klíče posílá „x-ratelimit-limit-year: 1“ a retry-after 3 543 201 s (do 1. 1.) → Qwen VL 41 dní venku; Gemini
// 3 Flash „retryDelay 37331s“ (denní kvóta). Pauzy jsou pravdivé, ale jen v paměti OmniRoute a nikde je czek-ai neviděla
// (závod zkoušel takový model každých 90 s, monitor ukazoval jen „pauza po selhání“). Model v pauze OmniRoute stejně
// odmítne (bez dotazu na poskytovatele), takže do závodu ani vidění nejde. Delší pauzu po REPROBE_MS czek-ai v OmniRoute
// smaže (DELETE /api/resilience/model-cooldowns): model se zkusí znovu a když poskytovatel dál odmítá, OmniRoute ho
// zablokuje znovu (1 rychlé 429 za REPROBE_MS) – žádný model tak není kvůli jedné odpovědi venku týdny.
const REPROBE_MS = 30 * 60 * 1000;
const PAUSE_LOG_MS = 10 * 60 * 1000; // do logu jen pauzy delší než tohle (krátké 429 jsou běžný provoz)
// Pauzy z kontroly čela tierů (probeHeads): OmniRoute zapisuje cooldown jen u některých selhání – timeout ani
// část 429 se do /api/resilience/model-cooldowns nedostane, takže syncCooldowns() pauzu nevidí a mrtvý model se
// vrátí do čela combo i do závodu. lokalní pauza = kratší než OmniRoute reprobe (REPROBE_MS), aby se model
// zkusil znovu. ZDARMA_PROBE_PAUSE=0 pauzy vypne (pro A/B měření).
const PROBE_PAUSE_MS = { 0: 5 * 60 * 1000, 429: 20 * 60 * 1000, 401: REPROBE_MS, 402: REPROBE_MS, 404: REPROBE_MS, 502: 5 * 60 * 1000, 503: 5 * 60 * 1000, 504: 5 * 60 * 1000 };
// Timeout u fast probe (10 s) nemusí mean „dead“: pomalý model (12–18 s) jen nedokázal odpovědět v stropu.
// Druhá round (slowPass, 25 s) rozhodne: odpověděl → jen odsunut na konec combo, ne pauza.
const TIMEOUT_PAUSE_MS = Number(process.env.ZDARMA_PROBE_TIMEOUT_PAUSE_MS || 60 * 1000);
const PROBE_SLOW_MS = Number(process.env.ZDARMA_PROBE_SLOW_MS || 2 * 60 * 60 * 1000);   // demotion lasts this long (smyčka, kolo 21: 30 min → 2 h)
const SLOW_CHECK_MS = Number(process.env.ZDARMA_PROBE_SLOW_EVERY_MS || 2 * 60 * 60 * 1000); // each model retried at most once per 2 h
const SLOW_SUSPECT_MS = Number(process.env.ZDARMA_PROBE_SLOW_SUSPECT_MS || 24 * 60 * 60 * 1000); // „už dokázaně pomalý“ – paměť 24 h
// Gating kontroly zdraví (smyčka Strata, kola 26–28, přeneseno do main 23. 11.): model s čerstvým dokladem, že odpovídá
// (úspěšná kontrola NEBO skutečný krok agenta za PROBE_FRESH_MS) a bez novějšího selhání se nekontroluje znovu – nejvýš
// PROBE_SKIP_MAX kol po sobě (pojistka proti tichému umlknutí). Mock (test/omni-probe-gate-safety.js, 6 kol × 6 modelů,
// 3 běhy): dotazy kontroly 41/34/39 → 18 (−54 až −56 %), detekce tiché smrti modelu čela 8,7–13,1 s → 2,6–2,9 s.
// Ve třídě šetří free limity sdílené na jedné IP (48 kol denně × 18 modelů = až 864 dotazů na jednu instalaci).
const PROBE_FRESH_MS = Number(process.env.ZDARMA_PROBE_FRESH_MS || 2 * 60 * 60 * 1000);
const PROBE_SKIP_MAX = Number(process.env.ZDARMA_PROBE_SKIP_MAX || 3);
// jen pro měření (ramena F/G gate-safety): řádky OmniRoute se stavem 0 počítat jako selhání. Výchozí VYPNUTO.
const probeFailOnZero = () => process.env.ZDARMA_PROBE_FAIL_ON_ZERO === '1';
// Volání bez chatu: test připojení a výpis modelů (OmniRoute je loguje, nejsou to požadavky Zdarmy)
// (v DB uživatele 15. 11.: 748 řádků connection-test s cestou /api/providers/test a model-sync s /api/providers/<id>/models
// z 1 400 – všechny 200, takže by „uzdravily“ poskytovatele bez kreditu a vytlačily chat z 500 posledních)
const isTestRow = (r) => /^\/api\/providers(\/|$)/.test(String(r?.path || '')) || /^(connection|model-sync$)/i.test(String(r?.model || ''));
// Klíč řádku: id z OmniRoute, jinak otisk (řádky bez id se jinak nevejdou do paměti volání)
const histKey = (r) => (r.id != null ? String(r.id) : [r.timestamp, r.provider, r.model, r.status, r.duration].join('|'));

const comboName = (tierId) => COMBO + String(tierId).replace(/[^a-zA-Z0-9_-]/g, '-');

/** Úlohy (funkce vracející Promise) s nejvýše `n` běžícími najednou; první chyba se vyhodí až na konci. */
async function runPool(tasks, n) {
  let i = 0;
  let firstErr = null;
  const worker = async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      try { await t(); } catch (e) { firstErr ||= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  if (firstErr) throw firstErr;
}

class OmniRoute {
  /**
   * @param {object} o
   * @param {string} o.dataDir  vlastní DATA_DIR (ne ~/.omniroute uživatele)
   * @param {(line: string) => void} [o.log]
   */
  constructor({ dataDir, log = () => {}, port = 0, onExit = null, dashboard = false }) {
    this.dataDir = dataDir;
    this.dashboard = dashboard; // true = celý OmniRoute i s nástěnkou (správa poskytovatelů a klíčů v jeho UI)
    this.log = log;
    this.onExit = onExit; // nečekaný konec procesu (ne přes stop()) – Zdarma ho spustí znovu
    this.wantPort = port;
    this.port = 0;
    this.proc = null;
    this.tokenValue = null;
    this.ready = false;
    this.nodeToProvider = new Map(); // id uzlu OmniRoute → id poskytovatele Zdarmy
    this.combos = new Map(); // id tierlistu / sjednoceného modelu → název combo
    this.comboModels = new Map(); // název combo → [{provider, id}] v pořadí
    this.comboMeta = new Map(); // název combo → { strategy, displayName, description, context_length, config }
    this.united = []; // poslední přehled sjednocených modelů [{ slug, title, strength, context, providers, ... }]
    this.rawModelIds = []; // syrová ID modelů poskytovatelů (z-kilo/..., nvidia/...) pro skrytí duplicit v OpenCode
    this.keyHashes = new Map(); // id připojení → otisk zapsaného klíče (aby se zbytečně nepřepisovalo)
    this.keyChangedAt = new Map(); // id poskytovatele Zdarmy → kdy se zapsal nový klíč (starší 401/402/403 pak neplatí)
    this.modelHashes = new Map(); // id poskytovatele OmniRoute → otisk zapsaných free modelů
    this.apiKey = null; // lokální API klíč OmniRoute pro oficiální plugin OpenCode
    this.baseLists = new Map(); // název combo → [{ref, provider, id}] v pořadí tierlistu (bez odsunutí)
    this.applied = new Map(); // název combo → pořadí, které je teď zapsané v OmniRoute
    this.slow = new Set(); // klíče Zdarmy (prov/model), které jsou teď pomalé → na konci combo
    this.slowInfo = new Map(); // klíč → { medianMs, bad, n } (pro zobrazení)
    this.paused = new Map(); // klíč Zdarmy (prov/model) → pauza modelu v OmniRoute { until, reason, since, reprobeAt } (syncCooldowns)
    this.probePaused = new Map(); // klíč Zdarmy → { until, status, ref } – selhání z probeHeads(), které OmniRoute nezapisuje
    this.probeSlow = new Map(); // klíč Zdarmy → { until, ms } – odpověděl až v slowPass: na konec combo, ne pauza
    this.slowChecked = new Map(); // klíč Zdarmy → kdy naposledy ho zkoušela slowPass (strop SLOW_CHECK_MS)
    this.slowSeen = new Map(); // klíč Zdarmy → kdy slowPass dokázala, že model jen odpovídá pomalu (24 h)
    this.okAt = new Map(); // klíč Zdarmy → kdy naposledy model skutečně odpověděl (kontrola nebo krok agenta)
    this.failAt = new Map(); // klíč Zdarmy → kdy naposledy skutečně selhal (ne prohraný závod)
    this.skipStreak = new Map(); // klíč Zdarmy → kolik kol po sobě ho kontrola vynechala
    this.restoredSlow = 0; // odsunutí pomalých načtená z diskové cache (restart appky)
    this.slowDirty = false;
    this.pausedSince = new Map(); // klíč → kdy czek-ai pauzu poprvé viděla
    this.reprobeMs = REPROBE_MS;
    this.lastSync = null;
    this.error = null;
  }

  get url() { return `http://127.0.0.1:${this.port}`; }

  env() {
    return {
      ...process.env,
      DATA_DIR: this.dataDir,
      PORT: String(this.port),
      OMNIROUTE_SERVER_HOST: '127.0.0.1', // jinak poslouchá na 0.0.0.0 (celá síť)
      API_HOST: '127.0.0.1',
      OMNIROUTE_BASE_URL: this.url,
      OMNIROUTE_NO_UPDATE_NOTIFIER: '1',
      OMNIROUTE_CLI_SKIP_REPO_ENV: '1', // nečíst vzorové .env z npm balíčku (obsahuje INITIAL_PASSWORD)
      OMNIROUTE_CLI_SKIP_DEFAULT_DATA_ENV: '1', // jen náš DATA_DIR
      REQUIRE_API_KEY: 'false', // jen loopback; Zdarma je jediný klient
      // Výchozí časy OmniRoute jsou pro pomalé cloudy: 80–180 s na první odpověď každého modelu, 600 s
      // ticha uprostřed. Free poskytovatel, který požadavek přijme a mlčí (NVIDIA GLM Flash 8. 11.), tak
      // držel relaci OpenCode minuty ve stavu „pracuje“ – seznam úkolů zamrzl. Krátké limity = rychle další model.
      STREAM_READINESS_TIMEOUT_MS: '30000', // Nemotron Ultra odpověděl i na 177k tokenů do 10 s
      STREAM_READINESS_MAX_TIMEOUT_MS: '45000',
      STREAM_IDLE_TIMEOUT_MS: '90000',
      // FETCH_TIMEOUT_MS = jen čekání na začátek odpovědi (hlavičky). 300 s nechalo NVIDIA DeepSeek V4.1 Flash
      // držet každý krok 110 s, než vrátil 504, a celý tierlist pak narazil na 120 s limit Zdarmy (8. 11.).
      // Tělo odpovědi (dlouhé generování) má vlastní limit, ten zůstává 300 s.
      FETCH_TIMEOUT_MS: '45000',
      FETCH_HEADERS_TIMEOUT_MS: '45000',
      FETCH_BODY_TIMEOUT_MS: '300000',
      // call_logs: výchozí 90 dní. Změřeno 15. 11.: 137 MB JSON artefaktů za den; Zdarma čte jen 24 h (hlídání
      // visení) a 2 h (rychlost), takže 7 dní stačí a disk se nepřeplní.
      CALL_LOG_RETENTION_DAYS: '7',
      OMNIROUTE_AGENT_GOAL_POLICY_ENABLED: 'false', // jinak až 600 s, když v promptu najde „/goal“
    };
  }

  async health() {
    try {
      const r = await fetch(this.url + '/api/monitoring/health', { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  }

  async start() {
    const inst = find();
    if (!inst) throw new Error('OmniRoute není nainstalovaný (npm i -g omniroute)');
    const nd = findNode();
    if (!nd) throw new Error('OmniRoute potřebuje Node.js 22.22+ nebo 24+');
    this.inst = inst;
    this.nodeBin = nd.node;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.port = (await canListen(this.wantPort)) ? this.wantPort : await freePort();
    if (this.wantPort) this.wantPort = this.port; // při případném restartu držet stejný port
    if (this.dashboard) this.preseedDashboard();
    const out = fs.openSync(path.join(this.dataDir, 'zdarma-omniroute.log'), 'a');
    // --no-open --no-tray: nástěnka běží, ale OmniRoute sám neotevírá prohlížeč ani nepřidává ikonu do lišty
    const args = [inst.bin, 'serve', ...(this.dashboard ? ['--no-open', '--no-tray'] : ['--headless']), '--port', String(this.port)];
    const child = spawn(nd.node, args, {
      cwd: this.dataDir, env: this.env(), windowsHide: true, stdio: ['ignore', out, out],
    });
    this.proc = child;
    fs.closeSync(out);
    child.on('exit', (code) => {
      if (this.proc !== child) return; // ukončeno přes stop()
      const wasReady = this.ready;
      this.ready = false;
      this.proc = null;
      this.log(`OmniRoute skončil (${code})`);
      // 8. 11.: agent v OpenCode spustil `taskkill //F //IM node.exe` a zabil i OmniRoute
      if (wasReady && this.onExit) { try { this.onExit(code); } catch {} }
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      if (!this.proc) throw new Error('OmniRoute se nespustil (viz zdarma-omniroute.log)');
      if (await this.health()) break;
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!(await this.health())) { this.stop(); throw new Error('OmniRoute nenaběhl do 90 s'); }
    this.tokenValue = this.token();
    if (!this.tokenValue) { this.stop(); throw new Error('Nepodařilo se získat přístup k OmniRoute (CLI token)'); }
    await this.api('PUT', '/api/settings', { proxyEnabled: false }).catch(() => {}); // žádné cizí proxy
    // Nástěnka na loopbacku: úvodní průvodce a přihlášení přeskočit (OmniRoute poslouchá jen na 127.0.0.1),
    // ať se uživatel dostane rovnou ke správě poskytovatelů – jako po `omniroute setup` bez hesla.
    // Vypnout rozbité no-auth poskytovatele (Cloudflare/DDG chtějí Playwright, UncloseAI zavřelo veřejnou betu).
    if (this.dashboard) {
      await this.api('POST', '/api/settings/require-login', { requireLogin: false }).catch((e) => this.log('require-login: ' + e.message));
      await this.api('PATCH', '/api/settings', {
        setupComplete: true,
        hideNoThinkVariants: true,
        blockedProviders: [
          'cloudflare-playground', 'duckduckgo-web', 'uncloseai',
          'devin-cli-agentic', 'auggie', 'zcode', 'codex-app-server', 'aihorde', 'veoaifree-web',
        ],
      }).catch((e) => this.log('nastavení nástěnky: ' + e.message));
      await this.ensureKey().catch((e) => this.log('api klíč: ' + e.message));
    }
    this.ready = true;
    this.log(`OmniRoute ${inst.version} běží na ${this.url}`);
    return this.port;
  }

  /** Před startem serveru dokončí nastavení nástěnky bez hesla pomocí oficiálního `omniroute setup --non-interactive`. */
  preseedDashboard() {
    try {
      spawnSync(this.nodeBin, [this.inst.bin, 'setup', '--non-interactive'], {
        cwd: this.dataDir, env: this.env(), windowsHide: true, stdio: 'ignore', timeout: 25000,
      });
    } catch {}
  }

  /** Získá nebo vytvoří API klíč OmniRoute pro oficiální plugin OpenCode (uložený v DATA_DIR). */
  async ensureKey() {
    if (this.apiKey) return this.apiKey;
    const keyFile = path.join(this.dataDir, 'zdarma-opencode.key');
    try {
      const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      if (saved?.key && saved?.id) {
        const list = await this.api('GET', '/api/keys');
        const keys = Array.isArray(list) ? list : (list?.keys || list?.data || []);
        if (keys.some((k) => k.id === saved.id)) {
          this.apiKey = saved.key;
          return this.apiKey;
        }
      }
    } catch {}
    const created = await this.api('POST', '/api/keys', { name: 'czek-ai (OpenCode)' });
    const key = created?.key || created?.apiKey?.key || created?.data?.key || null;
    if (key) {
      this.apiKey = key;
      try { fs.writeFileSync(keyFile, JSON.stringify({ id: created.id, key }, null, 2)); } catch {}
    }
    return this.apiKey;
  }

  /** Lokální přístupový token – spočítá ho kód OmniRoute (HMAC machine-id + sůl v DATA_DIR). Jen v paměti. */
  token() {
    const mod = 'file:///' + path.join(this.inst.root, 'bin', 'cli', 'utils', 'cliToken.mjs').replace(/\\/g, '/');
    const code = `const m = await import(${JSON.stringify(mod)}); process.stdout.write(await m.getCliToken());`;
    const r = spawnSync(this.nodeBin, ['--input-type=module', '-e', code], { env: this.env(), encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const t = String(r.stdout || '').trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  }

  /** Počítá volání API během synchronizace (jen pro souhrnný řádek v logu): počet a součet ms na METHOD cesta. */
  async api(method, p, body) {
    const t0 = Date.now();
    try {
      return await this.request(method, p, body);
    } finally {
      if (this.stat) {
        const k = method + ' ' + p.split('?')[0].split('/').map((s, i) => (i === 3 && (/\d/.test(s) || s.length >= 20) ? ':id' : s)).join('/');
        const c = this.stat.get(k) || { n: 0, ms: 0 };
        c.n++; c.ms += Date.now() - t0;
        this.stat.set(k, c);
      }
    }
  }

  async request(method, p, body) {
    const r = await fetch(this.url + p, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-omniroute-cli-token': this.tokenValue || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!r.ok) {
      const det = (data?.error?.details || []).map((d) => `${d.field}: ${d.message}`).join('; ');
      throw new Error(`OmniRoute ${method} ${p}: HTTP ${r.status} ${(data?.error?.message || text).slice(0, 200)}${det ? ' (' + det + ')' : ''}`);
    }
    return data;
  }

  stop() {
    this.ready = false;
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    // serve spouští další node (server-ws.mjs) – zabít celý strom, jinak zůstane viset
    if (WIN) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(-p.pid); } catch { try { p.kill(); } catch {} }
  }

  /**
   * Zapíše do OmniRoute poskytovatele, klíče a tierlisty. Idempotentní (uzly/combo Zdarmy se aktualizují,
   * přebytečné se smažou; cizí věci v OmniRoute se nemění).
   */
  async sync(o) {
    if (!this.ready) throw new Error('OmniRoute neběží');
    const t0 = Date.now();
    this.stat = new Map();
    try {
      return await this.syncInner(o);
    } finally {
      const all = [...this.stat.values()];
      const n = all.reduce((s, c) => s + c.n, 0);
      const top = [...this.stat.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)
        .map(([k, c]) => `${k} ${c.n}× ${(c.ms / 1000).toFixed(1)} s`).join(', ');
      const list = Number.isFinite(o?.listMs) ? `, registry.list ${(o.listMs / 1000).toFixed(1)} s` : '';
      this.log(`sync: ${n} požadavků za ${((Date.now() - t0) / 1000).toFixed(1)} s${list} (${top})`);
      this.stat = null;
    }
  }

  async syncInner({ registry, models, settings }) {
    const usableProv = new Set(models.filter((m) => m.usable).map((m) => m.provider));
    const want = new Map(); // id poskytovatele Zdarmy → { prov, ref (prefix modelu v combo), node | native }
    for (const prov of registry.providers()) {
      const id = prov.p.id;
      if (SKIP.has(id) || !prov.enabled || !usableProv.has(id)) continue;
      if (NATIVE[id] && prov.key) {
        want.set(id, { prov, ref: NATIVE[id], native: NATIVE[id] });
        continue;
      }
      let url;
      try { url = chatUrlOf(prov.p, prov.key); } catch { continue; }
      if (!url) continue;
      const { baseUrl, chatPath } = splitChatUrl(url);
      want.set(id, { prov, ref: PREFIX + id, node: { type: 'openai-compatible', name: `czek-ai · ${prov.p.name || id}`, prefix: PREFIX + id, apiType: 'chat', baseUrl, chatPath, customHeaders: extraHeaders(prov) } });
    }
    const prefixes = new Set([...want.values()].filter((w) => w.node).map((w) => w.ref));

    const nodes = (await this.api('GET', '/api/provider-nodes')).nodes || [];
    const conns = (await this.api('GET', '/api/providers')).connections || [];
    this.loadHashes();
    this.nodeToProvider.clear();
    for (const n of nodes) {
      if (!String(n.prefix || '').startsWith(PREFIX)) continue;
      if (!prefixes.has(n.prefix)) await this.api('DELETE', `/api/provider-nodes/${encodeURIComponent(n.id)}`).catch((e) => this.log(e.message));
    }
    // nativní poskytovatelé OmniRoute (připojení se jménem "zdarma"): přebytečná smazat
    for (const [zid, omniId] of Object.entries(NATIVE)) {
      if (want.has(zid)) continue;
      for (const c of conns.filter((x) => x.provider === omniId && x.name === 'zdarma')) await this.api('DELETE', `/api/providers/${encodeURIComponent(c.id)}`).catch(() => {});
    }
    for (const w of want.values()) {
      const key = w.prov.key || '';
      const provModels = models.filter((m) => m.usable && m.provider === w.prov.p.id && m.tools !== false);
      if (w.native) {
        this.nodeToProvider.set(w.native, w.prov.p.id);
        let conn = conns.find((c) => c.provider === w.native && c.name === 'zdarma');
        if (!conn) {
          conn = (await this.api('POST', '/api/providers', {
            provider: w.native, apiKey: key, name: 'zdarma', proxyEnabled: false,
            providerSpecificData: { importFreeModelsOnly: true, autoSync: true },
          })).connection;
        }
        await this.putConn(conn, key, { importFreeModelsOnly: true, autoSync: true });
        if (Array.isArray(w.prov.p.extraModels) && w.prov.p.extraModels.length) {
          await this.syncProviderModels(w.native, w.prov.p.extraModels);
        }
        continue;
      }
      const prefix = w.ref;
      let node = nodes.find((n) => n.prefix === prefix);
      const same = node && node.baseUrl === w.node.baseUrl && (node.chatPath || '') === (w.node.chatPath || '')
        && JSON.stringify(node.customHeaders || null) === JSON.stringify(w.node.customHeaders);
      if (node && !same) node = (await this.api('PUT', `/api/provider-nodes/${encodeURIComponent(node.id)}`, w.node)).node || node;
      if (!node) node = (await this.api('POST', '/api/provider-nodes', w.node)).node;
      this.nodeToProvider.set(node.id, w.prov.p.id);
      let conn = conns.find((c) => c.provider === node.id);
      if (!conn) conn = (await this.api('POST', '/api/providers', { provider: node.id, apiKey: key, name: 'zdarma', proxyEnabled: false })).connection;
      await this.putConn(conn, key);
      await this.syncProviderModels(node.id, provModels);
    }
    this.saveHashes();

    // tierlisty → combo (priority) + sjednocené modely napříč poskytovateli → combo (lkgp)
    const combosNow = (await this.api('GET', '/api/combos')).combos || [];
    // id combo (UUID) → název: dynamický katalog pluginu posílá jako model id combo, statický název (závod modelů)
    this.comboIdName = new Map(combosNow.filter((c) => c?.id && c?.name).map((c) => [c.id, c.name]));
    const defs = [...tiers.tierDefs(settings).map((d) => d.id), 'auto'];
    this.combos.clear();
    this.comboModels.clear();
    this.comboMeta.clear();
    const wanted = new Set();
    const writes = []; // zápisy combo, až po všech výpočtech (běží souběžně, viz runPool)
    // Stejné combo už v OmniRoute je (po restartu Zdarmy je paměť prázdná, combo z minula zůstává):
    // porovná se, co se zapisuje (modely v pořadí, strategie, názvy, limity, config), ne jen otisk.
    // Vrací null, když je combo stejné, jinak krátký důvod rozdílu (jde do logu synchronizace).
    const reasons = [];
    const diffInOmni = (ex, list, meta) => {
      const have = (ex.models || []).map((m) => (typeof m === 'string' ? m : m?.model));
      if (have.length !== list.length) return `počet modelů ${have.length}→${list.length}`;
      const at = have.findIndex((r, i) => r !== list[i]);
      if (at >= 0) return `pořadí od ${at + 1}. (${have[at]} → ${list[at]})`;
      // názvy poskytovatelů v závorce se řadí podle toho, který skončil první (živé skóre) → pořadí v závorce neporovnávat
      const dn = (s) => String(s || '').replace(/\(([^)]*)\)\s*$/, (_, p) => `(${p.split(', ').sort().join(', ')})`);
      if (ex.strategy !== meta.strategy) return `strategie ${ex.strategy}→${meta.strategy}`;
      if (dn(ex.displayName) !== dn(meta.displayName)) return `název „${ex.displayName}“→„${meta.displayName}“`;
      if (meta.description && ex.description !== meta.description) return 'popis';
      if (meta.context_length && ex.context_length !== meta.context_length) return `kontext ${ex.context_length}→${meta.context_length}`;
      const k = Object.entries(meta.config || {}).find(([key, v]) => JSON.stringify(ex.config?.[key]) !== JSON.stringify(v));
      return k ? `config.${k[0]}` : null;
    };
    // Dvě fáze: nejdřív se všechna combo jen zapíšou do baseLists (upsertCombo), pak se JEDNOU načte, co je mrtvé
    // a pomalé (loadSpeed), a teprve potom se pořadí porovná s OmniRoute a zapíše (placeCombo). Dřív se po každém
    // startu skládalo pořadí bez znalosti mrtvých modelů → vrátily se do combo a rebalance je o chvíli později zase
    // vyhodil (2 zápisy na combo a okno, kdy se mrtvý model zase zkoušel).
    const pending = [];
    const upsertCombo = (name, base, meta) => {
      wanted.add(name);
      this.baseLists.set(name, base);
      this.comboMeta.set(name, meta);
      pending.push([name, base, meta]);
    };
    const placeCombo = (name, base, meta) => {
      const arranged = this.arrange(base);
      const list = arranged.map((x) => x.ref);
      const sig = JSON.stringify({ list, strategy: meta.strategy, displayName: meta.displayName });
      this.comboModels.set(name, arranged.map(({ provider, id }) => ({ provider, id })));
      const ex = combosNow.find((c) => c.name === name);
      const why = ex ? diffInOmni(ex, list, meta) : 'nové';
      if (ex && (this.applied.get(name) === sig || !why)) { this.applied.set(name, sig); return; }
      reasons.push(`${name}: ${why}`);
      writes.push(async () => {
        const body = {
          name,
          ...(meta.displayName ? { displayName: meta.displayName } : {}),
          ...(meta.description ? { description: meta.description } : {}),
          ...(meta.context_length ? { context_length: meta.context_length } : {}),
          strategy: meta.strategy,
          enabled: true,
          models: list,
          config: meta.config,
        };
        if (ex) await this.api('PUT', `/api/combos/${encodeURIComponent(ex.id)}`, body);
        else await this.api('POST', '/api/combos', body);
        this.applied.set(name, sig);
      });
    };

    for (const tid of defs) {
      const order = tid === 'auto' ? registry.autoOrder(models) : tiers.order(tid, models, settings, registry);
      const picked = [];
      const seenRef = new Set();
      for (const m of order) {
        const w = want.get(m.provider);
        if (!w || m.tools === false) continue;
        const ref = `${w.ref}/${m.id}`;
        if (seenRef.has(ref)) continue;
        seenRef.add(ref);
        picked.push({ ref, provider: m.provider, id: m.id });
      }
      const base = picked.slice(0, 60);
      if (!base.length) continue;
      const name = comboName(tid);
      this.combos.set(tid, name);
      const tDef = tiers.tierDefs(settings).find((d) => d.id === tid);
      const displayName = tDef ? `Tier · ${tDef.name} (${base.length} modelů)` : `Tier · Auto (${base.length} modelů)`;
      upsertCombo(name, base, {
        strategy: 'priority',
        displayName,
        description: 'zdarma-tier',
        context_length: tDef ? tiers.tierContext(base.map((x) => `${x.provider}/${x.id}`), models) : 96000,
        config: { maxRetries: 0 },
      });
    }

    // Sjednocené modely: každý unikátní model napříč všemi poskytovateli jako jedno combo se strategií lkgp.
    // lkgp drží jednoho poskytovatele (Last Known Good Provider) bez přepínání, dokud nedojdou kredity/limit,
    // a teprve pak přepne na dalšího poskytovatele téhož modelu (a připne se na něj).
    const unitedList = tiers.uniteModels(models, settings, registry);
    const syncedUnited = [];
    const rawIds = new Set();
    for (const m of models) {
      const w = want.get(m.provider);
      if (w && m.usable) rawIds.add(`${w.ref}/${m.id}`);
    }
    this.rawModelIds = [...rawIds];

    for (const u of unitedList) {
      if (!u.usable.length) continue;
      const picked = [];
      const seenRef = new Set();
      for (const m of u.usable) {
        const w = want.get(m.provider);
        if (!w || m.tools === false) continue;
        const ref = `${w.ref}/${m.id}`;
        if (seenRef.has(ref)) continue;
        seenRef.add(ref);
        picked.push({ ref, provider: m.provider, id: m.id, providerName: w.prov.p.name || m.provider });
      }
      if (!picked.length) continue;
      const name = u.slug;
      if (wanted.has(name)) continue;
      this.combos.set(name, name);
      this.combos.set('united:' + name, name);
      const provNames = picked.map((p) => p.providerName).join(', ');
      const displayName = `${u.title} · ${picked.length}× (${provNames})`.slice(0, 180);
      upsertCombo(name, picked, {
        strategy: 'lkgp',
        displayName,
        description: 'zdarma-united',
        context_length: u.context,
        config: { maxRetries: 0, failoverBeforeRetry: true },
      });
      syncedUnited.push({ ...u, combo: name, displayName });
    }
    this.united = syncedUnited;
    try { await this.loadSpeed(); } catch (e) { this.log('rychlost modelů před zápisem combo nejde načíst: ' + e.message); }
    // Sjednocený model, jehož všichni poskytovatelé jsou mrtví (účet bez kreditu, model neexistuje, trvale visí), se do
    // OmniRoute nezapíše a z nabídky zmizí (existující combo smaže úklid níž). 16. 11. uživatel vybral
    // „muse-spark-open-816b“ (jen HuggingFace bez kreditu) a dostal hned chybu 402. Tierlisty zůstávají vždy.
    const deadX = (x) => (this.deadProviders || new Set()).has(x.provider) || (this.deadModels || new Set()).has(`${x.provider}/${x.id}`);
    const hiddenDead = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      const [name, base, meta] = pending[i];
      if (meta.description !== 'zdarma-united' || !base.length || !base.every(deadX)) continue;
      pending.splice(i, 1);
      wanted.delete(name); this.baseLists.delete(name); this.comboMeta.delete(name); this.combos.delete(name); this.combos.delete('united:' + name);
      hiddenDead.push(name);
    }
    if (hiddenDead.length) {
      this.united = this.united.filter((u) => !hiddenDead.includes(u.combo));
      this.log(`OmniRoute: sjednocené modely bez živého poskytovatele skryté (${hiddenDead.length}): ${hiddenDead.slice(0, 12).join(', ')}`);
    }
    for (const p of pending) placeCombo(...p);
    await runPool(writes, SYNC_POOL);
    const out = [...(this.deadProviders || []), ...(this.deadModels || [])];
    if (out.length || this.slow.size || this.flaky?.size) this.log(`OmniRoute: při synchronizaci mimo combo (mrtvé): ${out.join(', ') || 'žádné'}; nespolehlivé: ${[...(this.flaky || [])].join(', ') || 'žádné'}; na konci (pomalé): ${[...this.slow].join(', ') || 'žádné'}; zapsáno combo: ${writes.length}`);
    if (reasons.length) this.log(`OmniRoute: zapsaná combo (${reasons.length}), důvod: ${reasons.slice(0, 8).join(' | ')}${reasons.length > 8 ? ' | …' : ''}`);

    // přebytečná combo smazat souběžně (po skrytí mrtvých sjednocených modelů jich je při 1. startu ~120: po jednom 44 s)
    const orphans = combosNow.filter((c) => (String(c.name).startsWith(COMBO) || c.description === 'zdarma-united' || c.description === 'zdarma-tier') && !wanted.has(c.name));
    await runPool(orphans.map((c) => () => this.api('DELETE', `/api/combos/${encodeURIComponent(c.id)}`).catch(() => {})), 6);
    for (const n of [...this.baseLists.keys()]) if (!wanted.has(n)) { this.baseLists.delete(n); this.applied.delete(n); this.comboMeta.delete(n); }
    this.lastSync = { at: Date.now(), providers: want.size, combos: this.combos.size, united: syncedUnited.length };
    this.log(`OmniRoute: ${want.size} poskytovatelů, ${syncedUnited.length} sjednocených modelů`);
    return this.lastSync;
  }

  /**
   * Klíč a stav připojení zapsat jen při změně. OmniRoute po každém zápisu připojení testuje (požadavek
   * na poskytovatele) a klíč zpět nevydá → pamatuje se otisk toho, co Zdarma zapsala (jen v paměti).
   */
  async putConn(conn, key, providerSpecificData) {
    const hash = require('crypto').createHash('sha256').update(String(key)).digest('hex');
    if (this.keyHashes.get(conn.id) === hash && conn.isActive !== false) return;
    await this.api('PUT', `/api/providers/${encodeURIComponent(conn.id)}`, {
      apiKey: key, isActive: true, proxyEnabled: false,
      ...(providerSpecificData ? { providerSpecificData } : {}),
    });
    this.keyHashes.set(conn.id, hash);
    this.keyHashesDirty = true;
    // nový klíč (dobitý kredit, nový účet): dřívější 401/402/403 tohoto poskytovatele už neplatí
    const zid = this.providerOf(conn.provider);
    if (zid) this.keyChangedAt.set(zid, Date.now());
  }

  /**
   * Otisky zapsaných klíčů přežijí restart appky (soubor vedle dat OmniRoute; jen SHA-256, klíč z něj nejde získat).
   * Bez toho se při každém startu přepsalo všech 12 připojení a OmniRoute každé otestoval dotazem na poskytovatele
   * (změřeno 15. 11.: 12× PUT, 5 s, a 748 řádků connection-test v jeho logu za 5 dní).
   */
  hashFile() { return this.dataDir && path.isAbsolute(this.dataDir) && fs.existsSync(this.dataDir) ? path.join(this.dataDir, 'zdarma-sync.json') : null; }

  loadHashes() {
    if (this.hashesLoaded) return;
    this.hashesLoaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(this.hashFile(), 'utf8'));
      for (const [id, h] of Object.entries(j.keyHashes || {})) if (!this.keyHashes.has(id) && /^[0-9a-f]{64}$/.test(h)) this.keyHashes.set(id, h);
      this.hangMemo = new Map(Object.entries(j.hangs || {}).filter(([, m]) => m && Number.isFinite(m.n) && Number.isFinite(m.last)));
      // pauzy a odsunutí z kontroly zdraví přežijí restart appky (jinak by první kroky po restartu zkoušely modely,
      // které kontrola před chvílí našla mrtvé, než doběhne nová kontrola)
      const now = Date.now();
      for (const [k, v] of Object.entries(j.probePaused || {})) if (v && v.until > now && !this.probePaused.has(k)) this.probePaused.set(k, v);
      for (const [k, v] of Object.entries({ ...(j.slow || {}), ...(j.probeSlow || {}) })) if (v && v.until > now && !this.probeSlow.has(k)) { this.probeSlow.set(k, { ...v, restored: true }); this.restoredSlow++; }
      for (const [k, t] of Object.entries(j.slowSeen || {})) if (Number.isFinite(t) && now - t < SLOW_SUSPECT_MS) this.slowSeen.set(k, t);
      if (this.restoredSlow) this.log(`kontrola čela: ${this.restoredSlow} pomalých modelů odsunuto z minulého běhu (zdarma-sync.json) – znovu se zkouší až za ${Math.round(SLOW_CHECK_MS / 3600000)} h`);
    } catch {}
  }

  saveHashes(liveIds) {
    if (!this.keyHashesDirty && !this.slowDirty && !liveIds) return;
    const f = this.hashFile();
    if (!f) return;
    if (liveIds) for (const id of [...this.keyHashes.keys()]) if (!liveIds.has(id)) this.keyHashes.delete(id);
    const now = Date.now();
    const live = (m) => Object.fromEntries([...(m || [])].filter(([, v]) => v && v.until > now));
    try { fs.writeFileSync(f, JSON.stringify({ keyHashes: Object.fromEntries(this.keyHashes), hangs: Object.fromEntries(this.hangMemo || []), probePaused: live(this.probePaused), probeSlow: live(this.probeSlow), slowSeen: Object.fromEntries(this.slowSeen || []) })); this.keyHashesDirty = false; this.slowDirty = false; } catch {}
  }

  /** Zapíše ověřené free modely k poskytovateli v OmniRoute, aby je jeho vlastní směrování auto/coding i combo viděly. */
  async syncProviderModels(omniProviderId, provModels) {
    if (!this.dashboard || !Array.isArray(provModels) || !provModels.length) return;
    const sig = provModels.map((m) => m.id).sort().join('\n');
    if (this.modelHashes.get(omniProviderId) === sig) return;
    // Modely, které OmniRoute už má se stejnými limity, se nepošlou znovu (po restartu je paměť prázdná)
    const have = new Map();
    try {
      const r = await this.api('GET', `/api/provider-models?provider=${encodeURIComponent(omniProviderId)}`);
      for (const m of r?.models || []) have.set(m.id, m);
    } catch {}
    for (const m of provModels.slice(0, 60)) {
      const ctx = m.context || tiers.knownContext(m) || 128000;
      const out = m.maxLen || Math.min(8192, Math.max(1024, Math.floor(ctx / 4)));
      const old = have.get(m.id);
      if (old && old.inputTokenLimit === ctx && old.outputTokenLimit === out) continue;
      await this.api('POST', '/api/provider-models', {
        provider: omniProviderId, modelId: m.id, modelName: m.name || m.id, isFree: true,
        max_input_tokens: ctx, max_output_tokens: out,
      }).catch(() => {});
    }
    this.modelHashes.set(omniProviderId, sig);
  }

  /** Pořadí combo: rychlé v pořadí tierlistu, pomalé za nimi (taky v pořadí tierlistu). */
  arrange(base) {
    const dead = (x) => (this.deadProviders || new Set()).has(x.provider) || (this.deadModels || new Set()).has(`${x.provider}/${x.id}`);
    const isSlow = (x) => this.isSlow(x);
    const limited = (x) => (this.limited || new Set()).has(`${x.provider}/${x.id}`) && !isSlow(x) && !dead(x);
    // nespolehlivé lokálně, nebo podle veřejného tierlistu u mnoha instalací (src/publicTier.js, „dav jen shazuje“)
    const flaky = (x) => ((this.flaky || new Set()).has(`${x.provider}/${x.id}`) || (this.crowd || new Set()).has(`${x.provider}/${x.id}`)) && !isSlow(x) && !dead(x) && !limited(x);
    const ok = (x) => !isSlow(x) && !dead(x) && !limited(x) && !flaky(x);
    // pořadí: fungující → vyčerpaný limit (429) → pomalé. Mrtvé (účet bez kreditu/přístupu, model neexistuje,
    // 2× po sobě visel do limitu 45 s) VEN z combo: na konci se pořád zkoušely, když všechno před nimi selhalo.
    // Živě 13.–14. 11.: NVIDIA DeepSeek V4.1 Flash 14× po 45 s (499), pokaždé když GLM vrátil 529/429 → kroky
    // 100–190 s. Uzdraví se po DEAD_WINDOW_MS (6 h). Kdyby byly mrtvé všechny, zůstanou (tier nesmí být prázdný).
    const alive = [...base.filter(ok), ...base.filter(flaky), ...base.filter(limited), ...base.filter((x) => isSlow(x) && !dead(x))];
    return alive.length ? alive : base.filter(dead);
  }

  /**
   * Mrtví poskytovatelé a modely z posledních DEAD_WINDOW_MS: 401/402/403 = celý účet (HF „402 kredity“
   * platí pro všechny jeho modely, ale OmniRoute zaloguje jen první zkoušený), 404 = ten jeden model.
   * Stačí jedna taková odpověď; uzdraví se, až model/poskytovatel znovu odpoví 2xx.
   */
  deadFrom(rows, now = Date.now(), memo = null) {
    const deadProviders = new Set();
    const deadModels = new Set();
    const hangs = new Map(); // klíč → { n: po sobě jdoucích „nezačal odpovídat“ (504/408/499/0 po ≥ 30 s), last, seen }
    // zapamatovaná řada z dřívějška; řádky do času „seen“ už v ní započítané jsou
    if (memo) for (const [k, m] of memo) if (m && m.n >= 2 && now - m.last <= HANG_MEMO_MS) hangs.set(k, { n: m.n, last: m.last, seen: m.last });
    const sorted = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const r of sorted) {
      const t = Date.parse(r?.timestamp);
      if (!Number.isFinite(t) || now - t > HANG_MEMO_MS) continue;
      const prov = this.providerOf(r?.provider) || this.providerOfModel(r?.model);
      if (!prov) continue;
      const key = `${prov}/${r.model || ''}`;
      const st = Number(r.status) || 0;
      if (st >= 200 && st < 300) {
        deadModels.delete(this.matchKey(key)); deadProviders.delete(prov);
        if (!(hangs.get(key)?.seen >= t)) hangs.delete(key); // úspěch starší než zapamatovaná řada ji neruší
        continue;
      }
      const recent = now - t <= (st === 402 ? CREDIT_WINDOW_MS : DEAD_WINDOW_MS);
      if ([401, 402, 403].includes(st)) { if (recent && !(t < (this.keyChangedAt?.get(prov) || 0))) deadProviders.add(prov); }
      else if (st === 404) { if (recent) deadModels.add(this.matchKey(key)); }
      // nezačal odpovídat (NVIDIA DeepSeek V4.1 Flash: 504 po 110 s celé odpoledne; od FETCH_TIMEOUT_MS 45 s ho
      // OmniRoute loguje jako 499 „Request aborted“). Počítá se řada bez úspěchu mezi: přetížený model, který
      // mezitím odpovídá (GLM 4.7 Flash visel 13× za 2 dny, 263× odpověděl), se úspěchem vynuluje.
      else if ([0, 408, 499, 504, 524].includes(st) && (Number(r.duration) || 0) >= 30000) {
        const h = hangs.get(key) || { n: 0, last: 0 };
        if (!(h.seen >= t)) hangs.set(key, { n: h.n + 1, last: Math.max(h.last, t), seen: h.seen });
      }
    }
    for (const [key, h] of hangs) if (h.n >= 2 && now - h.last <= hangDeadMs(h.n)) deadModels.add(this.matchKey(key));
    return { deadProviders, deadModels, hangs };
  }

  /**
   * Rychlost modelů z metadat OmniRoute (call_logs přes jeho API): jen model, poskytovatel, trvání,
   * stav a čas – obsah požadavků (requestSummary, error) se nečte ani neukládá.
   * Pomalý = medián úspěšných pokusů > SLOW_MS, nebo aspoň 2 pokusy skončily časovým limitem / 5xx /
   * přerušením a je to aspoň polovina jeho pokusů (za posledních SPEED_WINDOW_MS).
   */
  async speedStats(now = Date.now()) {
    // Bez excludeTests: OmniRoute 3.8.x s excludeTests=1 vrací vždy prázdný seznam (změřeno 15. 11. na replice:
    // 0 řádků, 500 bez parametru). Testovací řádky se vyřadí tady. Řádky Zdarmy jsou v 500 posledních volaních jen
    // za pár hodin, proto se držej v callHist (24 h).
    // první dotaz po startu sahá hlouběji (2000 volání): řada visení se tak pozná i po delší pauze a hned se zapíše
    // do paměti na disku; pak stačí 500 posledních
    const rows = await this.api('GET', `/api/usage/call-logs?limit=${this.speedCalls ? 500 : 2000}`);
    this.speedCalls = (this.speedCalls || 0) + 1;
    const list = Array.isArray(rows) ? rows : [];
    this.callHist ||= new Map();
    for (const r of list) {
      if (!r || isTestRow(r) || !Number.isFinite(Date.parse(r.timestamp))) continue;
      const k = histKey(r);
      this.callHist.set(k, { id: k, timestamp: r.timestamp, provider: r.provider, model: r.model, status: r.status, duration: r.duration });
    }
    for (const [id, r] of this.callHist) if (!(now - Date.parse(r.timestamp) <= HANG_HISTORY_MS)) this.callHist.delete(id);
    const hist = [...this.callHist.values()];
    this.loadHashes();
    // řádky starší než 24 h z aktuálního dotazu (první dotaz sahá hlouběji) jdou jen do počítání řad visení
    const older = list.filter((r) => r && !isTestRow(r) && Number.isFinite(Date.parse(r.timestamp)) && !this.callHist.has(histKey(r)));
    const dd = this.deadFrom(older.length ? [...older, ...hist] : hist, now, this.hangMemo);
    this.deadProviders = dd.deadProviders;
    this.deadModels = dd.deadModels;
    // řady visení (≥ 2) na disk; úspěch nebo stáří je smaže
    const memoNow = new Map([...dd.hangs].filter(([, h]) => h.n >= 2).map(([k, h]) => [k, { n: h.n, last: h.last }]));
    if (JSON.stringify([...memoNow]) !== JSON.stringify([...(this.hangMemo || [])])) { this.hangMemo = memoNow; this.keyHashesDirty = true; this.saveHashes(); }
    const per = new Map();
    const recent = new Map(); // klíč → { n, fail } za FLAKY_WINDOW_MS
    // diagnostika řádku rebalance: kolik řádků a které poskytovatele nešlo spárovat s uzlem/nativním poskytovatelem
    const diag = { fetched: list.length, tests: list.filter(isTestRow).length, window: 0, byProvider: {}, skipped: {} };
    for (const r of hist) {
      const t = Date.parse(r.timestamp);
      if (!Number.isFinite(t) || now - t > SPEED_WINDOW_MS) continue;
      if (!r.model) continue; // řádek celého combo
      diag.window++;
      diag.byProvider[r.provider] = (diag.byProvider[r.provider] || 0) + 1;
      const up = this.providerOf(r.provider);
      const prov = up || this.providerOfModel(r.model);
      if (!prov) { diag.skipped[r.provider] = (diag.skipped[r.provider] || 0) + 1; continue; } // cizí poskytovatel
      if (!up) diag.recovered = (diag.recovered || 0) + 1; // doklad spárovaný podle jména modelu
      const key = `${prov}/${r.model}`;
      const s = per.get(key) || { n: 0, bad: 0, n429: 0, okMs: [] };
      const status = Number(r.status) || 0;
      // 499 do 30 s = dotaz zrušil klient: prohraný závod modelů (src/race.js) nebo uživatel zastavil – model za to
      // nemůže. Visení (499 po ≥ 30 s, limit OmniRoute) se počítá dál.
      if (status === 499 && (Number(r.duration) || 0) < 30000) continue;
      // stav 0 = rozpracovaný nebo zdvojený řádek OmniRoute („No HTTP response observed“), visení má vlastní 499/504;
      // 400/413/422 je chyba konkrétního dotazu (moc velký, špatné pole), ne modelu
      if (now - t <= FLAKY_WINDOW_MS && status !== 0 && ![400, 413, 422].includes(status)) {
        // podle klíče v combo: upstream vrací stejný model i bez přípony („…-a55b“ a „…-a55b:free“ u Kilo)
        const fk = this.matchKey(key);
        const f = recent.get(fk) || { n: 0, fail: 0 };
        f.n++;
        if (!(status >= 200 && status < 300)) f.fail++;
        recent.set(fk, f);
      }
      // doklad pro gating kontroly zdraví: úspěšný skutečný krok agenta = model odpovídá (kontrola ho pak nezkouší)
      if (status >= 200 && status < 300) { this.okAt.set(this.matchKey(key), Math.max(this.okAt.get(this.matchKey(key)) || 0, t)); if (!up) diag.okPairs = (diag.okPairs || 0) + 1; }
      // 0 = „No HTTP response observed“ (prohraný závod, zrušený dotaz) → selhání jen s měřicím přepínačem
      else if (status === 499 || status >= 500 || [401, 402, 403, 404].includes(status) || (probeFailOnZero() && status === 0)) { this.failAt.set(this.matchKey(key), Math.max(this.failAt.get(this.matchKey(key)) || 0, t)); if (!up) diag.failPairs = (diag.failPairs || 0) + 1; }
      s.n++;
      if (status === 429) s.n429++;
      if (status >= 200 && status < 300) s.okMs.push(Number(r.duration) || 0);
      // 401/402/403/404 = trvale nedostupný pro tenhle účet (NVIDIA Kimi „404 for account“, HF „402 kredity“):
      // jinak by se zkoušel na začátku každého požadavku. 429 je dočasný limit, ten se nepočítá.
      else if (status === 0 || status === 499 || status >= 500 || [401, 402, 403, 404].includes(status)) s.bad++;
      per.set(key, s);
    }
    const slow = new Map();
    // Vyčerpaný limit: aspoň LIMITED_MIN pokusů a LIMITED_SHARE z nich 429. Živě 8. 11. na Mid:
    // Codestral 45/53 × 429, Gemma 35/35 → každý krok agenta je zkoušel první a když Codestral
    // výjimečně prošel, model se uprostřed úkolu měnil (Kilo → Codestral → OVH → Kilo…).
    this.limited = new Set();
    for (const [key, s] of per) {
      const sorted = s.okMs.slice().sort((a, b) => a - b);
      const medianMs = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
      const slowByMedian = s.okMs.length >= SLOW_MIN_SAMPLES && medianMs > SLOW_MS;
      if (slowByMedian || (s.bad >= 2 && s.bad / s.n >= 0.5)) slow.set(key, { medianMs, bad: s.bad, n: s.n });
      else if (s.n >= LIMITED_MIN && s.n429 / s.n >= LIMITED_SHARE) this.limited.add(this.matchKey(key));
    }
    this.flaky = new Set();
    this.flakyInfo = new Map();
    const slowKeys = new Set([...slow.keys()].map((x) => this.matchKey(x)));
    for (const [k, f] of recent) {
      // jen selhání a žádná odpověď → odsunout hned po prvním (model, o kterém za půl hodiny víme jen to, že
      // neodpověděl, nemá být v čele; v čele zůstanou ty s odpovědí nebo zatím nezkoušené)
      const onlyFails = f.fail >= 1 && f.fail === f.n;
      if (!(onlyFails || (f.n >= FLAKY_MIN && f.fail / f.n >= FLAKY_SHARE)) || slowKeys.has(k) || this.limited.has(k)) continue;
      this.flaky.add(k);
      this.flakyInfo.set(k, f);
    }
    this.speedDiag = diag;
    return slow;
  }

  /**
   * Zdarma id poskytovatele pro řádek OmniRoute (uzel nebo nativní jméno). Když mapa uzlů řádek nezná
   * (sync se nedokončil, nativní poskytovatel ještě nezapsán), spadne se na NATIVE nebo na jméno z combo;
   * jinak null (počítá se do „nespárované“, nikdy se tiše nevynechá).
   */
  providerOf(node) {
    if (!node) return null;
    const m = this.nodeToProvider.get(node);
    if (m) return m;
    for (const [zid, omniId] of Object.entries(NATIVE)) if (omniId === node) return zid;
    if (Object.prototype.hasOwnProperty.call(NATIVE, node)) return node;
    for (const base of this.baseLists.values()) if (base.some((x) => x.provider === node)) return node;
    return null;
  }

  /** Klíč Zdarmy z řádku měření → klíč v combo (upstream může vracet model bez prefixu poskytovatele). */
  /**
   * Poskytovatel podle jména modelu, když OmniRoute hlásí uzel, který mapa uzlů nezná (sync nedokončen, uzel přidaný
   * ručně). Bez toho se řádky skutečných kroků agenta zahodí a gating nevidí, že model selhal. Stejné id u víc
   * poskytovatelů → null (nehádat). Smyčka Strata, kolo 27.
   */
  providerOfModel(model) {
    if (!model || process.env.ZDARMA_MODEL_FALLBACK === '0') return null;
    const m = String(model).toLowerCase();
    const strip = (x) => x.replace(/:[a-z0-9-]+$/, '');
    const bare = strip(m);
    const hits = new Set();
    for (const base of this.baseLists.values()) {
      for (const x of base) {
        const id = String(x.id).toLowerCase();
        if (id === m || strip(id) === bare || id.endsWith('/' + m) || strip(id).endsWith('/' + bare)) hits.add(x.provider);
      }
    }
    return hits.size === 1 ? [...hits][0] : null;
  }

  matchKey(key) {
    const [prov, ...rest] = key.split('/');
    const model = rest.join('/').toLowerCase();
    for (const base of this.baseLists.values()) {
      const hit = base.find((x) => x.provider === prov && (x.id.toLowerCase() === model || x.id.toLowerCase().endsWith('/' + model)));
      if (hit) return `${hit.provider}/${hit.id}`;
    }
    // druhý pokus bez přípony („…-a55b:free“ v combo, upstream v odpovědi vrací „…-a55b“ – Kilo, OpenRouter)
    const strip = (s) => s.replace(/:[a-z0-9-]+$/, '');
    const bare = strip(model);
    for (const base of this.baseLists.values()) {
      const hit = base.find((x) => { const id = strip(x.id.toLowerCase()); return x.provider === prov && (id === bare || id.endsWith('/' + bare)); });
      if (hit) return `${hit.provider}/${hit.id}`;
    }
    return key;
  }

  /**
   * Pomalé modely na konec combo, ostatní v pořadí tierlistu. Do OmniRoute se zapisuje jen při změně
   * pořadí. Vrací { slow: [klíče], changed: počet přepsaných combo }.
   */
  /**
   * Stav klíčů (služba kontroly klíčů): OmniRoute si u každého připojení drží výsledek testu, poslední chybu
   * a pauzu po limitu. S test=true každé připojení s klíčem znovu ověří (jeho /api/providers/:id/test,
   * levný dotaz bez generování) a přidá využití za 24 h z call_logs. Klíče samotné se nečtou ani nevrací.
   * @returns {Promise<Array<{provider:string,name:string,ok:boolean,status:string,error:string,lastTested:string|null,limitedUntil:string|null,calls24h:number,ok24h:number,limited24h:number}>>}
   */
  async keyHealth({ test = false } = {}) {
    if (!this.ready) return [];
    let conns = (await this.api('GET', '/api/providers?limit=500')).connections || [];
    conns = conns.filter((c) => c.authType !== 'oauth' && this.nodeToProvider.has(c.provider));
    if (test) {
      for (const c of conns) await this.api('POST', '/api/providers/' + encodeURIComponent(c.id) + '/test', {}).catch(() => {});
      conns = ((await this.api('GET', '/api/providers?limit=500')).connections || []).filter((c) => c.authType !== 'oauth' && this.nodeToProvider.has(c.provider));
    }
    const use = new Map();
    try {
      const rows = await this.api('GET', '/api/usage/call-logs?limit=1000');
      const since = Date.now() - 24 * 3600e3;
      for (const r of Array.isArray(rows) ? rows : []) {
        if (isTestRow(r)) continue;
        const id = this.providerOf(r?.provider);
        if (!id || !(Date.parse(r.timestamp) > since)) continue;
        const u = use.get(id) || { calls: 0, ok: 0, limited: 0 };
        const s = Number(r.status) || 0;
        u.calls++; if (s >= 200 && s < 300) u.ok++; if (s === 429) u.limited++;
        use.set(id, u);
      }
    } catch {}
    return conns.map((c) => {
      const id = this.nodeToProvider.get(c.provider);
      const u = use.get(id) || { calls: 0, ok: 0, limited: 0 };
      const st = String(c.testStatus || c.test_status || '');
      const err = String(c.lastError || c.last_error || '').slice(0, 200);
      const bad = /unauthor|invalid|expired|forbidden|error|fail/i.test(st) || /\b(401|403)\b|invalid api key|unauthorized/i.test(err);
      return { provider: id, name: c.name || '', ok: !bad, status: st, error: bad ? err || st : '', lastTested: c.lastTested || c.last_tested || null, limitedUntil: c.rateLimitedUntil || c.rate_limited_until || null, calls24h: u.calls, ok24h: u.ok, limited24h: u.limited };
    });
  }

  /** Načte měření (speedStats) a nastaví this.slow / deadProviders / deadModels / limited pro arrange(). */
  async loadSpeed() {
    const measured = await this.speedStats();
    this.slow = new Set();
    this.slowInfo = new Map();
    for (const [k, info] of measured) { const key = this.matchKey(k); this.slow.add(key); this.slowInfo.set(key, info); }
  }

  async rebalance() {
    if (!this.ready || !this.baseLists.size) return { slow: [...this.slow], changed: 0 };
    await this.loadSpeed();
    let combosNow = null;
    let changed = 0;
    for (const [name, base] of this.baseLists) {
      const arranged = this.arrange(base);
      const list = arranged.map((x) => x.ref);
      const meta = this.comboMeta.get(name) || { strategy: 'priority', config: { maxRetries: 0 } };
      const sig = this.applied.get(name)?.startsWith('{')
        ? JSON.stringify({ list, strategy: meta.strategy, displayName: meta.displayName })
        : list.join('\n');
      if (sig === this.applied.get(name)) continue;
      combosNow ||= (await this.api('GET', '/api/combos')).combos || [];
      const ex = combosNow.find((c) => c.name === name);
      if (!ex) continue;
      await this.api('PUT', `/api/combos/${encodeURIComponent(ex.id)}`, {
        name,
        ...(meta.displayName ? { displayName: meta.displayName } : {}),
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.context_length ? { context_length: meta.context_length } : {}),
        strategy: meta.strategy,
        enabled: true,
        models: list,
        config: meta.config,
      });
      this.applied.set(name, sig);
      this.comboModels.set(name, arranged.map(({ provider, id }) => ({ provider, id })));
      changed++;
    }
    // nespárované řádky (poskytovatel bez uzlu a bez nativního jména) jen když nějaké jsou – řádek zůstane krátký
    const sk = Object.entries(this.speedDiag?.skipped || {});
    const skipped = sk.length ? `, řádků ${this.speedDiag.fetched}, nespárované: ${sk.map(([k, v]) => `${k} ${v}`).join(', ')}` : '';
    if (changed) this.log(`OmniRoute: nespolehlivé za spolehlivé (${[...(this.flaky || [])].map((k) => `${k} ${this.flakyInfo.get(k).fail}/${this.flakyInfo.get(k).n}`).join(', ') || 'žádné'}), pomalé na konec (${[...this.slow].join(', ') || 'žádné'}), limit 429 (${[...(this.limited || [])].join(', ') || 'žádné'}), mrtvé (${[...(this.deadProviders || [])].join(', ')} ${[...(this.deadModels || [])].join(', ')}), přepsáno combo: ${changed}${skipped}`);
    return { slow: [...this.slow], changed };
  }

  /** Které combo obslouží požadovaný model Zdarmy (tierlist / auto), jinak null. */
  comboFor(requested) { return this.ready ? this.combos.get(requested) || null : null; }

  /** Hlavičky odpovědi OmniRoute → klíč modelu Zdarmy (prov/model). Streamy s nástroji je nemají → null. */
  modelKeyFrom(headers, combo) {
    const node = headers.get('x-omniroute-provider');
    const model = headers.get('x-omniroute-model');
    const prov = node && this.nodeToProvider.get(node);
    if (prov && model) return `${prov}/${model}`;
    return model ? this.keyForModel(combo, model) : null;
  }

  /**
   * Závodníci pro závod modelů (src/race.js): prvních `n` modelů combo v aktuálním pořadí (mrtvé venku, nespolehlivé,
   * vyčerpané a pomalé vzadu), každý od jiného poskytovatele – stejný poskytovatel by si limit dělil (Z.ai dovolí jen
   * 1 souběžný dotaz) a padl by se stejnou chybou. Přednost mají i různé modely: bench 20. 11. – všichni tři byli
   * Nemotron 3 Ultra (Kilo, OpenRouter, NVIDIA) a když byl přetížený sám model, čekalo se 15,9 s.
   * Pořadí výběru: spolehlivý a nový model → spolehlivý → nespolehlivý a nový model → ostatní.
   * Vrací řetězce modelů pro OmniRoute (jako v combo); [] = nezávodit.
   */
  raceCandidates(comboName, n, racers = n) {
    const base = this.baseLists.get(comboName) || this.baseLists.get(this.comboIdName?.get(comboName));
    if (!base || !base.length || !(n >= 2)) return [];
    // model v pauze OmniRoute by OmniRoute odmítl hned (429 model_cooldown) – ani jako náhradník (syncCooldowns)
    const arranged = this.arrange(base).filter((x) => !this.isPaused(x));
    const bad = (x) => (this.flaky || new Set()).has(`${x.provider}/${x.id}`) || (this.crowd || new Set()).has(`${x.provider}/${x.id}`) || (this.limited || new Set()).has(`${x.provider}/${x.id}`) || this.isSlow(x);
    // stejný model u různých poskytovatelů: „nvidia/nemotron-3-ultra-550b-a55b:free“ = „nemotron-3-ultra-550b-a55b“
    const fam = (x) => String(x.id).toLowerCase().split('/').pop().replace(/:[a-z-]+$/, '');
    const out = []; const provs = new Set(); const fams = new Set();
    const pick = (list, max, reliableOnly = false) => {
      for (const [reliable, newModel] of reliableOnly ? [[true, true], [true, false]] : [[true, true], [true, false], [false, true], [false, false]]) {
        for (const x of list) {
          if (out.length >= max) return;
          if (provs.has(x.provider) || bad(x) === reliable || (newModel && fams.has(fam(x)))) continue;
          provs.add(x.provider); fams.add(fam(x)); out.push(x.ref);
        }
      }
    };
    // Závodníci (první RACE_N) jen ze špičky tieru: vítězí ten, kdo ZAČNE první, a model hlouběji v tieru je slabší
    // nebo pomalý v generování. Bench 20. 11. (4. běh): diverzita sahala hluboko, vyhrál Mistral Large 4 (začal za
    // 2,5 s, zbytek odpovědi 6,5 min a přerušení) → 4/15 testů. Náhradníci za vypadlé smějí i níž (jako combo).
    // Závodníci jen SPOLEHLIVÍ (ne nespolehlivý / limit 429 / pomalý): živě 20. 11. večer byl Kimi K3.1 Pro (NVIDIA,
    // „pomalý“) v 57 závodech a ani jednou nezačal – jen dotaz navíc (a kvóta NVIDIA) v každém kroku. Nespolehliví
    // smějí jen jako náhradníci za vypadlé. Když spolehlivý není žádný, závodí první jako dřív.
    pick(arranged.slice(0, RACE_TOP), Math.min(n, racers), true);
    pick(arranged, n);
    // smějí závodit všichni spolehliví z prvních RACE_TOP (vychladlého závodníka v src/race.js nahradí další z nich);
    // napřed oni, za nimi náhradníci. out.racers = kolik prvních smí závodit (src/race.js)
    const top = new Set(arranged.slice(0, RACE_TOP).filter((x) => !bad(x)).map((x) => x.ref));
    const eligible = out.filter((r) => top.has(r));
    const sorted = [...eligible, ...out.filter((r) => !top.has(r))];
    out.splice(0, out.length, ...sorted);
    out.racers = eligible.length || Math.min(racers, out.length); // žádný spolehlivý → závodí první jako dřív
    // pořadí = pořadí průchodů (v každém pořadí combo): závodí prvních n, další jsou náhradníci (src/race.js)
    return out.length >= 2 ? out : [];
  }

  /**
   * Kontrola zdraví po startu: na prvních `k` modelů každého combo (jen tierlisty, kde se pracuje) pošle jeden drobný
   * dotaz (max_tokens 1) přes OmniRoute. Odpovědi 402/404/429 OmniRoute zapíše do historie volání, ze které rebalance
   * pozná mrtvé poskytovatele/modely (402 = celý účet bez kreditu na 72 h) a pauzy → nefunkční modely jdou z čela pryč
   * dřív, než na ně narazí první krok agenta. 22. 11. 2026: na čisté instalaci závod zkoušel HF bez kreditu (402) a
   * vyčerpané kvóty (429) v prvních krocích (docs/research/2026-11-22-claude-e2e). Stojí k drobných dotazů na combo.
   * Volá se až po sync(): baseLists plní sync, dřív je kontrola tichá no-op (0 modelů). 22. 11. 2026: strop
   * 20 s / 4 souběžné → 10 s / 12. Deterministický mock s 18 head modely: 39.7 s → 12.6 s
   * (docs/research/loop-czek-perf/results/probeheads-mock-2026-11-22.json); na skutečné instalaci 12 head modelů
   * za 10.0 s, vypadlé modely v závodě 3 → 1, median czasu závodu 7.1 s → 2.5 s, max 46.1 s → 6.4 s,
   * 15/15 testů stále pass (docs/research/loop-czek-perf/results/probe-ab-summary-2026-11-22.json). Pomalé,
   * kteří odpovědí, se stropem 10 s ztratí jen pro první krok – rebalance je pozná z historie volání OmniRoute.
   */
  // Souběžnost 12 (smyčka Strata, kolo 13, mock 18 modelů): 20 s / 4 → 39,7 s, 20 s / 12 → 22,5 s se stejně
  // nalezenými mrtvými. Strop 10 s → 12,6 s, ale pomalé živé modely (12–18 s) by vypadli z čela – proto druhá
  // round jen pro modely, které do 10 s ne odpověděly (slowPass na pozadí, startup neblokuje).
  // k = RACE_TOP + PROBE_RESERVE: i náhradníci závodu (src/race.js RESERVE 4). 22. 11.: Gemini 3 Flash (8. v pořadí)
  // vracel 429 „cooling down“ jako náhradník v každém běhu, kontrola prvních 6 ho nikdy neviděla.
  async probeHeads({ k = RACE_TOP + PROBE_RESERVE, combos = ['max', 'high', 'unlimited'].map(comboName),
    timeoutMs = Number(process.env.ZDARMA_PROBE_TIMEOUT_MS || 10000),
    slowTimeoutMs = Number(process.env.ZDARMA_PROBE_SLOW_TIMEOUT_MS || 25000),
    concurrency = Number(process.env.ZDARMA_PROBE_POOL || 12), force = false } = {}) {
    if (!this.ready) return { probed: 0, spanMs: 0 };
    const key = this.apiKey || await this.ensureKey().catch(() => null);
    if (!key) return { probed: 0, spanMs: 0 };
    const refs = new Map(); // ref OmniRoute → { provider, id } (pauza se zapisuje klíč Zdarmy)
    // gating: čerstvý doklad odpovědi (kontrola nebo krok agenta) a žádné novější selhání → model se teď nezkouší
    // (force = ruční „Zkontrolovat modely“ / kontrola po průvodci: vždy všechny)
    const freshMs = force ? 0 : Number(process.env.ZDARMA_PROBE_FRESH_MS ?? PROBE_FRESH_MS);
    const skipMax = Number(process.env.ZDARMA_PROBE_SKIP_MAX ?? PROBE_SKIP_MAX);
    const nowGate = Date.now();
    let skipped = 0;
    for (const name of combos) {
      const base = this.baseLists.get(name);
      if (!base?.length) continue;
      for (const x of this.arrange(base).filter((y) => !this.isPaused(y)).slice(0, k)) {
        if (refs.has(x.ref)) continue;
        const kk = `${x.provider}/${x.id}`;
        if (freshMs > 0) {
          const alt = this.matchKey(kk);
          const ks = alt === kk ? [kk] : [kk, alt];
          const ok = Math.max(...ks.map((q) => this.okAt.get(q) || 0));
          const fail = Math.max(...ks.map((q) => this.failAt.get(q) || 0));
          const streak = (this.skipStreak.get(kk) || 0) + 1;
          if (ok && nowGate - ok < freshMs && fail <= ok && streak <= skipMax) { this.skipStreak.set(kk, streak); skipped++; continue; }
          this.skipStreak.set(kk, 0);
        }
        refs.set(x.ref, x);
      }
    }
    if (!refs.size) {
      if (skipped) { this.log(`kontrola zdraví: čelo tierů má čerstvý doklad odpovědi (< ${Math.round(freshMs / 60000)} min) → 0 dotazů, vynecháno ${skipped}`); return { probed: 0, spanMs: 0, skipped }; }
      this.log('kontrola zdraví: tierlisty ještě nejsou složeny (probeHeads volána před sync) → 0 modelů');
      return { probed: 0, spanMs: 0 };
    }
    const results = {};
    const why = {}; // tělo ne-200 odpovědi (max 160 znaků) – podle něj se 400 rozliší od mrtvého modelu
    const t0 = Date.now();
    await runPool([...refs.keys()].map((ref) => async () => {
      const r = await this.probeModel(ref, key, timeoutMs);
      results[ref] = r.status;
      if (r.status !== 200 && r.body) why[ref] = r.body;
      const x = refs.get(ref);
      if (x) {
        const kk = `${x.provider}/${x.id}`;
        if (r.status === 200) { this.okAt.set(kk, Date.now()); this.skipStreak.set(kk, 0); } else this.failAt.set(kk, Date.now());
      }
    }), concurrency).catch(() => {});
    const bad = Object.entries(results).filter(([, s]) => s !== 200);
    const spanMs = Date.now() - t0;
    // Selhání, která OmniRoute nezapisuje do cooldownů (timeout, většina 429): bez lokalní pauzy je syncCooldowns()
    // nevidí a mrtvý model se vrátí do čela combo i do závodu. Timeout dostává jen krátkou pauzu – slowPass
    // rozhodne, jest model jen pomalý (→ konec combo) nebo skutečně mrtvý (→ dlouhá pauza).
    let local = 0;
    let renewed = 0;
    if (process.env.ZDARMA_PROBE_PAUSE !== '0') {
      const now = Date.now();
      for (const [ref, status] of bad) {
        const x = refs.get(ref); if (!x) continue;
        const kk = `${x.provider}/${x.id}`;
        // timeout u modelu, o kterém 2. kolo už ví, že je jen pomalý: pauza by ho vyřadila i jako náhradníka (60 s výpadek
        // každé kolo kontroly) → jen obnovit odsun na konec combo (smyčka Strata, kolo 21)
        if (status === 0 && process.env.ZDARMA_PROBE_SLOW_RENEW !== '0' && (this.slow.has(kk) || now - (this.slowSeen.get(kk) || 0) < SLOW_SUSPECT_MS)) {
          const prevS = this.probeSlow.get(kk);
          const untilS = now + PROBE_SLOW_MS;
          if (!prevS || prevS.until < untilS) this.probeSlow.set(kk, { until: untilS, ms: prevS?.ms ?? 0, renewed: true });
          this.slowDirty = true; renewed++;
          continue;
        }
        const until = now + (status === 0 ? TIMEOUT_PAUSE_MS : (PROBE_PAUSE_MS[status] ?? 5 * 60 * 1000));
        const prev = this.probePaused.get(kk);
        if (prev && prev.until >= until) continue;
        this.probePaused.set(kk, { until, status, ref, since: prev?.since ?? now });
        local++;
      }
    }
    if (local) this.keyHashesDirty = true;
    if (local || renewed) this.saveHashes();
    const timedOut = bad.filter(([, s]) => s === 0).map(([ref]) => ref);
    // Druhá round na pozadí: startup nesmí chekat 25 s na visící modely. Promise je uložen, aby test/ladění
    // mohl `await omni.slowPassing`.
    this.slowPassing = timedOut.length && slowTimeoutMs > 0
      ? this.slowPass(timedOut, refs, key, slowTimeoutMs, concurrency).catch((e) => this.log(`slowPass: ${e.message}`))
      : null;
    // 400, které zůstalo i po druhém pokusu: vypsat, co model odpověděl – bez těla se z logu nedá poznat, jestli
    // jde o neplatný model (404), vyčerpaný limit (429) nebo jen o tvar požadavku (400).
    const bad400 = bad.filter(([, s]) => s === 400);
    if (bad400.length) this.log(`kontrola zdraví: 400 i po druhém pokusu (max_tokens 64): ${bad400.slice(0, 4).map(([r]) => `${r} „${(why[r] || '').slice(0, 120)}“`).join(', ')}${bad400.length > 4 ? ` … +${bad400.length - 4}` : ''}`);
    this.log(`kontrola zdraví: ${Object.keys(results).length} modelů z čela tierů za ${spanMs} ms, nefunkční ${bad.length}${bad.length ? ` (${bad.map(([r, s]) => `${r} ${s || 'timeout'}`).join(', ')})` : ''}${local ? `, lokalní pauza ${local} modelů` : ''}${renewed ? `, pomalých znovu na konec ${renewed}` : ''}${skipped ? `, vynecháno s čerstvým dokladem ${skipped}` : ''}${timedOut.length ? `, druhá round: ${timedOut.length} modelů do 25 s` : ''}`);
    return { probed: Object.keys(results).length, spanMs, results, probePaused: local, renewed, skipped, timedOut: timedOut.length };
  }

  /** Jeden probe dotaz: { status, ms } – status 0 = žádná odpověď do stropu (timeout/abort). */
  async probeOnce(ref, key, ms, { maxTokens = 1, content = 'Reply with OK.' } = {}) {
    const t = Date.now();
    try {
      const r = await fetch(`${this.url}/v1/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(ms),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: ref, messages: [{ role: 'user', content }], max_tokens: maxTokens, stream: false }),
      });
      const status = r.status;
      // Tělo jen u chyby: u 400 je to jediná stopa, proč model „nefunguje“ (log jinak ukáže jen číslo).
      const body = status === 200 ? null : (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
      return { status, ms: Date.now() - t, body };
    } catch { return { status: 0, ms: Date.now() - t, body: null }; }
  }

  /**
   * Kontrola jednoho modelu: drobný dotaz, a když vrátí 400, ještě jednou s normálním stropem výstupu.
   * 400 na „max_tokens: 1“ znamená, že model odmítá TVAR kontroly (reasoning modely potřebují víc výstupních
   * tokenů), ne že je mrtvý: 23. 11. na Windows hlásila kontrola 400 u nvidia/nemotron-3-ultra-550b-a55b, přitom
   * v téže relaci vyhrál 31 kroků (docs/research/2026-11-23-self-report/report-2026-11-23d-live-0.15.40.md).
   * Falešná pauza pak na 5 min vyhodila nejsilnější model z čela tieru i ze závodu.
   */
  async probeModel(ref, key, ms) {
    const first = await this.probeOnce(ref, key, ms);
    if (first.status !== 400) return first;
    const second = await this.probeOnce(ref, key, ms, { maxTokens: 64, content: 'OK' });
    return { ...second, firstStatus: first.status, firstBody: first.body };
  }

  /**
   * Druhá round pro modely, které se neozvaly do fast stropu (10 s). Odpovědí-li do 25 s, nejsou mrtvé –
   * jen pomalé: se demotí na konec combo (coverage zůstává, závod je nechá jako náhradníka), místo pauzy,
   * která by je vyřadila i z combo. Mrtvé dostává pauzu podle PROBE_PAUSE_MS. Náklad: každý model se zkouší
   * nanejvys jednou za SLOW_CHECK_MS (2 h) – kontrola čela tak nenásobí dotazy do Zdarmy.
   */
  async slowPass(refList, refs, key, slowTimeoutMs, concurrency) {
    const now = Date.now();
    const due = [];
    for (const ref of refList) {
      const x = refs.get(ref); if (!x) continue;
      const kk = `${x.provider}/${x.id}`;
      if (now - (this.slowChecked.get(kk) || 0) < SLOW_CHECK_MS) continue;
      this.slowChecked.set(kk, now);
      due.push([ref, x, kk]);
    }
    if (!due.length) return { checked: 0, slow: 0 };
    let slow = 0;
    await runPool(due.map(([ref, x, kk]) => async () => {
      const r = await this.probeModel(ref, key, slowTimeoutMs);
      if (r.status === 200) {
        this.probePaused.delete(kk);
        // syncCooldowns() kopíruje probePaused do this.paused – bez vymazání kopie by model zůstal „v pauze“
        // i po demotion (60 s) a combo by ho nepustil ani jako náhradníka.
        if (String(this.paused.get(kk)?.reason || '').startsWith('kontrola čela')) { this.paused.delete(kk); this.pausedSince.delete(kk); }
        this.probeSlow.set(kk, { until: Date.now() + PROBE_SLOW_MS, ms: r.ms });
        this.okAt.set(kk, Date.now()); // pomalý, ale odpovídá
        this.slowSeen.set(kk, Date.now());
        slow++;
      } else {
        const until = Date.now() + (PROBE_PAUSE_MS[r.status] ?? 5 * 60 * 1000);
        const prev = this.probePaused.get(kk);
        if (!prev || prev.until < until) this.probePaused.set(kk, { until, status: r.status, ref, since: prev?.since ?? Date.now() });
      }
    }), concurrency).catch(() => {});
    this.keyHashesDirty = true; this.saveHashes();
    if (slow) this.log(`kontrola čela tierů (2. round): ${slow} modelů odpovědělo až po fast probe → odsun na konec combo, ne pauza`);
    return { checked: due.length, slow };
  }

  /** Pomalý model: z historie volání (this.slow) nebo z 2. round kontroly čela (this.probeSlow). */
  isSlow(x, now = Date.now()) {
    const kk = `${x.provider}/${x.id}`;
    return this.slow.has(kk) || (this.probeSlow.get(kk)?.until || 0) > now;
  }

  /** Je model ({provider, id} Zdarmy) teď v pauze – OmniRoute nebo kontrola čela tierů? */
  isPaused(x, now = Date.now()) {
    const kk = `${x.provider}/${x.id}`;
    return Math.max(this.paused.get(kk)?.until || 0, this.probePaused.get(kk)?.until || 0) > now;
  }

  /** Jsou v pauze všechny modely combo (např. sjednocené combo modelu s viděním u více poskytovatelů)? */
  comboPaused(name, now = Date.now()) {
    const base = this.baseLists.get(name);
    return !!(base && base.length && base.every((x) => this.isPaused(x, now)));
  }

  /**
   * Pauzy modelů, které teď drží OmniRoute (GET /api/resilience/model-cooldowns: provider = id uzlu, model,
   * remainingMs, reason) → this.paused (klíč Zdarmy prov/model). Pauzu, kterou czek-ai vidí déle než reprobeMs,
   * v OmniRoute smaže (model se zkusí znovu). Vrací { paused, reprobed }.
   */
  async syncCooldowns(now = Date.now()) {
    const j = await this.api('GET', '/api/resilience/model-cooldowns');
    const items = Array.isArray(j?.items) ? j.items : [];
    const next = new Map();
    const reprobe = new Map(); // klíč → { provider (uzel OmniRoute), model }
    for (const it of items) {
      const rem = Number(it?.remainingMs) || 0;
      if (!it?.model || !it.provider || rem <= 0) continue;
      const prov = this.nodeToProvider.get(it.provider) || it.provider;
      const key = `${prov}/${it.model}`;
      // model tak, jak ho dostává OmniRoute (combo, závod, řádky volání): nativní poskytovatel „gemini/…“, uzel „z-ovh/…“
      const ref = `${NATIVE_IDS.has(it.provider) || !this.nodeToProvider.has(it.provider) ? it.provider : PREFIX + prov}/${it.model}`;
      const since = this.pausedSince.get(key) ?? now;
      if (!this.pausedSince.has(key)) {
        this.pausedSince.set(key, since);
        if (rem > PAUSE_LOG_MS) this.log(`OmniRoute: ${key} v pauze ${Math.round(rem / 3600000)} h (${it.reason || '?'}, do ${new Date(now + rem).toISOString()}) – czek-ai ho do závodu nedá, znovu zkusí za ${Math.round(this.reprobeMs / 60000)} min`);
      }
      if (now - since >= this.reprobeMs) { reprobe.set(key, { provider: it.provider, model: it.model }); continue; }
      const until = now + rem;
      const prev = next.get(key);
      if (prev && prev.until >= until) continue;
      next.set(key, { ref, until, reason: String(it.reason || ''), since, failures: Number(it.failureCount) || 0, reprobeAt: until > since + this.reprobeMs ? since + this.reprobeMs : null });
    }
    for (const [key, x] of reprobe) {
      try {
        await this.api('DELETE', '/api/resilience/model-cooldowns', x);
        this.log(`OmniRoute: pauza ${key} smazána po ${Math.round(this.reprobeMs / 60000)} min – model se zkusí znovu`);
      } catch (e) { this.log(`OmniRoute: pauzu ${key} nejde smazat: ${e.message}`); }
      this.pausedSince.delete(key);
      next.delete(key);
    }
    for (const key of [...this.pausedSince.keys()]) if (!next.has(key) && !reprobe.has(key)) this.pausedSince.delete(key); // vypršela / restart OmniRoute
    // selhání z probeHeads, která OmniRoute do cooldownů nezapisuje (timeout, většina 429): pauza musí survive
    // i přes `this.paused = next`, jinak se mrtvý model vrátí do čela combo i do závodu
    let fromProbe = 0;
    for (const [key, p] of this.probePaused) {
      if (p.until <= now) { this.probePaused.delete(key); continue; }
      const cur = next.get(key);
      if (cur && cur.until >= p.until) continue; // OmniRoute pauza je delší, ta stačí
      next.set(key, { ref: p.ref, until: p.until, reason: `kontrola čela (${p.status || 'timeout'})`, since: p.since, failures: 0, reprobeAt: null });
      fromProbe++;
    }
    for (const [key, s] of this.probeSlow) if (s.until <= now) this.probeSlow.delete(key); // demotion expires
    for (const [key, t] of this.slowSeen) if (now - t > SLOW_SUSPECT_MS) this.slowSeen.delete(key); // doklad pomalosti stárne
    this.paused = next;
    this.pausedAt = now;
    return { paused: next.size, reprobed: [...reprobe.keys()], fromProbe };
  }

  /** Název modelu z odpovědi (pole "model") → klíč Zdarmy podle seznamu combo. */
  keyForModel(combo, model) {
    if (!model) return null;
    const list = this.comboModels.get(combo) || [];
    const m = String(model).toLowerCase();
    const hit = list.find((x) => x.id.toLowerCase() === m) || list.find((x) => x.id.toLowerCase().endsWith('/' + m) || m.endsWith('/' + x.id.toLowerCase()));
    return hit ? `${hit.provider}/${hit.id}` : null;
  }
}

module.exports = { OmniRoute, find, findPlugin, findNode, setLocal, splitChatUrl, comboName, PREFIX, NATIVE, isTestRow };
