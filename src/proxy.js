'use strict';
// Lokální OpenAI-kompatibilní server: OpenCode (nebo jiný klient) → Zdarma → free modely.
// Model "auto" = stejné střídání jako v aplikaci (při limitu/chybě se vezme další free model),
// "auto-unfiltered" = jen necenzurované modely. Konkrétní model "poskytovatel/model" jde taky,
// při chybě se (pokud je zapnutý fallback) pokračuje dalším modelem z pořadí Auto.
const http = require('http');
const { streamChat, ProviderError, addToolCallDeltas, finishToolCalls } = require('./llm');
const horde = require('./horde');
const { toTextMode, lenientJson, cooldownFor, providerWide, KIND_CZ } = require('./agent');
const tiers = require('./tiers');
const { chatUrlOf } = require('./providers');

const MAX_ATTEMPTS = 15;
const SELF_WAIT_MS = Number(process.env.ZDARMA_SELF_WAIT_MS) || 20000; // jak dlouho proxy sama počká na uvolnění modelu
// Strop odpovědi, který appka posílá upstream. Dřív 16 384: OpenCode posílál 32 000 u přímých
// modelů a proxy ho usekla na polovinu (měřeno 21. 11. 2026, docs/research/loop-czek-perf/bench-outcap-app.js:
// 32 000 → 16 332 tokenu). Providerové zvládnou více: Groq gpt-oss-120b 65 536, Mistral/Pollinations/OpenRouter >200 000.
const MAX_OUT = Number(process.env.ZDARMA_MAX_OUT) || 32768;
// Když klient max_tokens neposílá, provider usekne odpověď sám – u Groku na 3 072 tokenu
// (finish=length, měřeno: gpt-oss-120b 3 072 tokenu místo 14 082). Dlatego posíláme default explicitně.
const DEFAULT_OUT = Number(process.env.ZDARMA_DEFAULT_OUT) || 16384;
// Skutečný strop, který provider pověděl v chybové hlášce. Dvě cache s TTL:
//   HARD  = strop modelu (400 „max_tokens at most N“) – stabilní, 60 min
//   QUOTA = kolik tokenů zbývá v kvótě (429 „on output tokens per minute (OTPM): Limit 1000, Used 900“)
//           – resetuje se each minute, hence short TTL. Bez TTL by cap platný forever usěknul odpovědi.
const ADAPT_OUT = process.env.ZDARMA_ADAPT_OUT !== '0';
const HARD_CAP_TTL_MS = Number(process.env.ZDARMA_CAP_TTL_MS) || 60 * 60_000;
const QUOTA_TTL_MS = Number(process.env.ZDARMA_QUOTA_TTL_MS) || 60_000;
const hardCaps = new Map();  // key → { cap, until }
const quotaCaps = new Map(); // key → { cap, until }
const OUT_CAP_PATTERNS = [
  /at most (\d{3,7})/i,
  /less than or equal to [`"]?(\d{3,7})/i,
  /no more than (\d{3,7})/i,
  /maximum (?:output )?tokens?[^\d]{0,12}(\d{3,7})/i,
  /max(?:imum)?_tokens?[^\d]{0,12}(\d{3,7})/i,
];
function outCapFromError(msg) {
  const m = String(msg || '');
  if (/context|input|prompt/i.test(m) && !/max_tokens|max tokens/i.test(m)) return 0; // kontext, ne strop odpovědi
  for (const re of OUT_CAP_PATTERNS) { const hit = re.exec(m); if (hit) return Number(hit[1]); }
  return 0;
}
// „Request too large for model … on output tokens per minute (OTPM): Limit 1000, Used 900, Requested 1329“
// → model now generates only Limit−Used tokens. Měřeno 21. 11.: groq/qwen/qwen3.8-27b rejected
// max_tokens=16384 with that 429, while a request without max_tokens succeeded.
function outLimitFromQuota(msg) {
  // Groq posílá obě podoby: „Limit 1000, Used 940, Requested 345“ i bez Used („Limit 1000, Requested 1329“ =
  // dotaz je větší než celý minutový rozpočet) – soudce kola 4 smyčky czek-perf, živý záznam outcap-2026-11-21.json
  const m = /output tokens per minute[^:]*: ?Limit (\d+)(?:, Used (\d+))?/i.exec(String(msg || ''));
  if (!m) return null;
  return Math.max(0, Number(m[1]) - Number(m[2] || 0));
}
function setCap(map, key, cap, ttl) {
  const c = Math.floor(Number(cap) || 0);
  if (c < 512 || c > MAX_OUT) return; // below 512 there is nothing worth generating; never exceed MAX_OUT
  const prev = map.get(key);
  if (prev && prev.until > Date.now() && prev.cap <= c) return; // already have a tighter, valid cap
  map.set(key, { cap: c, until: Date.now() + ttl });
}
// Effective output cap for a model (0 = unknown). Expired entries are dropped on read.
function outCapOf(key) {
  if (!ADAPT_OUT) return 0;
  const now = Date.now();
  const h = hardCaps.get(key);
  const q = quotaCaps.get(key);
  const hard = h && h.until > now ? h.cap : 0;
  const quota = q && q.until > now ? q.cap : 0;
  if (!hard && !quota) return 0;
  return Math.min(hard || MAX_OUT, quota || MAX_OUT);
}
// Kolik tokenu skutečně posíláme: klient prosí `maxOut`, combo už zná naučený strop.
// OmniRoute strop modelu sám nekontroluje (měřeno, bench-combo-outcap.js) – clamp musí dělat proxy.
function outFor(key, maxOut) {
  const want = Math.min(Number(maxOut) || DEFAULT_OUT, MAX_OUT);
  const known = outCapOf(key);
  return known ? Math.min(want, known) : want;
}
// Hláška providera → strop, pro který stojí za to poslat dotaz znovu (max 2 pokusy celkem).
function capRetry(msg, out, attempt) {
  const learned = outCapFromError(msg) || outLimitFromQuota(msg);
  return ADAPT_OUT && learned >= 512 && learned < out && attempt < 2 ? learned : 0;
}
// OmniRoute: nejdéle na začátek odpovědi (napříč modely tierlistu) a na ticho uprostřed odpovědi
const OMNI_FIRST_MS = Number(process.env.ZDARMA_OMNI_FIRST_MS) || 120000;
const OMNI_IDLE_MS = Number(process.env.ZDARMA_OMNI_IDLE_MS) || 120000;
// tierlisty, u kterých proxy sama doplní reasoning_effort (kroky agenta s nástroji)
const DEEP_TIERS = new Set(['max', 'high', 'mid', 'auto']);
// vlastní směrování: přidaný reasoning_effort jen poskytovatelům, kteří ho přijmou (ostatní, např. přísné
// API s „extra fields forbidden“, by vrátili 400); přes OmniRoute ověřeno i na Codestral/OVH/Gemini Flash
const EFFORT_PROVIDERS = new Set(['nvidia', 'kilo', 'openrouter', 'opencode', 'huggingface', 'ovh', 'gemini', 'groq']);
// vlastní směrování: nejdéle na první data od jednoho modelu (pak se zkusí další); OmniRoute má 30–45 s
const FIRST_BYTE_MS = Number(process.env.ZDARMA_FIRST_BYTE_MS) || 45000;
const estTokens = (x) => Math.ceil(JSON.stringify(x).length / 3.2);
// Odhad spotřeby, když poskytovatel usage neposlal.
const usage_est = (estTok, content, toolCalls) => {
  const out = estTokens(String(content || '') + JSON.stringify(toolCalls || []));
  return { prompt_tokens: estTok, completion_tokens: out, total_tokens: estTok + out, estimated: true };
};

// ------------------------------------------------------------ převod zpráv

/** Pracovní složka z promptu OpenCode („Working directory: …“) – pro součty tokenů za projekt. */
function projectOf(messages) {
  for (const m of messages || []) {
    if (m.role !== 'system' || typeof m.content !== 'string') continue;
    const r = /Working directory:\s*([^\r\n<]+)/.exec(m.content);
    if (r) return r[1].trim();
  }
  return null;
}

function flattenContent(c) {
  if (Array.isArray(c) && c.every((p) => p && (p.type === 'text' || p.type === 'input_text'))) return c.map((p) => p.text).join('\n');
  return c ?? '';
}

/** Zprávy od klienta → tvar, který snesou i vybíravější free API. */
function sanitize(messages) {
  const out = [];
  for (const m of messages || []) {
    const role = m.role === 'developer' ? 'system' : m.role;
    const o = { role, content: flattenContent(m.content) };
    if (m.tool_calls?.length) {
      o.tool_calls = m.tool_calls.map((t) => ({
        id: t.id, type: 'function',
        function: { name: t.function?.name || '', arguments: typeof t.function?.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function?.arguments ?? {}) },
      }));
      if (!o.content) o.content = null;
    }
    if (role === 'tool') {
      o.tool_call_id = m.tool_call_id;
      if (typeof o.content !== 'string') o.content = JSON.stringify(o.content);
    }
    // Víc systémových zpráv na začátku → jedna (některá API jinak vrací 400).
    const prev = out[out.length - 1];
    if (role === 'system' && prev?.role === 'system' && out.every((x) => x.role === 'system')) prev.content += '\n\n' + o.content;
    else out.push(o);
  }
  return out;
}

function textToolPrompt(tools) {
  return `\n\n# Calling tools
This model has no native function calling. To call a tool, write a block in exactly this form (one JSON object inside, nothing else):
<tool_call>{"name": "TOOL_NAME", "arguments": {"param": "value"}}</tool_call>
You may write several blocks one after another. After the block(s) END your reply and wait – the results arrive in a <tool_result> message. When you need no more tools, answer normally without any block.

Available tools (JSON Schema of parameters):
${tools.map((t) => `- ${t.function.name}: ${String(t.function.description || '').slice(0, 800)}\n  ${JSON.stringify(t.function.parameters || {})}`).join('\n')}`;
}

/** Pro model bez nativních nástrojů: popis nástrojů do system promptu, historie do textového protokolu. */
function toTextProtocol(messages, tools) {
  const names = new Map();
  for (const m of messages) for (const t of m.tool_calls || []) names.set(t.id, t.function.name);
  const withNames = messages.map((m) => (m.role === 'tool' ? { ...m, name: names.get(m.tool_call_id) || '' } : m));
  const msgs = toTextMode(withNames);
  if (tools?.length) {
    if (msgs[0]?.role === 'system') msgs[0] = { ...msgs[0], content: msgs[0].content + textToolPrompt(tools) };
    else msgs.unshift({ role: 'system', content: textToolPrompt(tools).trim() });
  }
  return msgs;
}

function cleanName(raw, names) {
  const s = String(raw || '');
  const t = s.replace(/<\|[^|]*\|>/g, ' ').trim().replace(/^(functions|tools)\./, '').split(/\s+/)[0] || '';
  if (!names.length || names.includes(t)) return t || s;
  return names.filter((n) => s.includes(n)).sort((a, b) => b.length - a.length)[0] || t || s;
}

/** <tool_call>{…}</tool_call> (případně ```json blok se známým jménem) v textu → OpenAI tool_calls. */
function parseTextCalls(content, names) {
  const calls = [];
  let rest = content;
  const re = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
  let m;
  while ((m = re.exec(content))) {
    const j = lenientJson(m[1].replace(/^```(?:json)?|```$/g, '').trim());
    if (j && j.name) calls.push(j);
  }
  if (calls.length) rest = content.replace(re, '').trim();
  else if (names.length) {
    const fence = /```(?:json|tool_call)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/g;
    while ((m = fence.exec(content))) {
      const j = lenientJson(m[1]);
      if (j && j.name && names.includes(cleanName(j.name, names))) calls.push(j);
    }
    if (calls.length) rest = content.replace(fence, '').trim();
  }
  return {
    content: rest,
    toolCalls: calls.map((c, i) => ({
      id: `call_${Date.now().toString(36)}${i}`, type: 'function',
      function: { name: cleanName(c.name, names), arguments: JSON.stringify(c.arguments ?? c.parameters ?? c.args ?? {}) },
    })),
  };
}

// ------------------------------------------------------------ výběr modelů

function candidates({ registry, models, requested, fallback, estTok, settings = {} }) {
  // Model, kterému by konverzace nevešla (kontext od poskytovatele, jinak známý podle rodiny), se přeskočí.
  const fits = (m) => { const c = tiers.knownContext(m); return !c || c >= estTok + 1024; };
  // Tierlist: jeho modely v pořadí, po vyčerpání záložní tierlisty.
  if (tiers.isTier(requested, settings)) return tiers.order(requested, models, settings, registry).filter(fits);
  const unfiltered = requested === 'auto-unfiltered';
  const order = registry.autoOrder(models, unfiltered);
  if (requested === 'auto' || unfiltered) return order.filter(fits);
  // Sjednocený model (např. "kimi-k3" nebo "united:kimi-k3"): drží jednoho poskytovatele, po vyčerpání přepne na dalšího se stejným modelem.
  if (typeof registry.unitedOrder === 'function') {
    const united = registry.unitedOrder(requested, models).filter(fits);
    if (united.length) return united;
  }
  let m = models.find((x) => x.key === requested);
  if (!m) {
    const [pid, ...rest] = requested.split('/');
    m = { key: requested, provider: pid, providerName: pid, id: rest.join('/'), tools: null, context: null, usable: true };
  }
  const sameModel = typeof registry.unitedOrder === 'function'
    ? registry.unitedOrder(tiers.canonicalModel(m).slug, models).filter((x) => x.key !== m.key && fits(x))
    : [];
  return [m, ...(fallback ? [...sameModel, ...order.filter((x) => x.key !== m.key && !sameModel.some((s) => s.key === x.key) && fits(x))] : [])];
}

// ------------------------------------------------------------ typy argumentů nástrojů
// Free modely posílají čísla jako text ("offset":"0", "limit":"1000", "timeout":"10000") a OpenCode
// volání odmítne (SchemaError, změřeno v chatu uživatele 7.–8. 11.: 10× read, bash). Proxy zná schéma
// každého nástroje z požadavku, tak typy srovná: text → číslo / boolean, JSON v textu → pole / objekt.
function coerceValue(v, sch) {
  if (!sch || v == null) return v;
  const types = [].concat(sch.type || []);
  if (typeof v === 'string') {
    const s = v.trim();
    if ((types.includes('integer') || types.includes('number')) && !types.includes('string') && /^-?\d+(\.\d+)?$/.test(s)) return types.includes('integer') ? parseInt(s, 10) : Number(s);
    if (types.includes('boolean') && !types.includes('string') && /^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if ((types.includes('array') || types.includes('object')) && !types.includes('string') && /^[[{]/.test(s)) { try { return coerceValue(JSON.parse(s), sch); } catch { return v; } }
  }
  if (Array.isArray(v) && sch.items) return v.map((x) => coerceValue(x, sch.items));
  if (v && typeof v === 'object' && !Array.isArray(v) && sch.properties) {
    const o = { ...v };
    for (const [k, ps] of Object.entries(sch.properties)) if (k in o) o[k] = coerceValue(o[k], ps);
    return o;
  }
  return v;
}
/** Argumenty volání (JSON text) → opravené podle schématu nástroje. Vrací { args, fixed }. */
function coerceArgs(args, schema) {
  if (!schema) return { args, fixed: false };
  let o;
  try { o = JSON.parse(args || '{}'); } catch { return { args, fixed: false }; }
  const c = coerceValue(o, schema);
  const out = JSON.stringify(c);
  return { args: out, fixed: out !== JSON.stringify(o) };
}
const schemasOf = (tools) => new Map((tools || []).map((t) => [t.function?.name, t.function?.parameters]));

// ------------------------------------------------------------ Gemini: thought_signature
// Gemini 3 chce u volání nástrojů v historii zpět "thought_signature" (extra_content.google). OpenCode ho
// zahodí → HTTP 400 "Function call is missing a thought_signature". Proxy si podpisy pamatuje podle id
// volání a vrací je; u historie bez uloženého podpisu použije zástupnou hodnotu, kterou Google pro tyto
// případy dokumentuje (přenesená/upravená historie).
const SIG_DUMMY = 'skip_thought_signature_validator';
const sigCache = new Map();
function rememberSignature(id, extra) {
  if (!id || !extra?.google?.thought_signature) return;
  sigCache.set(id, extra);
  if (sigCache.size > 5000) sigCache.delete(sigCache.keys().next().value);
}
const isGemini = (prov) => prov?.p?.id === 'gemini' || /generativelanguage\.googleapis\.com/.test(prov?.p?.baseUrl || '');
function withSignatures(messages) {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((t, k) => {
        if (t.extra_content?.google?.thought_signature) return t;
        const cached = sigCache.get(t.id);
        if (cached) return { ...t, extra_content: cached };
        return k === 0 ? { ...t, extra_content: { google: { thought_signature: SIG_DUMMY } } } : t;
      }),
    };
  });
}

// ------------------------------------------------------------ jedno volání

async function callModel({ registry, prov, model, body, tools, signal, onDelta, onReasoning, maxOut }) {
  const isHorde = prov.p.kind === 'horde';
  const textMode = isHorde || model.tools === false || registry.textMode.has(model.key);
  let messages = textMode ? toTextProtocol(body.messages, tools) : body.messages;
  if (!textMode && isGemini(prov)) messages = withSignatures(messages);
  if (isHorde) {
    return {
      textMode,
      res: await horde.chat({ key: prov.key, model: model.id, messages, signal, ctx: model.context, maxLen: model.maxLen }),
    };
  }
  const up = { model: model.id, messages };
  // reasoning_effort / reasoning (OpenRouter) dřív vlastní směrování zahazovalo – úroveň přemýšlení se
  // k modelu nedostala, i když ji OpenCode poslal
  for (const k of ['temperature', 'top_p', 'stop', 'seed', 'response_format', 'reasoning_effort', 'reasoning']) if (body[k] != null) up[k] = body[k];
  if (maxOut) up.max_tokens = Math.min(maxOut, outCapOf(model.key) || maxOut);
  if (!textMode && tools?.length) {
    up.tools = tools;
    if (body.tool_choice != null) up.tool_choice = body.tool_choice;
  }
  const res = await streamChat({
    url: chatUrlOf(prov.p, prov.key),
    headers: prov.p.headers(prov.key),
    body: up,
    signal,
    // v textovém režimu se odpověď nestreamuje: bloky <tool_call> se musí z textu vyříznout
    onDelta: textMode ? null : onDelta,
    onReasoning,
    timeoutMs: model.local ? 600000 : 150000,
    firstByteMs: model.local ? 600000 : FIRST_BYTE_MS,
  });
  return { textMode, res };
}

// ------------------------------------------------------------ server

/**
 * @param {object} o
 * @param {import('./agent').ModelRegistry} o.registry
 * @param {() => object} o.getSettings
 * @param {(entry: object) => void} [o.onLog]
 */
function createProxy({ registry, getSettings, onLog = () => {}, version = "0", usage: tracker = null, trace = null, omni = () => null, capture = null, live = null, diagApi = null }) {
  // Plné zachycení pro rozbor: co OpenCode poslal (zprávy, nástroje, parametry) a co se vrátilo.
  const paramsOf = (body) => Object.fromEntries(Object.entries(body || {}).filter(([k]) => !['messages', 'tools'].includes(k)));
  const cap = (rec) => { if (!capture) return; try { capture(rec); } catch {} };
  const liveEv = (rec) => { if (!live) return; try { live(rec); } catch {} };
  // Co se právě děje: rozpracované požadavky (který model zrovna pracuje) a poslední dokončený.
  const activity = { current: new Map(), last: null };
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const fail = (res, code, message, type = 'zdarma_error') => json(res, code, { error: { message, type, code } });

  async function listModels(res) {
    const { models } = await registry.list();
    const data = [
      ...tiers.tierDefs(getSettings()).map((d) => ({ id: d.id, object: 'model', owned_by: 'zdarma-tier', name: d.name })),
      { id: 'auto', object: 'model', owned_by: 'zdarma' },
      { id: 'auto-unfiltered', object: 'model', owned_by: 'zdarma' },
      ...models.filter((m) => m.usable).map((m) => ({ id: m.key, object: 'model', owned_by: m.provider, context_length: m.context || undefined })),
    ];
    json(res, 200, { object: 'list', data });
  }

  // Přeposlání na OmniRoute combo. Vrací 'done', nebo 'fallback', když OmniRoute není k zastižení.
  async function viaOmni({ eng, combo, body, messages, res, ctrl, stream, includeUsage, requested, project, rid, t0, estTok, tools, maxOut, attempt = 0 }) {
    activity.current.set(rid, { requested, model: `OmniRoute · ${combo}`, providerName: 'OmniRoute', tier: requested, since: Date.now(), project });
    // OpenCode prosí pro combo 16 000 tokenu (COMBO_OUTPUT), ale modely uvnitř combo mají
    // skutečný strop nižší (HF/Groq: „max_tokens must be less than or equal to 8192“).
    // OmniRoute strop modelu nepoužívá (měřeno: bench-combo-outcap.js) → posíláme sami
    // min(prošené, naučený strop combo). Po 400 se strop naučí z hlášky providera.
    const out = outFor(combo, maxOut);
    const up = { ...body, model: combo, messages, max_tokens: out };
    if (body.max_completion_tokens != null) up.max_completion_tokens = out;
    if (body.max_output_tokens != null) up.max_output_tokens = out;
    if (stream) up.stream_options = { ...(body.stream_options || {}), include_usage: true };
    const tr = trace ? { at: Date.now(), requested, via: 'omniroute', combo, project, msgs: messages.length, estTok, maxTokensReq: out, tools: (tools || []).length, attempts: [] } : null;
    // Pojistka proti zamrznutí: OmniRoute pošle hlavičky, až některý model začne odpovídat. Když se to
    // nestane do OMNI_FIRST_MS (nebo uprostřed odpovědi přijde OMNI_IDLE_MS ticha), požadavek se ukončí
    // chybou, kterou OpenCode neopakuje – jinak relace visí „pracuje“ a seznam úkolů stojí.
    const octrl = new AbortController();
    const onClientAbort = () => octrl.abort('client');
    ctrl.signal.addEventListener('abort', onClientAbort, { once: true });
    let watchdog = setTimeout(() => octrl.abort('first'), OMNI_FIRST_MS);
    const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => octrl.abort('idle'), OMNI_IDLE_MS); };
    const stopWatch = () => { clearTimeout(watchdog); ctrl.signal.removeEventListener('abort', onClientAbort); };
    const timedOut = () => octrl.signal.aborted && octrl.signal.reason !== 'client';
    let r;
    try {
      r = await fetch(eng.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(up), signal: octrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) { stopWatch(); return 'done'; }
      if (timedOut()) {
        stopWatch();
        const msg = `Žádný model z tierlistu nezačal odpovídat do ${Math.round(OMNI_FIRST_MS / 1000)} s.`;
        tracker?.record({ provider: 'omniroute', providerName: 'OmniRoute', model: combo, ok: false, kind: 'network', error: msg, tier: requested, project });
        activity.last = { requested, model: combo, at: Date.now(), ok: false, error: msg, project };
        if (tr) { try { trace({ ...tr, ok: false, error: msg, ms: Date.now() - t0 }); } catch {} }
        onLog({ at: Date.now(), ok: false, requested, model: combo, ms: Date.now() - t0, tried: [combo], error: msg });
        fail(res, 400, `${msg} Zkus to znovu, nebo jiný tierlist.`, 'zdarma_no_model_available');
        return 'done';
      }
      stopWatch();
      onLog({ at: Date.now(), ok: false, requested, model: 'omniroute', ms: Date.now() - t0, error: 'OmniRoute nedostupný: ' + e.message });
      return 'fallback';
    }
    kick();
    const ttfbMs = Date.now() - t0; // OmniRoute pošle hlavičky, až nějaký model začne odpovídat
    const corr = r.headers.get('x-correlation-id') || r.headers.get('x-request-id') || '';
    // Řetěz pokusů uvnitř OmniRoute (co selhalo před úspěchem a jak dlouho) → živý záznam
    const chain = () => setTimeout(async () => {
      if (!live || !corr || !eng.api) return;
      try {
        const rows = await eng.api('GET', `/api/usage/call-logs?correlationId=${encodeURIComponent(corr)}&limit=60`);
        const list = (Array.isArray(rows) ? rows : []).filter((x) => x.provider && x.model).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        liveEv({ src: 'omni', kind: 'chain', rid, requested, combo, attempts: list.map((x) => ({ model: `${eng.nodeToProvider?.get(x.provider) || x.provider}/${x.model}`, status: x.status, ms: x.duration, ttft: x.ttftMs ?? x.ttft_ms ?? null, tokIn: x.tokens?.in ?? x.tokensIn ?? null, tokOut: x.tokens?.out ?? x.tokensOut ?? null, error: x.error ? String(x.error).slice(0, 160) : undefined })) });
      } catch {}
    }, 1500);
    let key, provId, pname;
    const setKey = (k) => {
      key = k || combo;
      provId = key.includes('/') ? key.split('/')[0] : 'omniroute';
      pname = registry.provider(provId)?.p.name || 'OmniRoute';
    };
    setKey(eng.modelKeyFrom(r.headers, combo));
    // streamy s nástroji nemají hlavičky výběru → model z pole "model" v odpovědi
    const fromBody = (model) => {
      if (key !== combo || !model) return;
      setKey(eng.keyForModel(combo, model));
      if (key !== combo) activity.current.set(rid, { requested, model: key, providerName: pname, tier, since: Date.now(), project });
    };
    const tier = requested;
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      stopWatch();
      let msg = text;
      try { msg = JSON.parse(text).error?.message || text; } catch {}
      msg = String(msg).slice(0, 500);
      tracker?.record({ provider: provId, providerName: pname, model: key, ok: false, kind: 'server', error: msg, tier, project });
      activity.last = { requested, model: key, at: Date.now(), ok: false, error: msg.slice(0, 200), project };
      if (tr) { try { trace({ ...tr, ok: false, status: r.status, error: msg.slice(0, 160), ms: Date.now() - t0 }); } catch {} }
      onLog({ at: Date.now(), ok: false, requested, model: key, ms: Date.now() - t0, tried: [combo], error: msg.slice(0, 300) });
      chain();
      cap({ rid, via: 'omniroute', requested, combo, model: key, ok: false, status: r.status, error: msg, project, params: paramsOf(body), tools: (tools || []).map((x) => x.function.name), messages });
      // Provider pověděl svůj strop odpovědi (nebo zbývající kvótu) → naučíme se ho pro combo
      // a posílame méně tokenu. Bez toho by první pokus selhal a OpenCode by krok opakoval.
      const learned = capRetry(msg, out, attempt);
      if (learned) {
        setCap(hardCaps, combo, learned, HARD_CAP_TTL_MS);
        onLog({ at: Date.now(), ok: false, requested, model: key || combo, ms: Date.now() - t0, tried: [combo], error: `strop výstupu ${learned} – posílame méně tokenu, zkoušíme znovu` });
        return viaOmni({ eng, combo, body, messages, res, ctrl, stream, includeUsage, requested, project, rid, t0, estTok, tools, maxOut: learned, attempt: attempt + 1 });
      }
      // 400: na 429/5xx by OpenCode opakoval donekonečna (OmniRoute už zkusil všechny modely combo)
      fail(res, 400, `Žádný free model teď neodpověděl (OmniRoute ${combo}): ${msg} Zkus to za chvíli znovu, nebo přidej klíče / jiný tierlist.`, 'zdarma_no_model_available');
      return 'done';
    }
    activity.current.set(rid, { requested, model: key, providerName: pname, tier, since: Date.now(), project });
    let usage = null, content = 0, reasoning = 0, finish = null;
    // Volání nástrojů se skládají a klientovi jdou celá (jako u vlastního směrování). Syrové kusy od
    // modelů bývají rozbité (jméno až v dalším kusu, nový index bez jména…) a OpenCode pak skončí
    // chybou „Expected 'function.name' to be a string“.
    const tc = [];
    const names = (tools || []).map((t) => t.function.name);
    const schemas = schemasOf(tools);
    let fixedArgs = 0;
    let finalCalls = null;
    const done = () => {
      if (finalCalls) return finalCalls;
      finalCalls = finishToolCalls(tc).map((t) => {
        rememberSignature(t.id, t.extra_content);
        const name = cleanName(t.function.name, names);
        const c = coerceArgs(t.function.arguments || '{}', schemas.get(name));
        if (c.fixed) fixedArgs++;
        return { id: t.id, type: 'function', function: { name, arguments: c.args } };
      });
      return finalCalls;
    };
    let textAcc = '', reasonAcc = '';
    const countText = (d) => {
      if (typeof d.content === 'string') { content += d.content.length; if (textAcc.length < 200000) textAcc += d.content; }
      const rs = d.reasoning_content ?? d.reasoning;
      if (typeof rs === 'string') { reasoning += rs.length; if (reasonAcc.length < 100000) reasonAcc += rs; }
    };
    try {
      if (!stream) {
        const j = await r.json();
        fromBody(j.model);
        usage = j.usage || null;
        const c = j.choices?.[0];
        if (c?.message) {
          countText(c.message);
          if (Array.isArray(c.message.tool_calls) && c.message.tool_calls.length) {
            addToolCallDeltas(tc, c.message.tool_calls, true);
            c.message.tool_calls = done();
            c.finish_reason = 'tool_calls';
          }
          finish = c.finish_reason || null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Zdarma-Model': key });
        res.end(JSON.stringify(j));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Zdarma-Model': key });
        const dec = new TextDecoder();
        let buf = '';
        let base = null; // id/created/model z odpovědi pro vlastní kusy
        let flushed = false;
        let doneSent = false;
        const send =(o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        // celá volání nástrojů + konec tahu
        const flush = (reason) => {
          if (flushed) return;
          flushed = true;
          const calls = done();
          const b = base || { id: 'chatcmpl-omni', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: key };
          if (calls.length) send({ ...b, choices: [{ index: 0, delta: { tool_calls: calls.map((t, k) => ({ index: k, ...t })) }, finish_reason: null }] });
          finish = calls.length ? 'tool_calls' : (reason || 'stop');
          send({ ...b, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        };
        const emit = (ev) => {
          const line = ev.split('\n').find((l) => l.startsWith('data:'));
          const data = line ? line.slice(5).trim() : '';
          if (!data) return;
          if (data === '[DONE]') { flush(); if (!doneSent) res.write('data: [DONE]\n\n'); doneSent = true; return; }
          let o;
          try { o = JSON.parse(data); } catch { return; }
          if (o.error) { res.write(`data: ${data}\n\n`); return; } // chyba uprostřed streamu: předat
          fromBody(o.model);
          if (o.id && !base) base = { id: o.id, object: o.object || 'chat.completion.chunk', created: o.created, model: o.model };
          if (o.usage) usage = o.usage;
          const choices = o.choices || [];
          if (!choices.length) { if (o.usage && includeUsage) send(o); return; } // usage jen když o ně klient žádal
          let reason = null;
          for (const c of choices) {
            const d = c.delta || {};
            countText(d);
            if (Array.isArray(d.tool_calls)) { addToolCallDeltas(tc, d.tool_calls); delete d.tool_calls; }
            delete d.name;
            if (c.finish_reason) { reason = c.finish_reason; c.finish_reason = null; }
          }
          const useful = choices.some((c) => { const d = c.delta || {}; return d.role || d.content || d.reasoning_content || d.reasoning; });
          if (useful) send({ ...o, usage: undefined });
          if (reason) flush(reason);
          if (o.usage && includeUsage) send({ ...(base || {}), choices: [], usage: o.usage });
        };
        for await (const part of r.body) {
          kick();
          buf += dec.decode(part, { stream: true }).replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.trim()) emit(ev); }
        }
        if (buf.trim()) emit(buf);
        flush(); // upstream skončil bez finish_reason
        if (!doneSent) res.write('data: [DONE]\n\n');
        res.end();
      }
      stopWatch();
    } catch (e) {
      const idle = timedOut();
      stopWatch();
      if (ctrl.signal.aborted) return 'done';
      if (idle) e = new Error(`model ${key} přestal odpovídat (${Math.round(OMNI_IDLE_MS / 1000)} s ticha)`);
      try {
        if (!res.headersSent) fail(res, 400, `OmniRoute: ${e.message}. Zkus to znovu.`, 'zdarma_no_model_available');
        else { res.write(`data: ${JSON.stringify({ error: { message: `OmniRoute: ${e.message}`, type: 'server' } })}\n\n`); res.end('data: [DONE]\n\n'); }
      } catch {}
      tracker?.record({ provider: provId, providerName: pname, model: key, ok: false, kind: 'server', error: e.message, tier, project });
      if (tr) { try { trace({ ...tr, ok: false, model: key, error: String(e.message).slice(0, 160), ms: Date.now() - t0 }); } catch {} }
      return 'done';
    }
    const argsOk = (a) => { try { JSON.parse(a || '{}'); return true; } catch { return false; } };
    const calls = new Map(done().map((t, k) => [k, t.function.arguments]));
    const toolCalls = calls.size;
    const u = usage || usage_est(estTok, 'x'.repeat(content), []);
    tracker?.record({ provider: provId, providerName: pname, model: key, ok: true, usage: u, tier, project });
    activity.last = { requested, model: key, providerName: pname, tier, at: Date.now(), ms: Date.now() - t0, ok: true, project };
    if (tr) {
      tr.attempts.push({ model: key, ok: true, ms: Date.now() - t0, ttfbMs, finish, content, reasoning, toolCalls, badArgs: [...calls.values()].filter((a) => !argsOk(a)).length, fixedArgs, inTok: usage?.prompt_tokens ?? null, outTok: usage?.completion_tokens ?? null });
      try { trace({ ...tr, ok: true, model: key, ms: Date.now() - t0 }); } catch {}
    }
    onLog({ at: Date.now(), ok: true, requested, model: key, ms: Date.now() - t0, tried: [combo], tools: toolCalls });
    chain();
    cap({ rid, via: 'omniroute', requested, combo, model: key, ms: Date.now() - t0, ttfbMs, ok: true, project, params: paramsOf(body), tools: (tools || []).map((x) => x.function.name), messages, out: { content: textAcc, reasoning: reasonAcc, toolCalls: done(), finish, usage, fixedArgs } });
    return 'done';
  }

  async function chat(req, res, body) {
    const rid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { return await chatInner(req, res, body, rid); } finally { activity.current.delete(rid); }
  }

  async function chatInner(req, res, body, rid) {
    const t0 = Date.now();
    const settings = getSettings();
    const requested = String(body.model || 'auto').replace(/^zdarma\//, '');
    const stream = !!body.stream;
    const includeUsage = !!body.stream_options?.include_usage;
    const tools = Array.isArray(body.tools) && body.tools.length ? body.tools.filter((t) => t?.function?.name) : null;
    const names = (tools || []).map((t) => t.function.name);
    const schemas = schemasOf(tools);
    let fixedArgs = 0;
    const messages = sanitize(body.messages);
    if (!messages.length) return fail(res, 400, 'messages chybí');
    // Hlubší přemýšlení pro kroky agenta na tierlistech (ne Low: názvy chatů musí být rychlé). Změřeno
    // 8. 11. na úloze „prázdné okno“ (test/capture-opencode.js blankapp, NVIDIA Nemotron 3 Ultra):
    // bez → opraveno za 4,4 min / 46 požadavků, s high → 3,2 min / 34. Model jinak přemýšlel ~94 tokenů na krok.
    let effortInjected = false;
    const effort = settings.reasoningEffort === undefined ? 'high' : settings.reasoningEffort;
    if (effort && effort !== 'off' && tools && DEEP_TIERS.has(requested) && body.reasoning_effort == null && body.reasoning == null) {
      body = { ...body, reasoning_effort: effort };
      effortInjected = true;
    }
    const clean = { ...body, messages };
    const estTok = estTokens(messages) + estTokens(tools || []);
    const project = projectOf(messages); // pracovní složka z promptu OpenCode → součty za projekt
    {
      const last = messages[messages.length - 1] || {};
      const lastTxt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || last.tool_calls || '');
      liveEv({ src: 'proxy', kind: 'req', rid, requested, msgs: messages.length, estTok: estTokens(messages) + estTokens(body.tools || []), tools: (body.tools || []).length, lastRole: last.role, last: lastTxt.length > 400 ? lastTxt.slice(0, 400) + '…' : lastTxt, project });
    }
    // Klient (OpenCode) většinou max_tokens posílá. Když ne, provider usekne odpověď sám
    // (Groq: 3 072 tokenu, finish=length) – proto posíláme default explicitně.
    let maxOut = Math.min(Number(body.max_tokens || body.max_completion_tokens) || DEFAULT_OUT, MAX_OUT);

    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });

    // Tierlisty a auto směruje OmniRoute (když běží); při jeho nedostupnosti vlastní směrování níže.
    const eng = omni();
    const combo = eng?.comboFor(requested);
    if (combo) {
      const r = await viaOmni({ eng, combo, body, messages, res, ctrl, stream, includeUsage, requested, project, rid, t0, estTok, tools, maxOut });
      if (r !== 'fallback') return;
    }

    const { models } = await registry.list();
    const list = candidates({ registry, models, requested, fallback: settings.fallback !== false, estTok, settings });
    const id = 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const created = Math.floor(Date.now() / 1000);

    let started = false;
    let used = null;
    const startSSE = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Zdarma-Model': used?.key || '' });
    };
    const chunk = (delta, finish = null, extra = {}) => {
      startSSE();
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: used?.key || requested, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    };
    let sentRole = false;
    const delta = (d) => { if (!stream) return; chunk(sentRole ? d : { role: 'assistant', ...d }); sentRole = true; };

    const tried = [];
    const capTried = new Set(); // per-request: cap už zkoušíme, ať neskáčí dokola
    const quotaTried = new Set(); // per-request: clamp podle zbývající kvoty zkoušíme jen jednou
    let lastErr = null;
    // Technický záznam požadavku (bez obsahu zpráv) – pro diagnostiku kvality (proxy-trace.jsonl).
    const tr = trace ? { at: Date.now(), requested, via: 'zdarma', project, msgs: messages.length, estTok, maxTokensReq: Number(body.max_tokens || body.max_completion_tokens) || null, tools: (tools || []).length, attempts: [] } : null;
    const argsOk = (a) => { try { JSON.parse(a || '{}'); return true; } catch { return false; } };
    for (let pass = 0; pass < 2; pass++) {
    // Pokus = skutečné volání modelu. Přeskočený model (pauza po limitu, vypnutý poskytovatel) se nepočítá:
    // dřív 20 modelů Hugging Face s pauzou (402) vyčerpalo všech 15 pokusů dřív, než došlo na fungující
    // Kilo Nemotron (živý záznam 8. 11. 13:09: „Žádný free model teď neodpověděl“ za 1,1 s).
    for (let attempt = 0, i = 0; attempt < MAX_ATTEMPTS && i < list.length; attempt++) {
      if (ctrl.signal.aborted) return;
      while (i < list.length) {
        const m = list[i];
        const p = registry.provider(m.provider);
        const cooling = registry.isCooling(m.key) || registry.isCooling('provider:' + m.provider);
        if ((!cooling || (i === 0 && requested !== 'auto' && requested !== 'auto-unfiltered' && settings.fallback === false)) && p && p.enabled) break;
        i++;
      }
      if (i >= list.length) break;
      const model = list[i];
      const prov = registry.provider(model.provider);
      used = model;
      const pname = prov.p.name || model.providerName || model.provider;
      activity.current.set(rid, { requested, model: model.key, providerName: pname, tier: model.tier || null, since: Date.now(), project });
      try {
        const { textMode, res: r } = await callModel({
          registry, prov, model, body: effortInjected && !EFFORT_PROVIDERS.has(model.provider) ? { ...clean, reasoning_effort: undefined } : clean, tools, signal: ctrl.signal, maxOut,
          onDelta: (d) => delta({ content: d }),
          onReasoning: (d) => delta({ reasoning_content: d }),
        });
        let content = r.content || '';
        let toolCalls = r.toolCalls || [];
        if (tools && !toolCalls.length && /<tool_call>|```/.test(content)) {
          const p = parseTextCalls(content, names);
          if (p.toolCalls.length) { content = p.content; toolCalls = p.toolCalls; }
        }
        toolCalls = toolCalls.map((t, k) => {
          const name = cleanName(t.function.name, names);
          const c = coerceArgs(t.function.arguments || '{}', schemas.get(name));
          if (c.fixed) fixedArgs++;
          const out = { id: t.id || `call_${id}_${k}`, type: 'function', function: { name, arguments: c.args } };
          rememberSignature(out.id, t.extra_content);
          return out;
        });
        tr?.attempts.push({ model: model.key, ok: true, ms: Date.now() - t0, finish: r.finishReason || null, textMode, maxOut, content: content.length, reasoning: String(r.reasoning || '').length, toolCalls: toolCalls.length, badArgs: toolCalls.filter((t) => !argsOk(t.function.arguments)).length, fixedArgs, inTok: r.usage?.prompt_tokens ?? null, outTok: r.usage?.completion_tokens ?? null });
        if (!content.trim() && !toolCalls.length && !String(r.reasoning || '').trim()) throw new ProviderError('Model vrátil prázdnou odpověď', { kind: 'server' });

        const used = r.usage || usage_est(estTok, content, toolCalls);
        const finish = toolCalls.length ? 'tool_calls' : 'stop';
        tried.push(model.key);
        registry.noteUnitedSuccess?.(model.key);
        tracker?.record({ provider: model.provider, providerName: pname, model: model.key, ok: true, usage: used, rate: r.rate, tier: model.tier, project });
        activity.last = { requested, model: model.key, providerName: pname, tier: model.tier || null, at: Date.now(), ms: Date.now() - t0, ok: true, project };
        if (tr) { try { trace({ ...tr, ok: true, model: model.key, ms: Date.now() - t0 }); } catch {} }
        cap({ rid, via: 'zdarma', requested, model: model.key, ms: Date.now() - t0, ok: true, project, params: paramsOf(body), tools: names, messages, out: { content, reasoning: r.reasoning || '', toolCalls, finish: r.finishReason || null, usage: r.usage || null, fixedArgs } });
        onLog({ at: Date.now(), ok: true, requested, model: model.key, ms: Date.now() - t0, tried, tools: toolCalls.length });
        if (stream) {
          if (textMode || prov.p.kind === 'horde') {
            if (r.reasoning && prov.p.kind === 'horde') delta({ reasoning_content: r.reasoning });
            if (content) delta({ content });
          }
          if (toolCalls.length) delta({ tool_calls: toolCalls.map((t, k) => ({ index: k, ...t })) });
          if (!sentRole) delta({ content: '' });
          chunk({}, finish);
          if (includeUsage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model.key, choices: [], usage: used })}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          const message = { role: 'assistant', content: content || (toolCalls.length ? null : '') };
          if (r.reasoning) message.reasoning_content = r.reasoning;
          if (toolCalls.length) message.tool_calls = toolCalls;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Zdarma-Model': model.key });
          res.end(JSON.stringify({ id, object: 'chat.completion', created, model: model.key, choices: [{ index: 0, message, finish_reason: finish }], usage: used }));
        }
        return;
      } catch (e) {
        if (ctrl.signal.aborted || e.kind === 'aborted') return;
        const err = e instanceof ProviderError ? e : new ProviderError(e.message, { kind: 'other' });
        lastErr = { model: model.key, err };
        tried.push(model.key);
        tr?.attempts.push({ model: model.key, ok: false, kind: err.kind, ms: Date.now() - t0, msg: String(err.message).slice(0, 140) });
        tracker?.record({ provider: model.provider, providerName: pname, model: model.key, ok: false, kind: err.kind, error: err.message, rate: err.rate, tier: model.tier, project });
        if (started) {
          // Část odpovědi už odešla – jiný model by navázal nesmyslně. Pošleme chybu, klient zkusí znovu.
          onLog({ at: Date.now(), ok: false, requested, model: model.key, ms: Date.now() - t0, tried, error: err.message.slice(0, 300) });
          res.write(`data: ${JSON.stringify({ error: { message: `${model.key}: ${err.message}`, type: err.kind } })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        if (err.kind === 'no_tools' && !registry.textMode.has(model.key)) { registry.textMode.add(model.key); continue; }
        if (err.kind === 'context') {
          // Provider pověděl svůj strop odpovědi → posíláme rovnou jeho hodnotu (dřív skok na 4096
          // = polovina skutečných možností modelu). Cap pamatujeme pro další požadavky.
          const cap = outCapFromError(err.message);
          if (cap >= 512 && (maxOut == null || maxOut > cap) && !capTried.has(model.key)) {
            setCap(hardCaps, model.key, cap, HARD_CAP_TTL_MS);
            maxOut = cap;
            capTried.add(model.key);
            continue;
          }
          if (maxOut == null || maxOut > 4096) { maxOut = 4096; continue; } // limit počítá i max_tokens
          i++; continue; // na tenhle požadavek je model malý, ale jinak je v pořádku
        }
        // Provider usekl request, protože max_tokens exceeded the remaining output quota (Groq:
        // „Request too large … OTPM: Limit 1000, Used 900, Requested 1329“). Dřív: pauza 30 min
        // = model nezodpovědi ani dotaz „Ahoj“. Nově: posíláme kolik tokenů zbývá, tentýž model
        // zkoušíme znovu, odpověď přijde v tom samém requestu.
        const rem = ADAPT_OUT ? outLimitFromQuota(err.message) : null;
        if (rem != null && rem >= 512 && (maxOut == null || maxOut > rem) && !quotaTried.has(model.key)) {
          setCap(quotaCaps, model.key, rem, QUOTA_TTL_MS);
          maxOut = rem;
          quotaTried.add(model.key);
          continue;
        }
        const wide = providerWide(err, model.provider);
        // OTPM is a per-minute limit: a 30-minute pause would be a needlessly long app limit.
        const cool = rem != null ? Math.min(cooldownFor(err), QUOTA_TTL_MS) : cooldownFor(err);
        registry.cool(wide ? `provider:${model.provider}` : model.key, cool, (KIND_CZ[err.kind] || err.kind) + (wide ? ' (celý účet)' : '') + ' [proxy]');
        i++;
      }
    }
      // Nic neprošlo. Když se některý model z pořadí uvolní do 20 s (vyprší pauza po limitu), počkat
      // a projít pořadí ještě jednou – krátký limit tak OpenCode vůbec nepozná.
      const now = Date.now();
      const soon = list.map((m) => registry.coolingInfo(m.key)?.until).filter((u) => u && u > now).sort((a, b) => a - b)[0];
      if (pass > 0 || !soon || soon - now > SELF_WAIT_MS || now - t0 > 90000) break;
      await new Promise((r) => {
        const t = setTimeout(r, soon - now + 250);
        ctrl.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
      });
      if (ctrl.signal.aborted) return;
    }
    const msg = lastErr
      ? `Žádný free model teď neodpověděl. Poslední: ${lastErr.model}: ${lastErr.err.message}`
      : (requested === 'auto-unfiltered' ? 'Není dostupný žádný necenzurovaný model.' : 'Není dostupný žádný free model (všechny mají pauzu, nebo chybí klíče v Zdarma → Nastavení).');
    onLog({ at: Date.now(), ok: false, requested, model: lastErr?.model || null, ms: Date.now() - t0, tried, error: msg.slice(0, 300) });
    activity.last = { requested, model: lastErr?.model || null, at: Date.now(), ok: false, error: msg.slice(0, 200), project };
    if (tr) { try { trace({ ...tr, ok: false, error: msg.slice(0, 160), ms: Date.now() - t0 }); } catch {} }
    // Ne 429/5xx: na ty OpenCode odpovídá nekonečným opakováním, relace zůstane „pracuje“ (visí i seznam
    // úkolů) a nic se neděje. Proxy už prošla všechny modely, opakování hned nepomůže → chyba, kterou
    // OpenCode neopakuje: tah skončí a uživatel uvidí zprávu.
    cap({ rid, via: 'zdarma', requested, ok: false, error: msg, project, params: paramsOf(body), tools: names, messages, attempts: tr?.attempts });
    fail(res, 400, `${msg} Zkus to za chvíli znovu, nebo přidej klíče / jiný tierlist.`, 'zdarma_no_model_available');
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Jen lokální klienti, žádné webové stránky z prohlížeče (ty posílají Origin).
      if (req.headers.origin) return fail(res, 403, 'Požadavky z prohlížeče nejsou povolené');
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '');
      if (req.method === 'GET' && (p === '' || p === '/health')) return json(res, 200, { ok: true, name: 'zdarma-proxy', version });
      if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) return await listModels(res);
      if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
        if (!/application\/json/i.test(req.headers['content-type'] || '')) return fail(res, 415, 'Content-Type musí být application/json');
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 64 * 1024 * 1024) return fail(res, 413, 'Požadavek je moc velký'); }
        let body;
        try { body = JSON.parse(raw); } catch { return fail(res, 400, 'Neplatný JSON'); }
        server.inflight++;
        try { return await chat(req, res, body); } finally { server.inflight--; server.lastAt = Date.now(); }
      }
      // diagnostika pro rozbor zvenku (jen GET, jen lokálně, bez Origin – viz kontrola nahoře)
      if (req.method === 'GET' && diagApi && p.startsWith('/zdarma/')) {
        const n = Math.max(1, Math.min(2000, Number(url.searchParams.get('n')) || 0));
        if (p === '/zdarma/diag') return json(res, 200, await diagApi.diag(url.searchParams.get('session') || null));
        if (p === '/zdarma/live') return json(res, 200, diagApi.live(n || 200));
        if (p === '/zdarma/full') return json(res, 200, diagApi.full(n || 5));
        if (p === '/zdarma/requests') return json(res, 200, diagApi.requests(n || 100));
      }
      fail(res, 404, `Neznámá cesta ${req.method} ${p}`);
    } catch (e) {
      if (!res.headersSent) fail(res, 500, e.message);
      else try { res.end(); } catch {}
    }
  });
  server.activity = activity; // který model právě pracuje / naposledy pracoval
  server.inflight = 0; // rozpracované požadavky (agent právě čeká na model)
  server.lastAt = 0; // kdy skončil poslední požadavek
  server.keepAliveTimeout = 65000;
  server.requestTimeout = 0; // dlouhé generování (lokální modely, AI Horde)
  return server;
}

/** Spustí server na 127.0.0.1:port. Vrací {server, port} nebo vyhodí chybu (např. EADDRINUSE). */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

module.exports = { createProxy, listen, sanitize, parseTextCalls, toTextProtocol, candidates, cleanName, projectOf, withSignatures, rememberSignature, coerceArgs, outCapFromError, outLimitFromQuota, outCapOf, outFor, capRetry, hardCaps, quotaCaps, MAX_OUT, DEFAULT_OUT };
