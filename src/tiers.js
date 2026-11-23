'use strict';
// Tierlisty modelů: Max / High / Mid / Low (+ Unfiltered) a vlastní. Tierlist je seřazený seznam modelů;
// při limitu nebo chybě se bere další model v pořadí, po vyčerpání celého tierlistu jeho záložní tierlist.
// Vestavěné tierlisty se plní automaticky podle síly modelu, dokud je uživatel neupraví.

const I18N = require('./i18n'); // popisy tierlistů v jazyce aplikace
const { scoreModel } = require('./providers');
const BUILTIN = [
  { id: 'max', name: 'Max', desc: 'nejsilnější free modely', fallback: 'high' },
  { id: 'high', name: 'High', desc: 'silné modely', fallback: 'mid' },
  { id: 'mid', name: 'Mid', desc: 'střední modely', fallback: 'low' },
  { id: 'low', name: 'Low', desc: 'malé a rychlé modely', fallback: 'mid' }, // radši silnější model než chyba
  // modely bez denního limitu a kreditů (Z.ai GLM Flash): záchrana, když všude jinde dojde limit
  { id: 'unlimited', name: 'Unlimited', desc: 'bez denního limitu', fallback: 'max' }, // Z.ai přetížený (529) → zkusit ostatní tierlisty, ne skončit chybou,
  { id: 'unfiltered', name: 'Unfiltered', desc: 'necenzurované modely', fallback: null },
];
const STRENGTH = ['max', 'high', 'mid', 'low'];

// Pořadí pravidel je důležité: konkrétní rodiny modelů přebijí odhad podle velikosti.
const RULES = [
  // …270m = miliony parametrů (gemma3-270m), laguna-xs = extra small
  ['low', /flash-lite|nano|tiny|instant|ministral|gemma-?3n|-1b\b|-3b\b|phi-4-mini|gpt-4\.1-nano|gpt-5-nano|(?<![a-z\d.])\d{2,3}m\b|-xs\b/],
  ['high', /glm[-_.]?[0-9.]+v?-flash/], // GLM Flash = menší varianty
  // Modely změřené na úlohách agenta už tu ruční pravidla nemají (dřív glyph-cluster, beam, Gemini 3.x Flash, ERNIE,
  // particle-1): o tieru Max rozhoduje měření (src/evidence.js, classify níž), které vyprší po 45 dnech.
  ['max', /deepseek[-_.]?(v3|v4|r1(?!-distill)|chat|r1t)|kimi[-_]?k[23]|glm[-_.]?(4\.5(?!-air)|4\.6|4\.7|5)|qwen-?3?-?coder.*480|qwen-?3-?coder(?!.*(30b|14b|7b|flash))|235b|253b|405b|480b|671b|gpt-oss-120b|gemini-(2\.5|3)(\.\d)?-pro|mistral-large|devstral-(medium|large)|magistral-medium|nemotron.*ultra|minimax[-_]?m[12]|grok-(3|4)(?!-mini)|claude|big-pickle|\bgpt-5(?!-(mini|nano))|\bgpt-4\.1(?!-(mini|nano))|\bgpt-4o(?!-mini)|\bo3(?!-mini)\b|\bo4(?!-mini)\b/],
  // Jednociferné miliardy (llama-3.1-8b, qwen2.5-coder-7b) jsou malé i ze starší generace – před pravidlem níž.
  // Ne „a3b“: to je aktivní část velkého MoE (qwen3-30b-a3b).
  ['low', /(?<![a-z\d.])[1-9](\.\d)?b\b/],
  // Starší generace / ne-agentní modely: velké, ale v agentní práci (nástroje, víc kroků) slabé.
  // Podle usage.json uživatele 7. 11. 2026 nesly nejvíc skutečné práce v High (Llama 3.3 70B 39×,
  // Codestral 23×) – OVH je píše „Meta-Llama-3_3-70B“, takže dřív propadly do High podle velikosti.
  ['mid', /llama[-_]?3|llama-?4-(scout|maverick)|\bscout\b|maverick|qwen-?2(\.5)?[-_]|qwen2\b|mixtral|codestral|distill-llama|hermes-[34]-/],
  ['high', /glm-4\.5-air|qwen-?3-32b|qwen-?3-30b|coder.*30b|devstral|gemini-(2\.5|3)(\.\d)?-flash|mistral-medium|command-a|gpt-4\.1-mini|gpt-5-mini|o3-mini|o4-mini|grok-3-mini|nemotron.*super|minimax[-_]?m3/],
  ['mid', /gpt-oss-20b|openai-fast|gemma-?3-27b|gemma-?4|mistral-small|magistral-small|qwen.*14b|phi-4|gpt-4o-mini|nemotron-nano/],
  // [78]b jen jako samostatné číslo – dřív „7b“ chytalo i 27b (Qwen 3.6/3.8 27B padaly do Low)
  ['low', /mini|small|lite|\b[1-9]b\b|-[1-9]b|:[1-9]b|(?<![\d.])[78]b\b/],
];

// Známý kontext podle rodiny modelu – pro poskytovatele, kteří ho v seznamu modelů neposílají
// (Gemini přes OpenAI rozhraní, NVIDIA, Cerebras, Pollinations…). Údaj od poskytovatele má vždy přednost.
const KNOWN_CTX = [
  [/gemini-(1\.5|2|3|4|flash|pro|omni)/, 1048576],
  [/gpt-4\.1(?!-nano)|gpt-5/, 1000000],
  [/kimi[-_]?k[23]/, 262144],
  [/codestral|devstral/, 256000],
  [/glm[-_.]?(4\.6|4\.7|5)|claude|minimax[-_]?m[23]/, 200000],
  [/deepseek/, 128000],
  [/gpt-oss|openai-fast|llama-3\.[1-3]|llama-4|qwen-?3|qwen2\.5|mistral-(large|medium|small)|magistral|ministral|nemotron|gemma-?3(?!-1b|n)|gemma-?4|glm[-_.]?4\.5|command-a|phi-3|jamba|granite-?4/, 131072],
  [/phi-4/, 16384],
];

/** Kontext modelu: od poskytovatele, jinak známá hodnota rodiny, jinak null. */
function knownContext(m) {
  if (!m) return null;
  if (m.context) return m.context;
  const id = `${m.id} ${m.name || ''}`.toLowerCase();
  for (const [re, ctx] of KNOWN_CTX) if (re.test(id)) return ctx;
  return null;
}

/**
 * Kontextový limit tierlistu pro OpenCode: medián známých kontextů prvních modelů (půlka z nich ho zvládne).
 * Bezpečné i pro menší modely v tierlistu – proxy model, kterému by konverzace nevešla, přeskočí.
 *
 * Strop AUTO_CTX_MAX: OpenCode konverzaci zkrátí (compaction) až těsně pod tímto limitem. S limitem
 * 262k posílal agent v projektu uživatele 163–177k tokenů v KAŽDÉM kroku (8. 11. 2026, call_logs) –
 * plýtvání limity a free modely s tak dlouhým kontextem znatelně hloupnou. Ruční hodnota v editoru
 * tierlistu strop nemá.
 */
const AUTO_CTX_MAX = 96000;
function tierContext(keys, models) {
  const byKey = new Map((models || []).map((m) => [m.key, m]));
  const ctxs = keys.slice(0, 8).map((k) => knownContext(byKey.get(k))).filter(Boolean).sort((a, b) => a - b);
  if (!ctxs.length) return 32000;
  return Math.max(16000, Math.min(AUTO_CTX_MAX, ctxs[Math.floor((ctxs.length - 1) / 2)]));
}

/** Odhad velikosti v miliardách parametrů (u MoE celková velikost, ne aktivní "a22b"). */
function sizeB(id) {
  const m = /(?<![a-z\d.])(\d+(?:\.\d+)?)b(?![a-z])/i.exec(id);
  return m ? Number(m[1]) : null;
}

/** Model bez denního limitu a bez kreditů. Z.ai: GLM-4.7-Flash, GLM-4.5-Flash a GLM-4.6V-Flash mají v ceníku 0 $ a žádný strop (jen 1 souběžný požadavek). */
const isUnlimited = (m) => m.unlimited === true || (m.provider === 'zai' && /flash/i.test(m.id));

/** Do kterého vestavěného tierlistu model patří podle síly. */
// Ověřený měřením (src/model-evidence.json) = tier Max bez ohledu na název. Načte se jednou (soubor je v balíčku appky).
let proven = null;
const isProven = (id) => (proven ||= require('./evidence').matcher(require('./evidence').load())).test(id);

function classify(m) {
  const id = `${m.id} ${m.name || ''}`.toLowerCase();
  if (isProven(id)) return 'max';
  for (const [tier, re] of RULES) if (re.test(id)) return tier;
  const s = sizeB(id);
  if (s != null) return s >= 200 ? 'max' : s >= 60 ? 'high' : s >= 14 ? 'mid' : 'low';
  return 'mid';
}

/** Definice všech tierlistů: vestavěné (s úpravami uživatele) + vlastní. */
function tierDefs(settings) {
  const st = settings.tiers || {};
  const defs = BUILTIN.map((b) => {
    const o = st[b.id] || {};
    return { ...b, desc: I18N.t('tier.' + b.id), builtIn: true, models: Array.isArray(o.models) ? o.models : null, fallback: 'fallback' in o ? o.fallback : b.fallback, contextOverride: o.context || null };
  });
  for (const [id, o] of Object.entries(st)) {
    if (!o?.custom || BUILTIN.some((b) => b.id === id)) continue;
    defs.push({ id, name: String(o.name || id).slice(0, 40), desc: I18N.t('tier.custom'), builtIn: false, custom: true, models: Array.isArray(o.models) ? o.models : [], fallback: o.fallback || null, contextOverride: o.context || null });
  }
  return defs;
}

const isTier = (id, settings) => tierDefs(settings).some((d) => d.id === id);

/** Automatické pořadí vestavěného tierlistu (pořadí jako režim Auto: oblíbené, skóre, prokládání poskytovatelů). */
function autoKeys(def, models, registry) {
  if (def.id === 'unfiltered') return registry.autoOrder(models, true).map((m) => m.key);
  if (def.id === 'unlimited') return registry.autoOrder(models.filter(isUnlimited), false).map((m) => m.key);
  if (!STRENGTH.includes(def.id)) return [];
  return registry.autoOrder(models.filter((m) => classify(m) === def.id), false).map((m) => m.key);
}

/** Klíče modelů tierlistu v pořadí (ručně upravený seznam, nebo automatický). */
function tierKeys(def, models, registry) {
  return def.models ? def.models.slice() : autoKeys(def, models, registry);
}

/**
 * Celé pořadí pro požadavek na tierlist: jeho modely, potom záložní tierlisty (bez cyklů).
 * Vrací objekty modelů, které Zdarma teď opravdu má (ručně přidaný model, který zmizel, se přeskočí).
 */
function order(id, models, settings, registry) {
  const defs = tierDefs(settings);
  const byKey = new Map(models.filter((m) => m.usable).map((m) => [m.key, m]));
  const out = [];
  const seenTier = new Set();
  const seenModel = new Set();
  let cur = defs.find((d) => d.id === id);
  while (cur && !seenTier.has(cur.id)) {
    seenTier.add(cur.id);
    for (const k of tierKeys(cur, models, registry)) {
      const m = byKey.get(k);
      if (m && !seenModel.has(k)) { seenModel.add(k); out.push({ ...m, tier: cur.id }); }
    }
    cur = cur.fallback ? defs.find((d) => d.id === cur.fallback) : null;
  }
  // úplně na konec modely bez limitu: když dojdou kredity a limity všude jinde, požadavek neselže
  const unl = defs.find((d) => d.id === 'unlimited');
  if (unl && id !== 'unfiltered' && !seenTier.has('unlimited')) {
    for (const k of tierKeys(unl, models, registry)) {
      const m = byKey.get(k);
      if (m && !seenModel.has(k)) { seenModel.add(k); out.push({ ...m, tier: 'unlimited' }); }
    }
  }
  return out;
}

/** Přehled pro UI: tierlisty s aktuálními modely. */
function overview(models, settings, registry) {
  return tierDefs(settings).map((d) => {
    const keys = tierKeys(d, models, registry);
    // automatický limit z modelů, které se opravdu použijí (vlastní, po nich záložní tierlisty)
    const contextAuto = tierContext(order(d.id, models, settings, registry).map((m) => m.key), models);
    return { ...d, auto: !d.models, keys, contextAuto, context: d.contextOverride || contextAuto };
  });
}

/** Kontrola dat z UI před uložením do nastavení. */
function sanitize(input) {
  const out = {};
  const ids = new Set(BUILTIN.map((b) => b.id));
  for (const [id, o] of Object.entries(input || {})) {
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !o || typeof o !== 'object') continue;
    const custom = !ids.has(id);
    const t = {};
    if (custom) { t.custom = true; t.name = String(o.name || 'Vlastní').trim().slice(0, 40) || 'Vlastní'; }
    if (Array.isArray(o.models)) t.models = [...new Set(o.models.filter((k) => typeof k === 'string' && k.length < 300))].slice(0, 200);
    else if (custom) t.models = [];
    if ('fallback' in o) t.fallback = typeof o.fallback === 'string' && o.fallback !== id ? o.fallback : null;
    if (o.context != null && o.context !== '') {
      const n = Math.round(Number(o.context));
      if (Number.isFinite(n) && n >= 4000 && n <= 2000000) t.context = n; // jinak automaticky
    }
    out[id] = t;
  }
  return out;
}

// ---------------------------------------------------------------- sjednocení stejných modelů napříč poskytovateli

const SPECIAL_MODELS = [
  [/^(openai-fast)$/, 'gpt-oss-20b', 'GPT-OSS 20B'],
  [/(kilo-auto\/free|openrouter\/free|orcarouter\/free|^auto:free$)/i, 'free-router', 'Free Models Router'],
  [/(^|\/)(beam-free|beam|beam-1\.0-501b-a23b)(:free)?$/i, 'beam-1-0', 'Beam 1.0 501B'],
  [/glyph-cluster/i, 'glyph-cluster', 'Glyph Cluster'],
  [/big-pickle/i, 'big-pickle', 'Big Pickle'],
  [/(flint-40b|flint-v1\.0)/i, 'flint-40b', 'Flint 40B'],
  [/nemotron-3\.5-lightning/i, 'nemotron-3-5-lightning', 'Nemotron 3.5 Lightning'],
  [/nemotron-3\.5-super-vl/i, 'nemotron-3-5-super-vl', 'Nemotron 3.5 Super VL 120B'],
  [/nemotron-3-ultra-550b/i, 'nemotron-3-ultra-550b', 'Nemotron 3 Ultra 550B'],
  [/nemotron-3-(?:super-)?120b/i, 'nemotron-3-super-120b', 'Nemotron 3 Super 120B'],
  [/nemotron-3-nano-omni-30b/i, 'nemotron-3-nano-omni-30b', 'Nemotron 3 Nano Omni 30B'],
  [/nemotron-(?:nano-3|3-nano)[:\-]30b/i, 'nemotron-3-nano-30b', 'Nemotron 3 Nano 30B'],
  [/kimi-k3(\.1-pro)?$/i, 'kimi-k3', 'Kimi K3 / K3.1 Pro'],
  [/kimi-k2\.7-code/i, 'kimi-k2-7-code', 'Kimi K2.7 Code'],
  [/kimi-k2\.6/i, 'kimi-k2-6', 'Kimi K2.6'],
  [/kimi-k2\.5/i, 'kimi-k2-5', 'Kimi K2.5'],
  [/kimi-k2-instruct/i, 'kimi-k2', 'Kimi K2 Instruct'],
  [/deepseek-v4\.1-flash/i, 'deepseek-v4-1-flash', 'DeepSeek V4.1 Flash'],
  [/deepseek-v4-flash(?!-vision)/i, 'deepseek-v4-flash', 'DeepSeek V4 Flash'],
  [/deepseek-v4-pro/i, 'deepseek-v4-pro', 'DeepSeek V4 Pro'],
  [/deepseek-v3\.2/i, 'deepseek-v3-2', 'DeepSeek V3.2'],
  [/deepseek-r1(?!-distill)/i, 'deepseek-r1', 'DeepSeek R1'],
  [/glm-5\.3-flash(?!(?:x|-think|-search))/i, 'glm-5-3-flash', 'GLM 5.3 Flash'],
  [/glm-5\.3(?:-(?:bf16|fp8))?$/i, 'glm-5-3', 'GLM 5.3'],
  [/glm-5\.2/i, 'glm-5-2', 'GLM 5.2'],
  [/glm-4\.7-flash/i, 'glm-4-7-flash', 'GLM 4.7 Flash'],
  [/glm-4\.6v-flash/i, 'glm-4-6v-flash', 'GLM 4.6V Flash'],
  [/glm-4\.5-flash/i, 'glm-4-5-flash', 'GLM 4.5 Flash'],
  [/minimax-m3\.1-flash/i, 'minimax-m3-1-flash', 'MiniMax M3.1 Flash'],
  [/minimax-m3(?:-free)?$/i, 'minimax-m3', 'MiniMax M3'],
  [/mimo-v2\.6-flash/i, 'mimo-v2-6-flash', 'MiMo V2.6 Flash'],
  [/gpt-oss[:\-]120b/i, 'gpt-oss-120b', 'GPT-OSS 120B'],
  [/gpt-oss[:\-]20b/i, 'gpt-oss-20b', 'GPT-OSS 20B'],
  [/llama-3[._]3-70b/i, 'llama-3-3-70b', 'Llama 3.3 70B'],
  [/llama-4-scout/i, 'llama-4-scout', 'Llama 4 Scout'],
  [/codestral(?:-(?:latest|22b|2508|2501))?/i, 'codestral', 'Codestral'],
  [/devstral(?:-medium)?/i, 'devstral-medium', 'Devstral Medium'],
  [/mistral-large-4/i, 'mistral-large-4', 'Mistral Large 4'],
  [/mistral-large(?:-(?:2|24\d\d|25\d\d|latest|instruct))*$/i, 'mistral-large', 'Mistral Large'],
  [/mistral-medium-3[.\-]5/i, 'mistral-medium-3-5', 'Mistral Medium 3.5'],
  [/mistral-small-3[.\-]2/i, 'mistral-small-3-2', 'Mistral Small 3.2'],
  [/qwen3\.8-2\.4t/i, 'qwen3-8-2-4t', 'Qwen 3.8 2.4T'],
  [/qwen3\.5-397b/i, 'qwen3-5-397b', 'Qwen 3.5 397B'],
  [/qwen3-coder-plus/i, 'qwen3-coder-plus', 'Qwen 3 Coder Plus'],
  [/qwen3\.8-27b/i, 'qwen3-8-27b', 'Qwen 3.8 27B'],
  [/qwen3\.7-flash/i, 'qwen3-7-flash', 'Qwen 3.7 Flash'],
  [/qwen3\.6-35b/i, 'qwen3-6-35b', 'Qwen 3.6 35B'],
  [/qwen3\.6-27b/i, 'qwen3-6-27b', 'Qwen 3.6 27B'],
  [/qwen3\.5-35b/i, 'qwen3-5-35b', 'Qwen 3.5 35B'],
  [/qwen3\.5-27b/i, 'qwen3-5-27b', 'Qwen 3.5 27B'],
  [/qwen3\.5-9b/i, 'qwen3-5-9b', 'Qwen 3.5 9B'],
  [/qwen3-30b-a3b/i, 'qwen3-30b', 'Qwen 3 30B'],
  [/gemma-4-31b-it/i, 'gemma-4-31b', 'Gemma 4 31B'],
  [/gemma-4-26b(?:-(?:a4b)?(?:-it)?)?(?::free)?$/i, 'gemma-4-26b', 'Gemma 4 26B'],
  [/(?:cohere[\-\/])?command-a(?:-(?:03-2025))?(?::free)?$/i, 'command-a', 'Cohere Command A'],
];

const RESERVED_SLUGS = new Set([...BUILTIN.map((b) => b.id), 'auto', 'auto-unfiltered']);

/** Kanonický identifikátor a čitelný název modelu bez ohledu na poskytovatele ({ slug, title }). */
function canonicalModel(m) {
  const raw = String(m?.id || '').trim();
  const base = raw.replace(/:free$/i, '').replace(/-free$/i, '');
  for (const [re, slug, title] of SPECIAL_MODELS) {
    if (re.test(raw) || re.test(base)) return { slug, title };
  }
  let s = base.split('/').pop() || raw;
  s = s.replace(/^(meta|nvidia)-/i, '')
    .replace(/[_:]+/g, '-')
    .replace(/-(instruct|it|fp8|fp8-fast|bf16|nvfp4|awq|v0\.\d+|v1\.\d+|latest|free|rl)\b/gi, '')
    .replace(/-a\d+b\b/gi, '')
    .replace(/-(?:202\d-?)?(?:0[1-9]|1[0-2])(?:[0-3]\d)?$/g, '');
  let slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  if (RESERVED_SLUGS.has(slug)) slug = 'model-' + slug;
  const title = s.replace(/-/g, ' ')
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Glm|Gpt|Oss|Vl|Lfm|R1|V2|V3|V4|Ai|It|Moe|Qwq)\b/gi, (w) => w.toUpperCase())
    .replace(/\b(\d+)b\b/gi, '$1B');
  return { slug, title: title || raw };
}

/**
 * Sjednotí stejné modely napříč poskytovateli do jedné položky na model.
 * U každého sjednoceného modelu drží seznam aktivních poskytovatelů (`usable`) i těch, které odemkne klíč (`locked`).
 */
function uniteModels(models, settings = {}, registry = null) {
  const fav = new Set(settings.favorites || []);
  const bySlug = new Map();
  for (const m of models || []) {
    if (!m?.id || m.provider === 'horde') continue;
    const { slug, title } = canonicalModel(m);
    let g = bySlug.get(slug);
    if (!g) {
      g = { slug, title, byProvUsable: new Map(), byProvLocked: new Map(), rawContext: null, tools: false, uncensored: false };
      bySlug.set(slug, g);
    }
    const ctx = knownContext(m);
    if (ctx && (!g.rawContext || ctx > g.rawContext)) g.rawContext = ctx;
    if (m.tools !== false && m.usable) g.tools = true;
    if (registry ? registry.isUncensored(m) : m.uncAuto) g.uncensored = true;
    const map = m.usable ? g.byProvUsable : g.byProvLocked;
    const prev = map.get(m.provider);
    // U jednoho poskytovatele vybrat variantu s nástroji / :free / vyšším skóre
    if (!prev || (m.tools === true && prev.tools !== true) || scoreModel(m) > scoreModel(prev)) {
      map.set(m.provider, m);
    }
  }
  const rankMember = (m) => (fav.has(m.key) ? 1000 : 0) + (m.tools === true ? 30 : 0) + scoreModel(m);
  const strengthOrder = { max: 0, high: 1, mid: 2, low: 3 };
  const famRank = (m) => (registry && typeof registry.familyRank === 'function' ? registry.familyRank(m) : -1);

  const out = [];
  for (const g of bySlug.values()) {
    const usable = [...g.byProvUsable.values()].sort((a, b) => rankMember(b) - rankMember(a));
    const locked = [...g.byProvLocked.values()].filter((m) => !g.byProvUsable.has(m.provider)).sort((a, b) => scoreModel(b) - scoreModel(a));
    const sample = usable[0] || locked[0];
    if (!sample) continue;
    const strength = classify({ id: `${g.slug} ${sample.id}`, name: g.title });
    const rawCtx = g.rawContext || knownContext(sample) || 32000;
    const context = Math.max(16000, Math.min(AUTO_CTX_MAX, rawCtx));
    const fRank = famRank({ id: g.slug, name: g.title });
    out.push({
      slug: g.slug,
      title: g.title,
      strength,
      context,
      rawContext: rawCtx,
      tools: usable.length ? g.tools : sample.tools !== false,
      uncensored: g.uncensored,
      usable,
      locked,
      providers: usable.map((m) => m.providerName || m.provider),
      lockedProviders: locked.map((m) => ({ id: m.provider, name: m.providerName || m.provider })),
      familyRank: fRank,
      score: Math.max(...[...usable, ...locked].map(scoreModel)) + usable.length * 2,
    });
  }
  out.sort((a, b) => {
    const ua = a.usable.length ? 0 : 1, ub = b.usable.length ? 0 : 1;
    if (ua !== ub) return ua - ub;
    const sa = strengthOrder[a.strength] ?? 2, sb = strengthOrder[b.strength] ?? 2;
    if (sa !== sb) return sa - sb;
    const fa = a.familyRank >= 0 ? a.familyRank : 999, fb = b.familyRank >= 0 ? b.familyRank : 999;
    if (fa !== fb) return fa - fb;
    return b.score - a.score || b.usable.length - a.usable.length || a.title.localeCompare(b.title);
  });
  return out;
}

module.exports = { BUILTIN, isUnlimited, classify, sizeB, knownContext, tierContext, tierDefs, isTier, tierKeys, order, overview, sanitize, canonicalModel, uniteModels };
