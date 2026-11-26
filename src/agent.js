'use strict';
// Registr modelů napříč poskytovateli + agentní smyčka s automatickým střídáním free modelů.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROVIDERS, PROVEN, makeCustomProvider, scoreModel, isUncensored, chatUrlOf } = require('./providers');
const TAIL_PROVIDERS = new Set(['huggingface', 'groq']);
const tiers = require('./tiers');
const horde = require('./horde');
const { streamChat, ProviderError } = require('./llm');
const { TOOL_DEFS, executeTool, resolvePath, isInside } = require('./tools');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------- modely

class ModelRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.cacheFile] seznamy modelů od poskytovatelů z minula (JSON): s ním list() čeká na poskytovatele
   *   nejvýš opts.waitMs (2,5 s); kdo do té doby neodpoví, dostane seznam z minula a čerstvý se doplní na pozadí.
   *   25. 11.: start čekal na nejpomalejšího poskytovatele (registry.list 0,9–6,3 s, strop 12 s).
   */
  constructor(getSettings, opts = {}) {
    this.getSettings = getSettings;
    this.cacheFile = opts.cacheFile || null;
    this.waitMs = Number(process.env.ZDARMA_LIST_WAIT_MS ?? opts.waitMs ?? 2500);
    this.lastLists = null; // {providerId: {at, list}} z disku, načte se při prvním list()
    this.cache = null;
    this.cacheAt = 0;
    this.cooldown = new Map(); // key -> {until, reason}
    this.textMode = new Set(); // modely bez nativních nástrojů → textový protokol
    this.stickyUnited = new Map(); // slug sjednoceného modelu -> model.key (drží jednoho poskytovatele, dokud má kredit)
  }

  providers() {
    const s = this.getSettings();
    const list = [...PROVIDERS, ...(s.customProviders || []).filter((c) => c.id && c.baseUrl).map(makeCustomProvider)];
    return list.map((p) => {
      const cfg = s.providers?.[p.id] || {};
      const envKey = process.env[`${p.id.toUpperCase()}_API_KEY`] || '';
      const key = cfg.key || (p.custom ? (s.customProviders.find((c) => c.id === p.id)?.key || '') : '') || envKey;
      return { p, key, enabled: cfg.enabled !== false };
    });
  }

  provider(id) { return this.providers().find((x) => x.p.id === id); }

  invalidate() { this.cache = null; }

  /** Seznam modelů poskytovatele do paměti (a na disk při saveLists). Lokální poskytovatelé (LM Studio…) se neukládají. */
  remember(id, list, deferSave = false) {
    if (!this.cacheFile || !Array.isArray(list) || !list.length) return;
    if (!this.lastLists) this.lastLists = {};
    this.lastLists[id] = { at: Date.now(), list: list.map(({ raw, ...m }) => m) };
    if (!deferSave) this.saveLists();
  }

  saveLists() {
    if (!this.cacheFile || !this.lastLists) return;
    try {
      const fs = require('fs');
      const tmp = this.cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, providers: this.lastLists }));
      fs.renameSync(tmp, this.cacheFile);
    } catch {}
  }

  async list(force = false) {
    if (!force && this.cache && Date.now() - this.cacheAt < 10 * 60 * 1000) return this.cache;
    const models = [];
    const status = {};
    if (this.cacheFile && !this.lastLists) {
      try { this.lastLists = JSON.parse(require('fs').readFileSync(this.cacheFile, 'utf8')).providers || {}; } catch { this.lastLists = {}; }
    }
    await Promise.all(this.providers().map(async ({ p, key, enabled }) => {
      if (!enabled) { status[p.id] = { state: 'off' }; return; }
      const usable = !p.needsKey || !!key;
      const push = (list) => {
        for (const m of list) {
          models.push({
            key: `${p.id}/${m.id}`, provider: p.id, providerName: p.name, id: m.id, name: m.name || m.id,
            tools: m.tools, context: m.context || null, local: !!p.local, usable,
            uncAuto: isUncensored(m), ...(m.maxLen ? { maxLen: m.maxLen, workers: m.workers, eta: m.eta } : {}),
          });
        }
      };
      const fresh = Promise.resolve().then(() => p.listModels(key));
      const last = !force && !p.local && this.lastLists?.[p.id]?.list;
      if (last && this.waitMs > 0) {
        const timer = new Promise((r) => setTimeout(() => r(null), this.waitMs).unref?.());
        const got = await Promise.race([fresh.then((l) => ({ l }), (e) => ({ e })), timer]);
        if (!got) { // pomalý: seznam z minula, čerstvý doplnit na pozadí (chyba ne – neplatný klíč se nesmí schovat)
          push(last);
          status[p.id] = { state: usable ? 'ok' : 'nokey', count: last.length, cached: true };
          fresh.then((l) => { this.remember(p.id, l); this.invalidate(); }, () => {});
          return;
        }
        if (got.e) {
          if (p.needsKey && !key) status[p.id] = { state: 'nokey' };
          else status[p.id] = { state: 'error', error: got.e.message };
          return;
        }
        push(got.l);
        this.remember(p.id, got.l, true);
        status[p.id] = { state: usable ? 'ok' : 'nokey', count: got.l.length };
        return;
      }
      try {
        const list = await fresh;
        push(list);
        this.remember(p.id, list, true);
        status[p.id] = { state: usable ? 'ok' : 'nokey', count: list.length };
      } catch (e) {
        if (p.needsKey && !key) status[p.id] = { state: 'nokey' }; // seznam bez klíče nejde, není to chyba
        else status[p.id] = { state: p.local ? 'offline' : 'error', error: p.local ? 'neběží' : e.message };
      }
    }));
    this.saveLists();
    this.cache = { models, status, at: Date.now() };
    this.cacheAt = Date.now();
    return this.cache;
  }

  // Pauza může platit pro jeden model, nebo pro celého poskytovatele ("provider:<id>"),
  // když jde o účet (špatný klíč, vyčerpané kredity, denní limit účtu).
  coolingInfo(key) {
    for (const k of [key, `provider:${String(key).split('/')[0]}`]) {
      const c = this.cooldown.get(k);
      if (!c) continue;
      if (Date.now() > c.until) { this.cooldown.delete(k); continue; }
      return c;
    }
    return null;
  }

  isCooling(key) { return !!this.coolingInfo(key); }

  // Necenzurovaný = rozpoznaný podle názvu, nebo ručně označený uživatelem.
  isUncensored(m) { return !!m.uncAuto || (this.getSettings().uncensoredMarks || []).includes(m.key); }

  cool(key, ms, reason) { this.cooldown.set(key, { until: Date.now() + ms, reason }); }

  /** Sjednocený model (např. "kimi-k3"): drží posledního fungujícího poskytovatele, přepne až po vyčerpání limitu/kreditu. */
  unitedOrder(slug, models) {
    const clean = String(slug || '').replace(/^united:/, '');
    const u = tiers.uniteModels(models, this.getSettings(), this).find((x) => x.slug === clean);
    if (!u || !u.usable.length) return [];
    const list = u.usable.slice();
    const pinnedKey = this.stickyUnited.get(clean);
    if (pinnedKey && !this.isCooling(pinnedKey)) {
      const idx = list.findIndex((m) => m.key === pinnedKey);
      if (idx > 0) {
        const [pinned] = list.splice(idx, 1);
        list.unshift(pinned);
      }
    }
    return list.map((m) => ({ ...m, united: clean, unitedTitle: u.title }));
  }

  noteUnitedSuccess(modelOrKey) {
    const key = typeof modelOrKey === 'string' ? modelOrKey : modelOrKey?.key;
    if (!key) return;
    const id = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
    const { slug } = tiers.canonicalModel({ id });
    if (slug) this.stickyUnited.set(slug, key);
  }

  // Pořadí pro Auto: oblíbené → podle skóre; střídá poskytovatele, ať jeden limit nezastaví všechno.
  // V režimu Unfiltered jen necenzurované modely, i bez nativních nástrojů (dostanou textový protokol).
  // Preferované rodiny modelů (nastavení preferFamilies, např. "kimi", "deepseek-v4", "glm"):
  // index v seznamu, nebo -1. Porovnává se bez ohledu na velikost písmen a oddělovače.
  familyRank(m) {
    const fams = this.getSettings().preferFamilies || [];
    if (!fams.length) return -1;
    const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-');
    const id = norm(`${m.id} ${m.name || ''}`);
    return fams.findIndex((f) => f && id.includes(norm(f)));
  }

  // Poskytovatelé, kteří s free účtem kroky agenta (15–40k tokenů) neutáhnou – za všechny ostatní (22. 11. 2026,
  // docs/research/2026-11-22-claude-e2e): HuggingFace má jen malý měsíční kredit a pak vrací 402 (v závodě opakovaně
  // vypadával), Groq free povolí 1 000 výstupních tokenů za minutu (qwen3.8-27b 0/15 za 10 min, žádný nástroj).
  // Oblíbené (favorites) uživatele mají přednost vždy, takže s placeným účtem si je může dát nahoru.
  autoOrder(models, unfiltered = false) {
    const fav = this.getSettings().favorites || [];
    const usable = unfiltered
      ? models.filter((m) => m.usable && this.isUncensored(m))
      : models.filter((m) => m.usable && m.tools !== false);
    const favs = fav.map((k) => usable.find((m) => m.key === k)).filter(Boolean);
    // prokládání podle poskytovatele: limit nebo chybějící kredit jednoho poskytovatele nezastaví celé čelo pořadí
    const interleave = (list) => {
      const byProv = new Map();
      for (const m of list) { if (!byProv.has(m.provider)) byProv.set(m.provider, []); byProv.get(m.provider).push(m); }
      const queues = [...byProv.values()]; const out = [];
      while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift());
      return out;
    };
    // 1) změřené na skutečné úloze (PROVEN v providers.js), 2) preferované rodiny, 3) zbytek podle skóre.
    // 22. 11. 2026 (docs/research/2026-11-22-claude-e2e): s preferFamilies [kimi, deepseek-v4, glm] bylo prvních 10
    // modelů tieru Max Kimi/DeepSeek z HuggingFace (402 bez kreditu) a NVIDIA Kimi (bez odpovědi do 45 s) → závod
    // zkoušel jen nefunkční modely a krok trval 320 s místo 100 s. Preference rodin zůstává, ale až za změřenými.
    // 4) úplně na konec poskytovatelé, kteří na free účtu kroky agenta neutáhnou (TAIL_PROVIDERS): jako záloha zůstávají.
    const left = usable.filter((m) => !fav.includes(m.key));
    const tail = left.filter((m) => TAIL_PROVIDERS.has(m.provider)).sort((a, b) => scoreModel(b) - scoreModel(a));
    const main = left.filter((m) => !tail.includes(m));
    const proven = main.filter((m) => PROVEN.test(`${m.id} ${m.name || ''}`.toLowerCase()))
      .sort((a, b) => PROVEN.rank(a.id) - PROVEN.rank(b.id) || scoreModel(b) - scoreModel(a)); // pořadí z měření (src/evidence.js)
    const pref = main.filter((m) => !proven.includes(m) && this.familyRank(m) >= 0)
      .sort((a, b) => this.familyRank(a) - this.familyRank(b) || scoreModel(b) - scoreModel(a));
    const rest = main.filter((m) => !proven.includes(m) && !pref.includes(m)).sort((a, b) => scoreModel(b) - scoreModel(a));
    return [...favs, ...interleave(proven), ...interleave(pref), ...interleave(rest), ...interleave(tail)];
  }
}

// ---------------------------------------------------------------- prompt

function projectInstructions(cwd) {
  const names = ['AGENTS.md', 'CLAUDE.md', 'QWEN.md', 'GEMINI.md', '.cursorrules', '.github/copilot-instructions.md'];
  let out = '';
  for (const n of names) {
    try {
      const t = fs.readFileSync(path.join(cwd, n), 'utf8').trim();
      if (t) out += `\n\n### ${n}\n${t.slice(0, 15000)}`;
    } catch {}
  }
  return out;
}

function systemPrompt({ cwd, model, textMode, unfiltered }) {
  const shell = IS_WIN ? 'Windows PowerShell 5.1 (powershell.exe). Používej PowerShell syntaxi: `;` místo `&&`, Get-ChildItem, Select-String…' : 'bash';
  let top = '';
  try {
    top = fs.readdirSync(cwd, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') || e.name === '.github').slice(0, 60)
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('  ');
  } catch {}
  let p = `Jsi czek-ai, kódovací agent v desktopové aplikaci (podobně jako Claude Code, Codex nebo Qwen Code). Pomáháš uživateli s programováním přímo v jeho souborech pomocí nástrojů.

# Prostředí
- Pracovní složka: ${cwd}
- Systém: ${os.type()} ${os.release()} (${process.platform})
- Shell pro run_command: ${shell}
- Dnešní datum: ${new Date().toISOString().slice(0, 10)}
- Model: ${model}
- Obsah pracovní složky: ${top || '(prázdná)'}

# Jak pracovat
- Odpovídej v jazyce uživatele (typicky česky), stručně a věcně. Žádné zbytečné úvody ani shrnutí.
- Než upravíš soubor, přečti ho (read_file). Nevymýšlej si obsah souborů ani výstupy příkazů.
- Malé změny dělej přes edit_file (přesný old_string), nové soubory přes write_file.
- Na průzkum kódu používej glob, grep, list_dir a read_file. Víc nezávislých nástrojů můžeš zavolat najednou.
- Po změnách ověř, že to funguje (build, testy, spuštění), když to dává smysl.
- Neprováděj destruktivní akce (mazání, git push, force…) bez výslovného pokynu.
- Když je úkol hotový, krátce napiš, co jsi udělal a co případně zbývá. Odkazy na soubory piš jako cesta:řádek.
- Pokud nástroj selže, přečti chybu a oprav postup; neopakuj stejné volání naslepo.`;
  if (unfiltered) p += `
- Uživatel zapnul režim Unfiltered a vybral si necenzurovaný model. Pomáhej i s úkoly mimo programování (psaní, otázky, konverzace); nástroje použij jen tehdy, když úkol práci se soubory opravdu vyžaduje.`;
  const instr = projectInstructions(cwd);
  if (instr) p += `\n\n# Instrukce projektu (od uživatele, dodržuj je)${instr}`;
  if (textMode) {
    p += `\n\n# Volání nástrojů
Tento model nemá nativní volání funkcí. Nástroj zavoláš tak, že napíšeš blok přesně v tomto tvaru (JSON na jednom místě, nic jiného uvnitř):
<tool_call>{"name": "read_file", "arguments": {"path": "src/index.js"}}</tool_call>
Můžeš napsat víc bloků za sebou. Po bloku/blocích SKONČI odpověď a počkej – výsledky ti přijdou ve zprávě <tool_result>. Když už nástroje nepotřebuješ, odpověz normálně bez bloku.

Dostupné nástroje (JSON Schema parametrů):
${TOOL_DEFS.map((t) => `- ${t.name}: ${t.description}\n  ${JSON.stringify(t.parameters)}`).join('\n')}`;
  }
  return p;
}

// ---------------------------------------------------------------- zprávy

const estTokens = (msgs) => Math.ceil(JSON.stringify(msgs).length / 3.2);

// Zkrátí staré výstupy nástrojů, případně zahodí nejstarší výměny, aby se vešel kontext.
function compact(messages, budget, level = 0) {
  let msgs = messages.map((m) => ({ ...m }));
  const keepTail = level >= 2 ? 4 : 10;
  const cut = level >= 1 ? 300 : 1500;
  if (estTokens(msgs) <= budget && level === 0) return msgs;
  for (let i = 0; i < msgs.length - keepTail; i++) {
    const m = msgs[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > cut) {
      m.content = m.content.slice(0, cut) + `\n… [starší výstup zkrácen kvůli kontextu]`;
    }
  }
  // Zahazování od začátku (první zprávu uživatele necháme), po celých výměnách.
  // Odstraňuje se úsek msgs[1..k-1], kde k je začátek další výměny (zpráva uživatele),
  // takže dvojice tool_calls ↔ tool výsledky se nikdy nerozdělí.
  for (let guard = 0; guard < 500 && estTokens(msgs) > budget; guard++) {
    const start = msgs[1]?._ph ? 3 : 1;
    let k = start + 1;
    while (k < msgs.length - keepTail && msgs[k].role !== 'user') k++;
    if (k >= msgs.length - keepTail) break;
    msgs.splice(1, k - 1,
      { role: 'user', content: '[Starší část konverzace byla vynechána kvůli délce kontextu.]', _ph: true },
      { role: 'assistant', content: 'Rozumím.', _ph: true });
  }
  return msgs;
}

// Kanonický (OpenAI tools) formát → textový protokol pro modely bez nativních nástrojů.
function toTextMode(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks = m.tool_calls.map((t) => `<tool_call>{"name": ${JSON.stringify(t.function.name)}, "arguments": ${t.function.arguments || '{}'}}</tool_call>`).join('\n');
      out.push({ role: 'assistant', content: [m.content, blocks].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      const piece = `<tool_result name="${m.name || ''}">\n${m.content}\n</tool_result>`;
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last._tr) last.content += '\n' + piece;
      else out.push({ role: 'user', content: piece, _tr: true });
    } else out.push({ role: m.role, content: m.content ?? '' });
  }
  return out.map(({ _tr, ...m }) => m);
}

function stripForApi(messages) {
  // Některé API nesnášejí prázdný content u assistant zprávy s tool_calls → null.
  return messages.map((m) => {
    const o = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls?.length) { o.tool_calls = m.tool_calls; if (!o.content) o.content = null; }
    if (m.role === 'tool') o.tool_call_id = m.tool_call_id;
    return o;
  });
}

// Najde volání nástrojů zapsané textem (<tool_call>…</tool_call>, případně ```json bloky s "name"/"arguments").
function parseTextToolCalls(content) {
  const calls = [];
  let rest = content;
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(content))) {
    const j = lenientJson(m[1].replace(/^```(?:json)?|```$/g, '').trim());
    if (j && j.name) calls.push(j);
  }
  if (calls.length) rest = content.replace(re, '').trim();
  else {
    const fence = /```(?:json|tool_call)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/g;
    while ((m = fence.exec(content))) {
      const j = lenientJson(m[1]);
      if (j && j.name && TOOL_DEFS.some((t) => t.name === j.name)) calls.push(j);
    }
    if (calls.length) rest = content.replace(fence, '').trim();
  }
  return {
    content: rest,
    toolCalls: calls.map((c, i) => ({
      id: `txt_${Date.now().toString(36)}_${i}`, type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments ?? c.parameters ?? c.args ?? {}) },
    })),
  };
}

function lenientJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  const t = String(s).trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch {}
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch {}
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// gpt-oss a spol. občas jméno nástroje pokazí ("run_command<|channel|>commentary", "functions.x", "<|...|> to=x"
// nebo úplně prázdné). Zkusíme ho opravit podle textu, případně odhadnout z argumentů.
function cleanToolName(n, argsText) {
  const names = TOOL_DEFS.map((t) => t.name);
  const raw = String(n || '');
  const t = raw.replace(/<\|[^|]*\|>/g, ' ').trim().replace(/^(functions|tools)\./, '').split(/\s+/)[0] || '';
  if (names.includes(t)) return t;
  const hit = names.filter((x) => raw.includes(x)).sort((a, b) => b.length - a.length)[0];
  if (hit) return hit;
  const a = lenientJson(argsText) || {};
  if ('old_string' in a) return 'edit_file';
  if ('content' in a && 'path' in a) return 'write_file';
  if ('command' in a) return 'run_command';
  if ('url' in a) return 'fetch_url';
  if ('pattern' in a) return /[*?]/.test(a.pattern) && !('include' in a) ? 'glob' : 'grep';
  if ('path' in a && ('offset' in a || 'limit' in a)) return 'read_file';
  return t || raw;
}

// ---------------------------------------------------------------- agent

function needsPermission(tool, args, mode, cwd, allowAlways) {
  const def = TOOL_DEFS.find((t) => t.name === tool);
  if (!def || def.readOnly) return false;
  if (mode === 'all') return false;
  if (allowAlways.has(tool)) return false;
  if (mode === 'edits' && def.kind === 'edit') {
    return !isInside(cwd, resolvePath(cwd, args.path));
  }
  return true;
}

function cooldownFor(err) {
  let base;
  switch (err.kind) {
    case 'rate': base = 60_000; break;
    case 'quota': base = 60 * 60_000; break;
    case 'auth': case 'not_found': base = 24 * 60 * 60_000; break;
    case 'too_large': base = 30 * 60_000; break;
    case 'server': case 'network': base = 2 * 60_000; break;
    // nezačal odpovídat včas: další krok agenta by na něj čekal znovu (DeepSeek V4.1 Flash, NVIDIA, 8. 11.)
    case 'timeout': base = 15 * 60_000; break;
    default: base = 5 * 60_000;
  }
  // Retry-After od serveru má přednost (např. OpenCode Zen posílá ~7 h do obnovení limitu).
  const ra = Math.min(Number(err.retryAfter) || 0, 24 * 3600) * 1000;
  return Math.max(base, ra);
}

// Týká se chyba celého účtu u poskytovatele, nebo jen jednoho modelu?
// Gemini a Groq mají kvóty po modelech: Gemini 3.1 Pro má na free klíči limit 0, Flash přitom funguje.
// 8. 11.: jedna odpověď „quota“ od 3.1 Pro pozastavila celý účet Gemini na hodinu (i Flash na High).
const PER_MODEL_QUOTA = new Set(['gemini', 'groq']);
function providerWide(err, provider) {
  if (err.kind === 'auth') return true;
  if (err.kind === 'quota') {
    if (PER_MODEL_QUOTA.has(provider)) return false;
    return !/for model|model .* (has|is)|per model|model:\s*\S/i.test(err.message);
  }
  return false;
}

const KIND_CZ = { rate: 'limit požadavků', quota: 'vyčerpaná kvóta', auth: 'chybí/špatný klíč', server: 'chyba serveru', network: 'síť', timeout: 'neodpověděl včas', not_found: 'model neexistuje', bad_request: 'odmítnutý požadavek', other: 'chyba', no_tools: 'neumí nástroje', context: 'moc dlouhý kontext', too_large: 'požadavek nad limit tokenů/min' };

class Agent {
  constructor(registry, getSettings) {
    this.registry = registry;
    this.getSettings = getSettings;
  }

  /**
   * @param {object} o
   * @param {object} o.session  {id, cwd, messages, allowAlways?}
   * @param {string} o.text     zpráva uživatele
   * @param {string} o.model    'auto' nebo 'provider/model'
   * @param {string} o.mode     'ask' | 'edits' | 'all'
   * @param {function} o.emit   (event) => void
   * @param {function} o.askPermission (req) => Promise<{decision, note}>
   * @param {AbortSignal} o.signal
   */
  async run({ session, text, model, mode = 'ask', unfiltered = false, emit, askPermission, signal }) {
    const settings = this.getSettings();
    const allowAlways = new Set(session.allowAlways || []);
    if (text != null) session.messages.push({ role: 'user', content: text });

    const { models } = await this.registry.list();
    const byKey = new Map(models.map((m) => [m.key, m]));
    const fallback = settings.fallback !== false;
    const unitedList = model !== 'auto' && !byKey.has(model) ? this.registry.unitedOrder(model, models) : [];
    let current = model !== 'auto' ? (byKey.get(model) || unitedList.find((m) => !this.registry.isCooling(m.key)) || unitedList[0] || null) : null;
    if (model !== 'auto' && !current && model.includes('/')) {
      // Model ze seznamu zmizel (nebo seznam selhal) – zkusíme ho stejně.
      const [pid, ...rest] = model.split('/');
      current = { key: model, provider: pid, providerName: pid, id: rest.join('/'), tools: null, context: null, usable: true };
    }

    const pickNext = (exclude) => {
      if (unitedList.length) {
        const same = unitedList.find((m) => !exclude.has(m.key) && !this.registry.isCooling(m.key));
        if (same || !fallback) return same || null;
      }
      const order = this.registry.autoOrder(models, unfiltered);
      return order.find((m) => !exclude.has(m.key) && !this.registry.isCooling(m.key)) || null;
    };

    const tried = new Set();
    if (!current || (this.registry.isCooling(current.key) && fallback)) {
      if (current && model !== 'auto') emit({ type: 'notice', text: `${current.key} má teď pauzu (${this.registry.coolingInfo(current.key)?.reason}), beru jiný free model.` });
      current = pickNext(tried);
    }
    if (!current) {
      emit({ type: 'error', text: unfiltered
        ? 'Není dostupný žádný necenzurovaný model. Zapni v Nastavení AI Horde (funguje bez klíče), nebo si v Ollamě / LM Studiu stáhni „abliterated“ či „uncensored“ model a v seznamu modelů ho označ jako necenzurovaný.'
        : 'Není dostupný žádný free model. V Nastavení přidej aspoň jeden klíč (např. OpenRouter nebo Groq), nebo zapni Pollinations / lokální Ollamu.' });
      return;
    }

    let failures = 0;
    let ctxLevel = 0;
    for (let step = 0; step < 80; step++) {
      if (signal.aborted) { emit({ type: 'stopped' }); return; }
      const prov = this.registry.provider(current.provider);
      if (!prov) { emit({ type: 'error', text: `Neznámý poskytovatel ${current.provider}` }); return; }
      const isHorde = prov.p.kind === 'horde';
      const textMode = isHorde || current.tools === false || this.registry.textMode.has(current.key);
      const ctxTokens = Math.min(current.context || 32000, 200000);
      const budget = Math.max(4000, Math.floor(ctxTokens * 0.7) - 2500);

      const sys = { role: 'system', content: systemPrompt({ cwd: session.cwd, model: current.key, textMode, unfiltered }) };
      const hist = compact(session.messages, budget, ctxLevel);
      const body = {
        model: current.id,
        messages: [sys, ...(textMode ? toTextMode(hist) : stripForApi(hist))],
      };
      if (!textMode) {
        body.tools = TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      }
      if (ctxLevel > 0) body.max_tokens = 4096;
      if (settings.temperature != null && settings.temperature !== '') body.temperature = Number(settings.temperature);

      emit({ type: 'assistant_start', model: current.key, textMode });
      let res;
      try {
        res = isHorde ? await horde.chat({
          key: prov.key, model: current.id, messages: body.messages, signal,
          ctx: current.context, maxLen: current.maxLen,
          onDelta: (d) => emit({ type: 'delta', text: d }),
          onReasoning: (d) => emit({ type: 'reasoning', text: d }),
          onStatus: (st) => emit({ type: 'status', text: st.queue > 0 ? `AI Horde: ve frontě na pozici ${st.queue}, odhad ~${st.wait} s` : 'AI Horde: worker generuje odpověď…' }),
        }) : await streamChat({
          url: chatUrlOf(prov.p, prov.key),
          headers: prov.p.headers(prov.key),
          body,
          signal,
          onDelta: (d) => emit({ type: 'delta', text: d }),
          onReasoning: (d) => emit({ type: 'reasoning', text: d }),
          timeoutMs: current.local ? 600000 : 150000,
        });
        if (!res.content.trim() && !res.toolCalls.length && !res.reasoning.trim()) {
          throw new ProviderError('Model vrátil prázdnou odpověď', { kind: 'server' });
        }
      } catch (e) {
        emit({ type: 'discard' });
        if (signal.aborted || e.kind === 'aborted') { emit({ type: 'stopped' }); return; }
        const err = e instanceof ProviderError ? e : new ProviderError(e.message, { kind: 'other' });
        if (err.kind === 'no_tools' && !textMode) {
          this.registry.textMode.add(current.key);
          emit({ type: 'notice', text: `${current.key} neumí nativní nástroje → přepínám na textový protokol.` });
          continue;
        }
        if (err.kind === 'context' && ctxLevel < 2) {
          ctxLevel++;
          emit({ type: 'notice', text: 'Kontext je moc dlouhý, zkracuji starší část konverzace.' });
          continue;
        }
        failures++;
        const wide = providerWide(err, current.provider);
        this.registry.cool(wide ? `provider:${current.provider}` : current.key, cooldownFor(err), (KIND_CZ[err.kind] || err.kind) + (wide ? ' (celý účet)' : ''));
        tried.add(current.key);
        const next = fallback && failures < 15 ? pickNext(tried) : null;
        if (!next) {
          emit({ type: 'error', text: `${current.key}: ${err.message}${fallback ? '\nDalší dostupný free model už není. Přidej klíče v Nastavení nebo to zkus za chvíli.' : ''}` });
          return;
        }
        emit({ type: 'notice', text: `${current.key}: ${KIND_CZ[err.kind] || 'chyba'} (${err.message.slice(0, 160)}) → zkouším ${next.key}` });
        current = next;
        continue;
      }

      // úspěch
      failures = 0;
      this.registry.noteUnitedSuccess(current.key);
      let content = res.content;
      let toolCalls = res.toolCalls;
      if (!toolCalls.length && /<tool_call>|```/.test(content)) {
        const parsed = parseTextToolCalls(content);
        if (parsed.toolCalls.length) { content = parsed.content; toolCalls = parsed.toolCalls; }
      }
      const known = new Set(TOOL_DEFS.map((t) => t.name));
      const msg = { role: 'assistant', content, model: current.key };
      if (res.reasoning) msg.reasoning = res.reasoning.slice(0, 20000);
      if (toolCalls.length) msg.tool_calls = toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: cleanToolName(t.function.name, t.function.arguments), arguments: t.function.arguments || '{}' } }));
      session.messages.push(msg);
      emit({ type: 'assistant_done', content, model: current.key, usage: res.usage, hasTools: toolCalls.length > 0 });

      if (!toolCalls.length) { emit({ type: 'done' }); return; }

      // nástroje
      let stopTurn = false;
      for (const tc of msg.tool_calls) {
        const name = tc.function.name;
        let args = lenientJson(tc.function.arguments);
        const reply = (content, ok, display) => {
          session.messages.push({ role: 'tool', tool_call_id: tc.id, name, content, ok, display });
          emit({ type: 'tool_result', id: tc.id, name, ok, output: content, display });
        };
        emit({ type: 'tool_call', id: tc.id, name, args: args ?? tc.function.arguments });
        if (stopTurn) { reply('Zrušeno (uživatel zamítl předchozí akci).', false); continue; }
        if (!known.has(name)) { reply(`Neznámý nástroj "${name}". Dostupné: ${[...known].join(', ')}`, false); continue; }
        if (!args) { reply(`Argumenty nejsou platný JSON: ${String(tc.function.arguments).slice(0, 300)}`, false); continue; }
        if (signal.aborted) { reply('Zastaveno uživatelem.', false); continue; }

        if (needsPermission(name, args, mode, session.cwd, allowAlways)) {
          const ans = await askPermission({ id: tc.id, name, args });
          if (ans.decision === 'always') { allowAlways.add(name); session.allowAlways = [...allowAlways]; }
          if (ans.decision === 'deny') {
            if (ans.note) reply(`Uživatel akci zamítl: ${ans.note}`, false);
            else { reply('Uživatel akci zamítl. Zastav se a zeptej se, jak pokračovat.', false); stopTurn = true; }
            continue;
          }
        }
        emit({ type: 'tool_running', id: tc.id });
        const r = await executeTool(name, args, { cwd: session.cwd, signal });
        reply(r.output, r.ok, r.display);
      }
      if (signal.aborted) { emit({ type: 'stopped' }); return; }
      if (stopTurn) { emit({ type: 'done' }); return; }
    }
    emit({ type: 'error', text: 'Dosažen limit 80 kroků v jednom tahu. Napiš „pokračuj“, pokud má agent pokračovat.' });
  }
}

module.exports = { ModelRegistry, Agent, compact, toTextMode, parseTextToolCalls, lenientJson, systemPrompt, needsPermission, cooldownFor, providerWide, KIND_CZ };
