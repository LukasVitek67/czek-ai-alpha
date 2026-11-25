'use strict';
const I18N = require('./i18n');
// Zápis poskytovatele "zdarma" do globální konfigurace OpenCode (~/.config/opencode/opencode.json).
// API klíče se do OpenCode nekopírují: zůstávají šifrované ve Zdarmě a doplňuje je proxy.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stejně jako OpenCode: globální konfigurace v $XDG_CONFIG_HOME/opencode, jinak ~/.config/opencode.
// (OPENCODE_CONFIG_DIR je u OpenCode jen další vrstva navíc, nenahrazuje globální konfiguraci.)
const CONFIG_DIR = () => process.env.OPENCODE_CONFIG_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
const CONFIG_FILE = () => path.join(CONFIG_DIR(), 'opencode.json');
const DATA_DIR = () => process.env.OPENCODE_DATA_DIR
  || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
const AUTH_FILE = () => path.join(DATA_DIR(), 'auth.json');
const PLUGIN_DIR = () => path.join(CONFIG_DIR(), 'plugins', 'omniroute');
const { knownContext, tierContext, uniteModels } = require('./tiers');

// Kontext, který OpenCode vidí u auto combo OmniRoute (auto/coding, auto/fast). OmniRoute u nich hlásí kontext
// největšího kandidáta (auto/coding 1 050 000), OpenCode pak sám nezkracuje nikdy a dotaz přeteče u člena se
// 128k (0.15.6: Z.ai GLM 4.5 Flash na 98,7k). Stejně jako vlastní combo zdarma-* (96 000): OpenCode zkracuje
// od 96 000 − min(výstup, 32 000), tedy dřív, než to člen se 128k odmítne. Guard (přetečení → summarize) zůstává záloha.
const AUTO_CONTEXT = 96000;
const AUTO_MARK = '/*czek-auto-context-2*/';
// Výstup: plugin u combo hlásí MINIMUM přes všechny členy (zdarma-unlimited: 60 členů, 35 z HuggingFace s 8192),
// OpenCode pak posílá max_tokens 8192. Se zapnutým uvažováním (reasoning_effort medium) to nestačí: 14. 11. krok
// spotřeboval všech 8192 tokenů na uvažování a skončil „length“ bez nástroje. Čisté OpenCode s jedním modelem
// dává 32 000. OmniRoute si požadovaný výstup sám sníží na strop konkrétního modelu (enforceOutputTokenBudget,
// maxOutputTokenCap), takže vyšší hodnota u combo nic nerozbije. 16 000 = 2× víc místa a zkracování kontextu
// (kontext − výstup) se posune jen z 87 800 na 80 000 tokenů.
const COMBO_OUTPUT = 16000;
// Model na titulky relací a drobnosti (small_model): tier Low (malé rychlé modely, řídí ho czek-ai). Dřív auto/fast.
const SMALL_MODEL = 'opencode-omniroute/zdarma-low';
// Výchozí model nových relací: tier Max (řídí ho czek-ai: mrtvé a nespolehlivé modely ven). Dřív auto/coding – combo
// OmniRoute, které czek-ai neřídí. Změřeno 19. 11. (těžší úloha, 15 testů): tier Max 15/15 za 120 s.
const DEFAULT_MODEL = 'opencode-omniroute/zdarma-max';
// Zastropuje kontext modelů auto/* v obou místech, kde plugin vrací katalog (hook provider.models i config shim).
const AUTO_CLAMP_FN = `function czekClampAuto(models) { ${AUTO_MARK}
  for (const [key, m] of Object.entries(models || {})) {
    if (!m || !m.limit) continue;
    const auto = /(^|\\/)auto(\\/|$)/.test(key);
    if ((auto || /(^|\\/)zdarma-/.test(key)) && !(m.limit.output >= ${COMBO_OUTPUT})) m.limit.output = ${COMBO_OUTPUT};
    if (!auto) continue;
    if (!(m.limit.context > 0) || m.limit.context > ${AUTO_CONTEXT}) m.limit.context = ${AUTO_CONTEXT};
    if (m.limit.input > ${AUTO_CONTEXT}) m.limit.input = ${AUTO_CONTEXT};
  }
  return models;
}
`;

// Kopie pluginu nesmí záviset na balíku @opencode-ai/plugin. OpenCode si ho do konfigurační složky doinstaluje
// samo, ale na čistém profilu až během první instance; když se import nepovede (15. 11. na kopii celé appky:
// „Cannot find package '@opencode-ai/plugin'“ při KAŽDÉM načtení instance až do restartu serveru), není žádný
// poskytovatel a appka je bez modelů. Plugin z balíku bere jen `tool` pro nástroj omniroute_sync_models, který
// máme vypnutý (tools.omniroute_sync_models = false) → náhrada bez závislosti a nástroj se neregistruje.
const NO_DEP_MARK = '/*czek-no-plugin-dep*/';
// Obrázky u tier combo (zdarma-*, auto/*): plugin hlásí obrázky jen když je umí VŠICHNI členové → u Max (Nemotron)
// ne, a OpenCode pak obrázek od uživatele modelu nahradí větou „Cannot read image.png (this model does not support
// image input)“ (živě 20. 11.). Combo teď obrázky přijme a proxy závodu je převede na soubor + popis od modelu
// s viděním (src/vision.js), takže je model bez vidění dostane jako text.
const VISION_MARK = '/*czek-vision*/';
const VISION_RE = '/^(zdarma-|auto\\/)/';
const NO_DEP_SHIM = `${NO_DEP_MARK} const tool = Object.assign((def) => def, { schema: { string() { const s = { optional: () => s, describe: () => s }; return s; } } });`;

/** Nainstaluje oficiální @omniroute/opencode-plugin do <CONFIG_DIR>/plugins/omniroute (jako `omniroute setup opencode`). */
function installOmniPlugin(pluginSrc) {
  const src = pluginSrc || require('./omniroute').findPlugin();
  if (!src) throw new Error('Oficiální plugin @omniroute/opencode-plugin nebyl v instalaci OmniRoute nalezen.');
  const target = PLUGIN_DIR();
  const srcPkg = path.join(src, 'package.json');
  const dstPkg = path.join(target, 'package.json');
  const dstEntry = path.join(target, 'dist', 'index.js');
  let same = false;
  try {
    same = fs.existsSync(dstEntry)
      && JSON.parse(fs.readFileSync(srcPkg, 'utf8')).version === JSON.parse(fs.readFileSync(dstPkg, 'utf8')).version
      && fs.readFileSync(dstEntry, 'utf8').includes('/*zdarma-combo-display*/')
      && fs.readFileSync(dstEntry, 'utf8').includes(AUTO_MARK)
      && fs.readFileSync(dstEntry, 'utf8').includes(NO_DEP_MARK)
      && fs.readFileSync(dstEntry, 'utf8').includes(VISION_MARK);
  } catch {}
  if (!same) {
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(srcPkg, dstPkg);
    fs.cpSync(path.join(src, 'dist'), path.join(target, 'dist'), { recursive: true });
    // Zachovat combo.displayName (přehled poskytovatelů u sjednoceného modelu) jako popisek v OpenCode
    // a nechat combo projít i při zúžení raw modelů přes visibleModels.
    let code = fs.readFileSync(dstEntry, 'utf8');
    code = code
      .replace(
        'name: combo.name && combo.name.trim().length > 0 ? combo.name : combo.id,',
        'name: /*zdarma-combo-display*/ (combo.displayName && combo.displayName.trim()) || (combo.name && combo.name.trim()) || combo.id,',
      )
      .replace(
        'const displayName = hasMembers && compressionSuffix ? `${friendlyName} ${compressionSuffix}` : friendlyName;',
        'const labelBase = (combo.displayName && combo.displayName.trim()) || friendlyName; const displayName = hasMembers && compressionSuffix ? `${labelBase} ${compressionSuffix}` : labelBase;',
      )
      .replace(
        'function passesComboAllowlist(combo, visible) {\n  if (!visible) return true;',
        'function passesComboAllowlist(combo, visible) {\n  if (!visible || combo?.id) return true;',
      )
      // auto/* s kontextem největšího kandidáta → strop AUTO_CONTEXT (viz nahoře)
      .replace(
        '      return models;\n    }\n  };\n}\nfunction createOmniRouteFetchInterceptor(',
        () => '      return czekClampAuto(models);\n    }\n  };\n}\n' + AUTO_CLAMP_FN + 'function createOmniRouteFetchInterceptor(',
      )
      .replace(
        '    options: { baseURL, apiKey },\n    models\n  };',
        '    options: { baseURL, apiKey },\n    models: czekClampAuto(models)\n  };',
      )
      // Plugin bez závislosti na @opencode-ai/plugin (viz NO_DEP_MARK): import nahradit náhradou, nástroj
      // omniroute_sync_models (jediné použití) a jeho dva příkazy neregistrovat.
      .replace('import { tool } from "@opencode-ai/plugin";', () => NO_DEP_SHIM)
      // obrázky u tier combo – statický katalog (config shim) i dynamický (hook models), viz VISION_MARK
      .replace(
        '      const key = buildComboKey(combo, usedComboKeys, opts.omnirouteProviderId).split("/").pop();',
        () => `      ${VISION_MARK} if (${VISION_RE}.test(String(combo.name || ""))) { entry.attachment = true; entry.modalities = { input: [...new Set([...((entry.modalities && entry.modalities.input) || ["text"]), "image"])], output: (entry.modalities && entry.modalities.output) || ["text"] }; }\n      const key = buildComboKey(combo, usedComboKeys, opts.omnirouteProviderId).split("/").pop();`,
      )
      .replace(
        '  const comboApiBlock = (() => {',
        () => `  ${VISION_MARK} if (${VISION_RE}.test(String(combo.name || ""))) { capabilities.attachment = true; capabilities.input.image = true; }\n  const comboApiBlock = (() => {`,
      )
      .replace(/config: configWithSyncCommand,\s*tool: \{\s*omniroute_sync_models: syncTool\s*\}/, 'config: baseConfigHook');    fs.writeFileSync(dstEntry, code, 'utf8');
  }
  return dstEntry.replace(/\\/g, '/');
}

/** Smaže diskovou cache katalogu pluginu OmniRoute, aby OpenCode hned načetlo čerstvé sjednocené modely. */
function clearOmniPluginCache() {
  for (const id of ['opencode-omniroute', 'omniroute']) {
    try { fs.unlinkSync(path.join(DATA_DIR(), 'plugins', `omniroute-${id}.json`)); } catch {}
  }
}

/** Zapíše API klíč a adresu OmniRoute do auth.json OpenCode (ostatní přihlášení uživatele zachová). */
function writeOmniAuth(baseURL, apiKey) {
  const file = AUTH_FILE();
  let auth = {};
  if (fs.existsSync(file)) {
    try { auth = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { auth = {}; }
  }
  const before = JSON.stringify(auth);
  const entry = { type: 'api', key: apiKey, baseURL };
  auth['opencode-omniroute'] = entry;
  auth.omniroute = entry;
  const changed = JSON.stringify(auth) !== before;
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(auth, null, 2) + '\n');
  }
  return changed;
}

// Každý model ze Zdarmy jako samostatná volba v OpenCode.
function modelEntries(models) {
  const out = {};
  for (const m of models || []) {
    if (!m.usable || !m.key) continue;
    const ctx = Math.min(knownContext(m) || 32000, 1000000);
    out[m.key] = {
      name: `${m.providerName || m.provider} · ${m.id}`.slice(0, 140),
      tool_call: true, // bez nativních nástrojů je doplní proxy textovým protokolem
      limit: { context: ctx, output: m.maxLen || Math.min(8192, Math.max(1024, Math.floor(ctx / 4))) },
    };
  }
  return out;
}

// Tierlist jako volba v OpenCode. Kontextový limit: vlastní z editoru, jinak medián kontextů prvních
// modelů tierlistu (tiers.tierContext). OpenCode podle něj zkracuje konverzaci; proxy model, kterému
// by konverzace nevešla, přeskočí a vezme větší.
function tierEntries(tierList, models) {
  const present = new Set((models || []).filter((m) => m.usable).map((m) => m.key));
  const out = {};
  for (const t of tierList || []) {
    const ctx = t.context || tierContext(t.keys, models);
    const count = t.keys.filter((k) => present.has(k)).length;
    const fb = tierList.find((x) => x.id === t.fallback);
    const what = count ? I18N.models(count).replace(' free', '') : fb ? I18N.t('tier.emptyFb', { fb: fb.name }) : I18N.t('tier.empty');
    out[t.id] = {
      name: `${t.name} · ${what}${t.desc && !t.custom ? ` · ${t.desc}` : ''}`,
      tool_call: true,
      limit: { context: ctx, output: t.id === 'unfiltered' ? 2048 : 8192 },
    };
  }
  return out;
}

// Sjednocené modely napříč poskytovateli (záložní blok Zdarmy pro OpenCode).
function unitedEntries(models, o = {}) {
  const out = {};
  for (const u of uniteModels(models, o.settings || {}, o.registry || null)) {
    if (!u.usable.length || !u.tools) continue;
    out[u.slug] = {
      name: `${u.title} · ${u.usable.length}× (${u.providers.join(', ')})`.slice(0, 140),
      tool_call: true,
      limit: { context: u.context, output: 8192 },
    };
  }
  return out;
}

// Výchozí („lean") výběr modelů v OpenCode u živé cesty přes OmniRoute: auto/coding + pár ověřených modelů
// z měření (src/evidence.js). Tierlisty (combos zdarma-*) plugin ukazuje vždy; visibleModels je allowlist jen
// na jednotlivé modely a holý klíč bere jako suffix (část id za prvním „/"), takže ověřený model projde bez
// ohledu na to, který poskytovatel ho zrovna nabízí. Zbytek katalogu (stovky) zůstane schovaný; uživatel ho
// odkryje volbou „všechny modely" (onlyTiers=false → config bez visibleModels = „Další"). Když ověřený model
// zrovna v katalogu není, allowlist ho jen ignoruje – nic se nerozbije.
const PROVEN_VISIBLE = 8;
function provenModelKeys(limit = PROVEN_VISIBLE) {
  try {
    const ev = require('./evidence');
    const p = ev.proven(ev.load());
    return Object.entries(p).sort((a, b) => a[1].rank - b[1].rank).map(([k]) => k).slice(0, limit);
  } catch { return []; }
}
function leanVisible(o = {}) {
  const extra = Array.isArray(o.visibleModels) ? o.visibleModels : provenModelKeys(o.provenLimit || PROVEN_VISIBLE);
  return ['auto/coding', ...extra.filter((k) => k && k !== 'auto/coding')];
}

/**
 * @param {number} port
 * @param {Array} models  modely ze Zdarmy
 * @param {{tiers?: Array, onlyTiers?: boolean}} [o]  tierlisty (tiers.overview) a jestli nabízet jen je
 */
function providerBlock(port, models, o = {}) {
  const onlyTiers = o.onlyTiers !== false && Array.isArray(o.tiers);
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Zdarma',
    options: {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'zdarma', // proxy klíč nepotřebuje, SDK ho ale chce
      timeout: false, // lokální modely a AI Horde umí generovat dlouho
      chunkTimeout: 600000,
    },
    models: {
      ...tierEntries(o.tiers, models),
      ...unitedEntries(models, o),
      ...(onlyTiers ? {} : {
        auto: { name: I18N.t('tier.auto'), tool_call: true, limit: { context: 100000, output: 8192 } },
        ...modelEntries(models),
      }),
    },
  };
}

// JSONC → JSON: odstraní komentáře // a /* */ a čárky před } nebo ] (mimo řetězce, takže "https://…" zůstane).
function stripJsonc(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
const parseJsonc = (raw) => {
  const t = String(raw).replace(/^﻿/, '');
  if (!t.trim()) return {};
  try { return JSON.parse(t); } catch { return JSON.parse(stripJsonc(t)); }
};

// Rozbitý opencode.json = OpenCode i czek-ai se tiše nespustí (známá chyba OpenCode: „ProviderInitError“
// bez hlášky v GUI). Komentáře (JSONC) se přečtou; jinak se vezme poslední záloha .bak a rozbitý soubor
// se odloží vedle jako .broken, aby o nic nepřišel.
function readConfig() {
  const file = CONFIG_FILE();
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  try { return parseJsonc(raw); } catch {}
  try {
    const bak = parseJsonc(fs.readFileSync(file + '.bak', 'utf8'));
    fs.copyFileSync(file, file + '.broken');
    readConfig.restored = file + '.broken';
    return bak;
  } catch {}
  throw new Error(`${file} není platný JSON a záloha .bak chybí nebo je taky rozbitá. Oprav soubor ručně (nebo ho smaž, czek-ai ho vytvoří znovu).`);
}

// Plný automatický režim: agent se na nic neptá. Výchozí OpenCode 1.19.5 je "*": allow, ale ptá se na
// soubory mimo projekt (external_directory), čtení .env a opakované stejné volání (doom_loop).
// Úmyslně ne "*" ani edit: uživatelská pravidla se slučují až PO pravidlech agenta a přebila by zákaz
// úprav v režimu Plan. question zůstává (otázka na uživatele není žádost o povolení).
const FULL_AUTO = {
  read: { '*': 'allow', '*.env': 'allow', '*.env.*': 'allow' },
  external_directory: { '*': 'allow' },
  bash: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  task: 'allow',
  lsp: 'allow',
  skill: 'allow',
  todowrite: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  doom_loop: 'allow',
};
// Původní "permission" uživatele se při zapnutí odloží sem (vedle konfigurace) a při vypnutí vrátí.
const PERM_BACKUP = () => path.join(CONFIG_DIR(), 'opencode.zdarma-permission.json');

// todowrite v permission přebije "tools": { todowrite: false } → u plného režimu se řídí volbou seznamu úkolů;
// skill si řídí applySkills (seznam povolených skills) → při porovnání „je to naše nastavení?“ se oba klíče vynechají
const sansTodo = (p) => { if (!p || typeof p !== 'object') return p; const { todowrite, skill, ...rest } = p; return rest; };

// Které skills OpenCode vypíše modelu v systémovém promptu KAŽDÉHO dotazu. Bez omezení vypisuje všechno, co najde:
// přibalené skills i soukromé skills uživatele z ~/.claude/skills a .agents/skills. Změřeno 15. 11. na PC uživatele:
// 49 skills = 21 100 znaků z 42 400 (čisté OpenCode: 18 700 celý prompt) – mezi nimi 11 skills pro tvorbu videa
// (acestep, elevenlabs, ffmpeg, remotion…) a 7× rodina caveman, která je stejně zapnutá trvale přes pokyny.
// allow = pole jmen skills, které zůstanou; ostatní se nevypisují ani nenačtou. null = bez omezení.
// Vlastní pravidlo uživatele (permission.skill, které jsme nezapsali my) se nemění.
const SKILLS_FILE = () => path.join(CONFIG_DIR(), 'opencode.zdarma-skills.json');
function applySkills(cfg, allow) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(SKILLS_FILE(), 'utf8')); } catch {}
  const perm = cfg.permission && typeof cfg.permission === 'object' ? cfg.permission : null;
  const cur = perm ? perm.skill : undefined;
  const ours = cur === undefined || cur === 'allow' || (prev && JSON.stringify(cur) === JSON.stringify(prev));
  if (!ours) return;
  if (Array.isArray(allow) && allow.length) {
    const rule = { '*': 'deny', ...Object.fromEntries([...new Set(allow)].sort().map((n) => [n, 'allow'])) };
    if (!perm) cfg.permission = {};
    cfg.permission.skill = rule;
    if (JSON.stringify(prev) !== JSON.stringify(rule)) { fs.mkdirSync(CONFIG_DIR(), { recursive: true }); fs.writeFileSync(SKILLS_FILE(), JSON.stringify(rule, null, 2) + '\n'); }
    return;
  }
  if (perm && cur !== undefined && cur !== 'allow') {
    delete perm.skill;
    if (!Object.keys(perm).length) delete cfg.permission;
  }
  try { fs.rmSync(SKILLS_FILE(), { force: true }); } catch {}
}
function applyFullAuto(cfg, on, todo = false) {
  const backup = PERM_BACKUP();
  const isOurs = JSON.stringify(sansTodo(cfg.permission)) === JSON.stringify(sansTodo(FULL_AUTO));
  if (on) {
    if (!fs.existsSync(backup) && !isOurs) {
      fs.mkdirSync(CONFIG_DIR(), { recursive: true });
      fs.writeFileSync(backup, JSON.stringify({ had: 'permission' in cfg, permission: cfg.permission ?? null }, null, 2) + '\n');
    }
    cfg.permission = { ...FULL_AUTO, todowrite: todo ? 'allow' : 'deny' };
    return;
  }
  if (fs.existsSync(backup)) {
    let b = null;
    try { b = JSON.parse(fs.readFileSync(backup, 'utf8')); } catch {}
    if (b && isOurs) { if (b.had) cfg.permission = b.permission; else delete cfg.permission; }
    if (b) fs.unlinkSync(backup);
  } else if (isOurs) delete cfg.permission;
}

// Je domovská složka (nebo něco nad ní) git repozitář? Pak je pro OpenCode „projektem“ celý domov
// a před i po každém kroku agenta dělá snímek (git add + write-tree) přes AppData, Stažené, Videa…
// Živý záznam 8. 11. 13:20: ~4 s na snímek, 12–13 s mrtvého času na krok při 7–25 s práce modelu.
function homeInGit(home = os.homedir()) {
  for (let d = path.resolve(home); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
// Pokyny pro agenta, které OpenCode přidá do systémového promptu (konfigurace "instructions").
// Každý bod je z živého záznamu 8. 11.: `npm run tauri dev` v popředí 2× po 124 s utnuté a procesy
// visely dál; edit „Could not find oldString“; agent v nadřazené složce s 8 projekty; smyčky.
const AGENT_TIPS_FILE = () => path.join(CONFIG_DIR(), 'zdarma-agent.md');
// Skill caveman (JuliusBrussee/caveman, Apache-2.0, přibalený ve skills/caveman) trvale zapnutý: jeho pravidla jdou
// do "instructions" → v každém dotazu, model ho nemusí načítat (uživatel 14. 11.: „always have turned on“).
const CAVEMAN_FILE = () => path.join(CONFIG_DIR(), 'czek-caveman.md');
// Pracovní postup czek-ai (skills/czek-method, vlastní skill): jak pracuje zkušený inženýr (porozumět → načíst skills →
// číst kód → malé kroky → ověřit → poctivá zpráva) + směrovač, které skills má agent SÁM načíst podle úkolu (impeccable,
// ui-ux-pro-max, czek-debugging…). Uživatel 25. 11.: „ať si model vždy sám skills automaticky bere bez nutnosti inputu“.
// Trvale v "instructions" jako caveman (~3,4 kB v každém dotazu).
const METHOD_FILE = () => path.join(CONFIG_DIR(), 'czek-method.md');
/** Text pokynů ze SKILL.md skillu czek-method (bez hlavičky YAML). */
function methodInstructions(skillFile) {
  const body = fs.readFileSync(skillFile, 'utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return body + '\n';
}
/** Text pokynů ze SKILL.md skillu caveman: bez hlavičky a bez odstavce o aliasech na nepřibalené skills. */
function cavemanInstructions(skillFile) {
  let body = fs.readFileSync(skillFile, 'utf8').replace(/\r\n/g, '\n');
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^# caveman\n+/m, '');
  body = body.replace(/^`\/caveman ultra`[^\n]*\n\n?/m, ''); // ultracave/megacave v aplikaci nejsou
  return [
    '# Caveman mode: ON by default in czek-ai',
    '',
    'The caveman skill is active for every response in this app, from the first message. Do not load it, do not announce it.',
    'The user can switch it off for the session with "stop caveman" or "normal mode", and back on with "caveman mode".',
    '',
    body.trim(),
    '',
  ].join('\n');
}
const AGENT_TIPS = `# Working rules (added by Zdarma)
- Shell: the bash tool runs Git Bash on Windows, not PowerShell. Use forward slashes in paths. Set environment variables bash-style (\`VAR=value command\`), never \`$env:VAR=...\`. Windows commands called directly need doubled slashes for flags (\`taskkill //F //PID 123\`). Inside \`cmd //c "..."\` use normal single slashes (\`cmd //c "taskkill /F /PID 123"\`).
- Never kill processes by name (\`taskkill //IM node.exe\`, \`killall node\`, \`Stop-Process -Name node\`). That also kills the tools you are running on (the model router, other apps). Kill only the PID you started, found with \`netstat -ano | grep :PORT\` or from the log.
- Never run long-running commands in the foreground (dev servers, \`npm run dev\`, \`tauri dev\`, \`vite\`, watchers, the app itself). The tool stops after 2 minutes and the process keeps running. Start them in the background exactly like this, with the parentheses and the log file: \`(npm run tauri dev > dev.log 2>&1 &)\`. Without the parentheses, or with output not going to a file, the tool still waits and gets killed. Wait and read the log in a separate command (\`sleep 15; tail -20 dev.log\`).
- Long builds that do finish (\`cargo build --release\`, \`npx tauri build\`, first \`npm install\`) take 3–15 minutes. The bash tool stops after 2 minutes unless you pass its \`timeout\` parameter, so set it (e.g. \`600000\` = 10 min). If it may take longer, run it in the background with a log (\`(npx tauri build > build.log 2>&1 &)\`) and check it with \`sleep 60; tail -20 build.log\` – never sleep longer than 60 s in one command, because the whole command must finish within the tool's 2-minute limit.
- Keep command output short: pipe builds and installs through \`2>&1 | tail -40\` (or \`grep -i error\`). Every line you print stays in the conversation and pushes out what you already know.
- Fix compile/test errors in batches, not one at a time: get the full error list once, fix every error you can see (several edit calls in the same response), then re-run the check. One-line edit, re-check, one-line edit, re-check is the slowest way to work.
- Read a file before editing it and copy oldString exactly from what you read. If an edit fails, read the file again instead of guessing.
- Work inside the project folder. If the working directory contains several projects, cd into the one the user means.
- Do not guess documentation URLs (each wrong guess is a 404 and a wasted step). The exact docs for the installed versions are already in the project: \`node_modules/<package>/\` (README, \`*.d.ts\` types, JSON schemas). Tauri config: \`node_modules/@tauri-apps/cli/config.schema.json\` and \`src-tauri/gen/schemas/\`; Rust crates: \`~/.cargo/registry/src/*/<crate>-<version>/\`. Search them with grep. Fetch a URL only if the user gave it or a file links to it.
- When the same error comes back twice, stop and find the cause in the actual error output before changing more code. Do not delete user files or reinstall everything to get past an error.
- After changing code, build or run the tests and check the result before saying it works.
- For an app with a window, "it built and the process started" is not "it works". A blank or black window means a JavaScript error at startup. Read it without relaunching the app: after \`npm run build\`, run \`node <app-debugging skill folder>/scripts/cdp-console.cjs --dist ./dist\` (load the app-debugging skill for the path). It opens the built frontend in a headless browser and prints the exception. Fix that error first, then check again until the page has content.
- Dependencies: add with the package manager (\`cargo add <crate>\`, \`npm install <pkg>\`), never write versions from memory. Unsure of a crate's API? Read its source in \`~/.cargo/registry/src/*/<crate>-<version>/\`.
- Frameworks: use the official scaffolder with its no-prompt flags (\`npm create tauri-app@latest app -- --template vanilla --manager npm --yes\`, \`cargo tauri init --ci\`; a prompt would hang the shell) and keep its layout (\`src-tauri/\`). Do not hand-write \`tauri.conf.json\` or icons, and do not create copies in other folders.
- Re-read the exact lines before editing a file you changed or have not seen recently. Fix all errors of one region in one edit.
- Keep reasoning short. Write a large file in several smaller write/edit calls, not one (output-token limit per reply).
- While iterating, build in debug (\`cargo build\`, \`npm run dev\`); a release build (\`cargo build --release\`, \`tauri build\`) only once at the end, e.g. for the copy to the Desktop. A Tauri release build alone takes minutes.
- To start an app or dev server just run it (\`cargo run\`, \`npm run dev\`, \`./app.exe\`): czek-guard starts it in the background, returns its first output and keeps it running. Never add \`&\`, \`sleep\` or \`timeout\` around it and never run it again only to see output; read the log file the note names.
- You can SEE a running desktop app with the \`look\` tool: it screenshots the app window and a vision model describes the layout and every visible problem. After any change to a GUI (native/egui, Tauri, Electron), start the app and call \`look\` with a concrete question about what you changed and what the user complained about ("Is the album cover overlapping the text? Does the track list fill the window? Does pressing play show a playing state?"). Fix what it reports and look again. Never say a GUI works, and never copy it to the user, without having looked at it.
- Images the user sends reach you as text: the image is saved in the project (\`.czek/obrazky/…\`, path given) and a vision model describes it. Use the saved file when the task needs the image itself (e.g. as an asset in the app).

## Self-check with the reviewer
- After a non-trivial change or a finished feature, before telling the user it is done, use the task tool with subagent_type "reviewer" to have an independent model check your work. Give it the request, the files you changed, and what to verify.
- Fix everything the reviewer reports as FAIL, then you may re-check.
- For important or risky work, launch BOTH "reviewer" and "reviewer-alt" in a single message (two task calls) so two different models check in parallel; reconcile their findings.
- Do not call the reviewer for tiny edits (typos, one-line fixes).
`;

// Počítač a uživatel (main.js → o.sysInfo). Živý záznam 14. 11.: model volal neexistující nástroj „ls“ a o
// uživateli nevěděl nic (uživatel: „model nemá kontext o systému … nedostalo kontext o uživateli“).
// Údaje se za běhu nemění → stejný text v každém dotazu (cache u poskytovatele).
const SYSTEM_FILE = () => path.join(CONFIG_DIR(), 'czek-system.md');
function systemContext(i) {
  const L = ['# This computer and its user (detected by czek-ai)'];
  if (i.os) L.push(`- OS: ${i.os}. A Windows path like C:\\Users\\x is /c/Users/x inside the bash tool.`);
  if (i.shell) L.push(`- The bash tool runs Git Bash (${i.shell}): ls, cat, grep, find, sed, curl work. PowerShell and cmd syntax do not.`);
  L.push('- There is no `ls` or `list` tool. List files with the glob tool or with `ls` in the bash tool.');
  if (i.user) L.push(`- User: Windows account "${i.user}", home ${i.home} (~ in bash).`);
  const dirs = [['Desktop', i.desktop], ['Documents', i.documents], ['Downloads', i.downloads]].filter(([, d]) => d);
  if (dirs.length) L.push(`- User folders: ${dirs.map(([n, d]) => `${n} ${d}`).join(', ')}.`);
  if (i.locale) L.push(`- System language: ${i.locale}. Reply in the language the user writes in.`);
  if (i.tools?.length) L.push(`- Installed command-line tools: ${i.tools.join(', ')}.`);
  return L.join('\n') + '\n';
}

// Značka, že snapshot:false zapsala Zdarma (ne uživatel) – aby šlo nastavení zase vrátit.
const SNAP_MARK = () => path.join(CONFIG_DIR(), 'opencode.zdarma-snapshot');

function applySnapshot(cfg, off) {
  const mark = SNAP_MARK();
  if (off) {
    if (cfg.snapshot === undefined) {
      cfg.snapshot = false;
      fs.mkdirSync(CONFIG_DIR(), { recursive: true });
      fs.writeFileSync(mark, 'snapshot:false zapsala Zdarma, protože domovská složka je git repozitář\n');
    }
    return;
  }
  if (fs.existsSync(mark)) {
    if (cfg.snapshot === false) delete cfg.snapshot;
    fs.unlinkSync(mark);
  }
}


// czek-guard: plugin proti smyčkám a drobení editů (src/guard). Kopíruje se vedle konfigurace OpenCode
// a zapíše do "plugin"; o.guard === false ho odebere.
const GUARD_DIR = () => path.join(CONFIG_DIR(), 'plugins', 'czek-guard');
function installGuard() {
  const src = path.join(__dirname, 'guard');
  const dst = GUARD_DIR();
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['index.mjs', 'guard-core.mjs', 'autocheck.mjs', 'search.mjs', 'launch.mjs', 'look.mjs', 'look.ps1']) {
    const body = fs.readFileSync(path.join(src, f), 'utf8');
    let cur = null;
    try { cur = fs.readFileSync(path.join(dst, f), 'utf8'); } catch {}
    if (cur !== body) fs.writeFileSync(path.join(dst, f), body);
  }
  return path.join(dst, 'index.mjs').split(path.sep).join('/');
}
// Chytré zkracování kontextu: hotový plugin Dynamic Context Pruning (@tarquinen/opencode-dcp, AGPL-3.0,
// instaluje si ho OpenCode sám z npm; verze je připnutá). Průběžně zahazuje zastaralé a duplicitní výstupy
// nástrojů, takže kontext neroste na 150k tokenů a přepnutí na model s menším kontextem neselže.
// o.dcp === false ho odebere.
const DCP = '@tarquinen/opencode-dcp@3.2.0';
function applyDcp(cfg, on) {
  const isDcp = (p) => String(Array.isArray(p) ? p[0] : p).includes('opencode-dcp');
  const list = Array.isArray(cfg.plugin) ? cfg.plugin.filter((p) => !isDcp(p)) : [];
  if (on) list.push(DCP);
  if (list.length) cfg.plugin = list; else delete cfg.plugin;
}
// Seznam úkolů (nástroj todowrite) vypnutý. Živě 13. 11.: model ho zavolal jednou na začátku úkolu
// (1 rozpracovaný, 5 čekajících) a za 599 kroků už nikdy; OpenCode pak u relace pořád ukazoval
// „0 of 6 todos completed“ a smazat seznam jinak než tímto nástrojem nejde (API má jen GET). Popis nástroje
// navíc stojí ~750 tokenů v každém kroku. o.todo === true ho vrátí.
function applyTodo(cfg, on) {
  const t = cfg.tools && typeof cfg.tools === 'object' ? { ...cfg.tools } : {};
  if (on) { if (t.todowrite === false) delete t.todowrite; } else t.todowrite = false;
  if (Object.keys(t).length) cfg.tools = t; else delete cfg.tools;
}

// Poskytovatelé připojení přímo v OpenCode (auth.json), jejichž klíč už má OmniRoute: v OpenCode skrytí,
// aby šlo všechno přes OmniRoute (záloha při 429/529, rozložení zátěže). Živě 13. 11.: 42 z 52 kroků šlo
// přímo na zai/glm-4.5-flash a 529 „overloaded“ dostal uživatel rovnou. Které jsme skryli my, je v souboru
// vedle konfigurace (OpenCode nesnese v configu neznámé klíče), aby šly zase vrátit.
// Kontroloví subagenti (jen čtení): primární agent je zavolá nástrojem task a nechá práci nezávisle zkontrolovat.
// reviewer = silný model, reviewer-alt = druhý model route (křížová kontrola).
function reviewerAgents(strong, alt) {
  const prompt = 'You are a strict, independent code reviewer. You did NOT write this code. Check: does it meet the request, is it correct, will it build/run, are there bugs, unsafe or missed cases, broken edits? Be concise. Reply with "PASS" if it is correct, otherwise "FAIL" and a short numbered list of concrete problems with file:line and the fix. Do not rewrite the code yourself.';
  // reviewer nesmí měnit kód (edit/write deny); bash smí – spustí build/testy, a v bezdialogovém režimu nevyskočí okno
  const permission = { edit: 'deny', write: 'deny', bash: 'allow' };
  return {
    reviewer: { mode: 'subagent', description: 'Independent reviewer on a strong model. Use after a non-trivial change or finished feature to verify correctness before saying done.', model: strong, prompt, permission, steps: 12 },
    'reviewer-alt': { mode: 'subagent', description: 'Second independent reviewer on a different model route, for cross-checking important work.', model: alt, prompt, permission, steps: 12 },
  };
}
// Zapne nebo vypne kontroloví subagenty; ostatní agenty (compaction) nechá.
function applyReviewers(cfg, on, strong, alt) {
  if (on) { cfg.agent = { ...(cfg.agent || {}), ...reviewerAgents(strong, alt) }; return; }
  if (!cfg.agent) return;
  delete cfg.agent.reviewer;
  delete cfg.agent['reviewer-alt'];
  if (!Object.keys(cfg.agent).length) delete cfg.agent;
}
const ROUTED_FILE = () => path.join(CONFIG_DIR(), 'opencode.zdarma-routed.json');
function applyRouted(cfg, ids) {
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(ROUTED_FILE(), 'utf8')); } catch {}
  const dis = new Set(Array.isArray(cfg.disabled_providers) ? cfg.disabled_providers : []);
  for (const id of prev) dis.delete(id);
  const now = (ids || []).filter((id) => id && !String(id).includes('omniroute'));
  for (const id of now) dis.add(id);
  if (dis.size) cfg.disabled_providers = [...dis]; else delete cfg.disabled_providers;
  try {
    if (now.length) { fs.mkdirSync(CONFIG_DIR(), { recursive: true }); fs.writeFileSync(ROUTED_FILE(), JSON.stringify(now)); }
    else fs.rmSync(ROUTED_FILE(), { force: true });
  } catch {}
  // vybraný model u skrytého poskytovatele → zpět na auto/coding
  const hidden = (v) => typeof v === 'string' && now.some((id) => v.startsWith(id + '/'));
  if (hidden(cfg.model)) cfg.model = DEFAULT_MODEL;
  if (hidden(cfg.small_model)) cfg.small_model = SMALL_MODEL;
}

function applyGuard(cfg, on) {
  const isGuard = (p) => String(Array.isArray(p) ? p[0] : p).includes('czek-guard');
  const list = Array.isArray(cfg.plugin) ? cfg.plugin.filter((p) => !isGuard(p)) : [];
  if (on) list.push(installGuard());
  if (list.length) cfg.plugin = list; else delete cfg.plugin;
}

/**
 * Sloučí blok do existující konfigurace (ostatní obsah zachová, zálohu uloží jako .bak).
 * @returns {{file: string, changed: boolean}}
 */
function writeConfig(port, models, o = {}) {
  const file = CONFIG_FILE();
  const cfg = readConfig();
  const before = JSON.stringify(cfg);
  cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
  const onlyZdarma = JSON.stringify(cfg.enabled_providers) === JSON.stringify(['zdarma']);
  let authChanged = false;

  if (o.omniUrl && o.omniKey) {
    // Přímé napojení OpenCode → OmniRoute přes oficiální @omniroute/opencode-plugin.
    // V nabídce jsou sjednocené modely (lkgp combo napříč poskytovateli), tierlisty a auto/coding;
    // surové duplicity jednotlivých poskytovatelů jsou skryté (pokud není onlyTiers === false).
    const entry = installOmniPlugin(o.pluginSrc);
    authChanged = writeOmniAuth(o.omniUrl, o.omniKey);
    // Disková cache katalogu = jediná záloha pluginu, když /v1/models při vzniku instance nestihne odpovědět
    // (bez ní instance zůstane bez modelů, „No model results“, 13. 11.). Mazat jen při změně modelů (klíče).
    if (o.freshModels) clearOmniPluginCache();
    const plugOpts = {
      providerId: 'omniroute',
      baseURL: o.omniUrl,
      ...(o.onlyTiers === false ? {} : { features: { visibleModels: leanVisible(o) } }),
    };
    const plugins = Array.isArray(cfg.plugin) ? cfg.plugin.filter((p) => {
      if (typeof p === 'string') return !p.includes('omniroute');
      if (Array.isArray(p)) return p[1]?.providerId !== 'omniroute' && !String(p[0] || '').includes('omniroute');
      return true;
    }) : [];
    plugins.push([entry, plugOpts]);
    cfg.plugin = plugins;
    if (cfg.provider && 'zdarma' in cfg.provider) {
      delete cfg.provider.zdarma;
      if (!Object.keys(cfg.provider).length) delete cfg.provider;
    }
    if (onlyZdarma) delete cfg.enabled_providers;
    // Vestavěný poskytovatel „opencode“ (free modely Zen přímo v OpenCode) obchází OmniRoute: žádná záloha
    // při limitu ani hlídání zaseknutého streamu. 9. 11. na něm chat 69 min visel v půlce zápisu souboru
    // a OmniRoute nedostal jediný dotaz. Proto je v nabídce skrytý (o.builtinFree === true ho vrátí).
    // Poskytovatele, které si uživatel sám připojil v OpenCode, se to netýká.
    const dis = new Set(Array.isArray(cfg.disabled_providers) ? cfg.disabled_providers : []);
    if (o.builtinFree === true) dis.delete('opencode'); else dis.add('opencode');
    if (dis.size) cfg.disabled_providers = [...dis]; else delete cfg.disabled_providers;
    applyRouted(cfg, o.routed);
    const isOurs = (v) => !v || /^(zdarma|omniroute)\//.test(v) || (o.builtinFree !== true && /^opencode\//.test(v));
    if (isOurs(cfg.model)) cfg.model = DEFAULT_MODEL;
    // auto/fast už v nabídce není (slabé modely); kdo ho měl vybraný, dostane výchozí model
    // dřívější výchozí auto/coding a auto/fast (už není v nabídce) → tier Max
    if (cfg.model === 'opencode-omniroute/auto/fast' || cfg.model === 'opencode-omniroute/auto/coding') cfg.model = DEFAULT_MODEL;
    if (isOurs(cfg.small_model) || cfg.small_model === 'opencode-omniroute/auto/fast') cfg.small_model = SMALL_MODEL;
    // kompakce: dřív vždy auto/coding (OmniRoute ho řadí sám, bez znalosti mrtvých modelů czek-ai); teď model relace
    const cm = cfg.agent?.compaction?.model;
    if (typeof cm === 'string' && (cm === 'opencode-omniroute/auto/coding' || isOurs(cm))) {
      const { model: _m, ...rest } = cfg.agent.compaction;
      cfg.agent = { ...cfg.agent, compaction: rest };
      if (!Object.keys(cfg.agent.compaction).length) delete cfg.agent.compaction;
      if (!Object.keys(cfg.agent).length) delete cfg.agent;
    }
    // Plugin OmniRoute dává agentovi nástroj omniroute_sync_models (obnova katalogu). Modely spravuje czek-ai,
    // agentovi nástroj jen přidává ~1 kB popisu do každého kroku a lákadlo k volání mimo úkol. Volbu uživatele nechá.
    // Kontroloví subagenti na silných routách OmniRoute (o.reviewer === false je vypne)
    applyReviewers(cfg, o.reviewer !== false, DEFAULT_MODEL, 'opencode-omniroute/zdarma-high');
    if (!cfg.tools || cfg.tools.omniroute_sync_models === undefined) cfg.tools = { ...(cfg.tools || {}), omniroute_sync_models: false };
  } else {
    const block = providerBlock(port, models, o);
    cfg.provider = { ...(cfg.provider || {}), zdarma: block };
    // Výchozí model: tierlist Max – nejsilnější modely první, po vyčerpání záložní High → Mid → Low
    // (pro názvy relací Low). Přepíše jen prázdnou hodnotu nebo model Zdarmy, který už v nabídce není
    // (např. dřívější zdarma/auto); vlastní volbu uživatele nechá. o.migrateDefault: jednorázově přepnout
    // dřívější výchozí zdarma/high (nastavila ho Zdarma do 0.9.1, ne uživatel) na Max.
    const stale = (v) => !v || (/^zdarma\//.test(v) && !(v.slice(7) in block.models));
    const first = Object.keys(block.models)[0];
    const best = 'max' in block.models ? 'zdarma/max' : 'high' in block.models ? 'zdarma/high' : `zdarma/${first || 'auto'}`;
    if (stale(cfg.model) || (o.migrateDefault && cfg.model === 'zdarma/high')) cfg.model = best;
    if (stale(cfg.small_model)) cfg.small_model = 'low' in block.models ? 'zdarma/low' : cfg.model;
    // „Jen tierlisty“: v nabídce OpenCode jen poskytovatel Zdarma (skryje vestavěné modely OpenCode).
    // enabled_providers ["zdarma"] skryje v OpenCode i jeho dialog „Připojit poskytovatele“ (seznam webů,
    // Z.AI…). S o.ocProviders (výchozí ve Zdarmě) se omezení nepíše: tierlisty Zdarmy zůstanou bez
    // jednotlivých modelů a vedle nich jde v OpenCode připojit další poskytovatele po svém.
    if (o.onlyTiers !== false && Array.isArray(o.tiers) && !o.ocProviders) cfg.enabled_providers = ['zdarma'];
    else if (onlyZdarma) delete cfg.enabled_providers;
    // Kontroloví subagenti na silných modelech Zdarmy (silný = Max, alt = High; jinak totéž)
    const strong = 'max' in block.models ? 'zdarma/max' : best;
    applyReviewers(cfg, o.reviewer !== false, strong, 'high' in block.models ? 'zdarma/high' : strong);
    if ('max' in block.models && !cfg.agent?.compaction?.model) {
      cfg.agent = { ...(cfg.agent || {}), compaction: { ...(cfg.agent?.compaction || {}), model: 'zdarma/max' } };
    }
  }

  // Starší výstupy nástrojů (čtení souborů, výpisy příkazů) průběžně zahazovat – OpenCode to má ve
  // výchozím stavu vypnuté a agent pak v každém kroku posílá celou historii (163–177k tokenů, 8. 11.).
  // Vlastní nastavení uživatele se nemění.
  if (cfg.compaction === undefined) cfg.compaction = { auto: true, prune: true };
  applyFullAuto(cfg, !!o.fullAuto, o.todo === true);
  applySkills(cfg, o.skillsAllow);
  applySnapshot(cfg, o.snapshotOff ?? !!homeInGit());
  applyGuard(cfg, o.guard !== false);
  applyDcp(cfg, o.dcp !== false);
  applyTodo(cfg, o.todo === true);
  // Pokyny pro agenta (soubor vedle konfigurace, cesta v "instructions"); o.agentTips === false = vypnuto
  const tips = AGENT_TIPS_FILE();
  const list = Array.isArray(cfg.instructions) ? cfg.instructions.filter((x) => x !== tips) : [];
  if (o.agentTips !== false) {
    fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    let cur = null;
    try { cur = fs.readFileSync(tips, 'utf8'); } catch {}
    if (cur !== AGENT_TIPS) fs.writeFileSync(tips, AGENT_TIPS);
    list.push(tips);
  }
  // počítač a uživatel (o.sysInfo z main.js; bez něj, např. v testech, nic)
  const sysf = SYSTEM_FILE();
  const si = list.indexOf(sysf);
  if (si >= 0) list.splice(si, 1);
  if (o.sysInfo) {
    const text = systemContext(o.sysInfo);
    let cur = null;
    try { cur = fs.readFileSync(sysf, 'utf8'); } catch {}
    fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    if (cur !== text) fs.writeFileSync(sysf, text);
    list.push(sysf);
  }
  // pracovní postup + směrovač skills trvale zapnutý (o.method !== false a přibalený skill existuje)
  const meth = METHOD_FILE();
  const mi = list.indexOf(meth);
  if (mi >= 0) list.splice(mi, 1);
  if (o.method !== false && o.methodSkill && fs.existsSync(o.methodSkill)) {
    const text = methodInstructions(o.methodSkill);
    let cur = null;
    try { cur = fs.readFileSync(meth, 'utf8'); } catch {}
    fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    if (cur !== text) fs.writeFileSync(meth, text);
    list.push(meth);
  } else {
    try { fs.rmSync(meth, { force: true }); } catch {}
  }
  // caveman trvale zapnutý (o.caveman !== false a přibalený skill existuje)
  const cave = CAVEMAN_FILE();
  const li = list.indexOf(cave);
  if (li >= 0) list.splice(li, 1);
  if (o.caveman !== false && o.cavemanSkill && fs.existsSync(o.cavemanSkill)) {
    const text = cavemanInstructions(o.cavemanSkill);
    let cur = null;
    try { cur = fs.readFileSync(cave, 'utf8'); } catch {}
    fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    if (cur !== text) fs.writeFileSync(cave, text);
    list.push(cave);
  } else {
    try { fs.rmSync(cave, { force: true }); } catch {}
  }
  if (list.length) cfg.instructions = list; else delete cfg.instructions;
  const restored = readConfig.restored;
  readConfig.restored = null;
  const changed = JSON.stringify(cfg) !== before || !!restored;
  if (changed) {
    fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    // po obnově ze zálohy .bak nepřepisovat (rozbitý originál je v .broken)
    if (fs.existsSync(file) && !restored) fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return { file, changed: changed || authChanged };
}

function isConfigured(port, omniUrl) {
  try {
    const cfg = readConfig();
    if (omniUrl) return Array.isArray(cfg?.plugin) && cfg.plugin.some((p) => Array.isArray(p) && p[1]?.providerId === 'omniroute' && p[1]?.baseURL === omniUrl);
    if (Array.isArray(cfg?.plugin) && cfg.plugin.some((p) => Array.isArray(p) && p[1]?.providerId === 'omniroute')) return true;
    return cfg?.provider?.zdarma?.options?.baseURL === `http://127.0.0.1:${port}/v1`;
  } catch { return false; }
}

module.exports = { AUTO_CONTEXT, COMBO_OUTPUT, DEFAULT_MODEL, SMALL_MODEL, writeConfig, isConfigured, installOmniPlugin, writeOmniAuth, clearOmniPluginCache, providerBlock, modelEntries, tierEntries, unitedEntries, leanVisible, provenModelKeys, CONFIG_FILE, AUTH_FILE, PLUGIN_DIR, FULL_AUTO, PERM_BACKUP, homeInGit, SNAP_MARK, AGENT_TIPS, AGENT_TIPS_FILE, GUARD_DIR, ROUTED_FILE, CAVEMAN_FILE, cavemanInstructions, METHOD_FILE, methodInstructions, SYSTEM_FILE, systemContext };
