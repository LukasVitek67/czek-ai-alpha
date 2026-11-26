'use strict';
// Poskytovatelé free modelů. Všichni mluví OpenAI-kompatibilním /chat/completions.
// Každý umí vylistovat své modely a označit, které jsou zdarma a umí nástroje (tool calling).

const horde = require('./horde');

// Necenzurované / "abliterated" modely poznáme podle názvu (případně popisu). Doplňuje ruční označení v appce.
const UNCENSORED = /uncensor|abliterat|heretic|unfilter|unrestrict|unaligned|dolphin|venice|nsfw|lexi\b|hermes|stheno|rocinante|behemoth|cydonia|magnum|euryale|lunaris|mythomax|remm-|weaver|meromero|hauhau|thedrummer|pygmalion|airoboros|wizard-?vicuna|tiger-gemma|big-tiger|nous-capybara|wicked|eclipse|bluestar/i;
const isUncensored = (m) => UNCENSORED.test(`${m.id} ${m.name || ''} ${m.desc || ''}`);

const NOT_CHAT = /orpheus|playai|-image|image-|nano-banana|-live|live-|robotics|computer-use|translate|customtools|embed|rerank|whisper|tts|speech|transcri|guard|safety|moderation|reward|imagen|veo|lyria|image-gen|dall-e|audio|aqa|clip|ocr|parse|retriever|nv-embed|bge|e5-/i;

async function getJson(url, headers = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.error?.message || j.message || j.detail || msg; } catch {}
      const e = new Error(`HTTP ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      e.status = r.status;
      throw e;
    }
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Vypršel čas (server neodpovídá)');
    throw e;
  } finally { clearTimeout(t); }
}

const bearer = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

// Poskytovatel, jehož /models chce klíč: s klíčem skutečný seznam (filtr), bez něj / při chybě známé modely.
async function keyedList(p, key, filter, fallback = []) {
  if (key) {
    try {
      const j = await getJson(`${p.baseUrl}/models`, p.headers(key));
      const l = (j.data || []).filter((m) => m.id && !NOT_CHAT.test(m.id) && filter(m))
        .map((m) => ({ id: m.id, name: m.name || m.display_name, context: m.context_length || m.context_window || null, tools: (m.supported_parameters || []).includes('tools') || null }));
      if (l.length) return l;
    } catch {}
  }
  return fallback.map((id) => ({ id, context: null, tools: null }));
}
const zeroPrice = (...xs) => xs.length > 0 && xs.every((x) => x != null && Number(x) === 0);

// Standardní /models → [{id, tools, context}]
async function listOpenAIModels(p, key, filter = () => true) {
  const j = await getJson(`${p.baseUrl}/models`, p.headers(key));
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  return arr
    .map((m) => ({ id: m.id || m.name, context: m.context_length || m.context_window || m.max_context_length || null, tools: m.tools ?? null, raw: m }))
    .filter((m) => m.id && !NOT_CHAT.test(m.id) && filter(m));
}

// Rodiny modelů vhodné na chat/kód u poskytovatelů s obrovským katalogem (Together, Fireworks…) a co vynechat.
const CHAT_FAMILIES = /instruct|chat|coder|deepseek|qwen|kimi|glm|llama-?[34]|gpt-oss|mistral|minimax|nemotron|gemma|hermes/i;
const NOT_LLM = /vl\b|vision|embed|rerank|whisper|tts|image|flux|sdxl|guard|moderation|audio|ocr/i;

const PROVIDERS = [
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/inference/v1', // 14. 10. 2026 přesunuto ze /zen/v1
    needsKey: true,
    keyUrl: 'https://opencode.ai/auth',
    note: 'Free modely z OpenCode (Big Pickle, GLM, DeepSeek Flash, Nemotron…). Bez klíče je czek-ai nabízí přímo v OpenCode (skupina OpenCode Zen, při limitu sama přejde na Max); klíč z opencode.ai je přidá i do tierlistů.',
    headers: (key) => ({ ...bearer(key) }),
    async listModels(key) {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => {
          const c = m.cost?.text;
          return c && Number(c.input?.price) === 0 && Number(c.output?.price) === 0 && m.api?.['chat-completions'];
        })
        .map((m) => ({ id: m.id, name: m.name, context: m.limit?.context, tools: !!m.capabilities?.tools?.supported }));
    },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/settings/keys',
    note: 'Modely s příponou :free. Zdarma ~50 požadavků/den, po dobití 10 $ kreditu 1000/den.',
    headers: (key) => ({ ...bearer(key), 'HTTP-Referer': 'http://localhost/zdarma', 'X-Title': 'Zdarma' }),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
        .filter((m) => {
          const out = m.architecture?.output_modalities || ['text'];
          return out.includes('text') && !out.includes('audio') && !out.includes('image') && !NOT_CHAT.test(m.id);
        })
        .map((m) => ({ id: m.id, name: m.name, desc: /uncensor|unrestrict|unfilter/i.test(m.description || '') ? 'uncensored' : '', context: m.context_length, tools: (m.supported_parameters || []).includes('tools') }));
    },
  },
  {
    id: 'pollinations',
    name: 'Pollinations',
    baseUrl: 'https://text.pollinations.ai/openai',
    chatUrl: 'https://text.pollinations.ai/openai',
    needsKey: false,
    keyUrl: 'https://auth.pollinations.ai',
    note: 'Funguje bez klíče i registrace (anonymní tier). Pomalejší, menší modely – dobrá záloha.',
    headers: (key) => ({ ...bearer(key) }),
    async listModels(key) {
      const j = await getJson('https://text.pollinations.ai/models', {});
      const tiers = key ? ['anonymous', 'seed'] : ['anonymous'];
      return (Array.isArray(j) ? j : [])
        .filter((m) => tiers.includes(m.tier || 'anonymous') && !(m.output_modalities || []).includes('audio'))
        .map((m) => ({ id: m.name, name: m.description, tools: !!m.tools, context: null }));
    },
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    note: 'Velmi rychlé. Free tier bez karty (~30 req/min, ~1000 req/den na model).',
    headers: (key) => bearer(key),
    listModels(key) { return listOpenAIModels(this, key, (m) => m.raw.active !== false); },
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Free tier v AI Studio (Flash, Flash-Lite, Gemma). Velký kontext.',
    headers: (key) => bearer(key),
    async listModels(key) {
      const list = await listOpenAIModels(this, key, (m) => /gemini|gemma/i.test(m.id));
      return list.map((m) => ({ ...m, id: m.id.replace(/^models\//, ''), tools: !/gemma/i.test(m.id) }));
    },
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    needsKey: true,
    keyUrl: 'https://cloud.cerebras.ai',
    note: 'Extrémně rychlé. Free tier ~1M tokenů/den, menší kontext.',
    headers: (key) => bearer(key),
    listModels(key) { return listOpenAIModels(this, key); },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    note: 'Plán „Experiment“ zdarma (Devstral, Codestral, Mistral Large…), nízké limity za sekundu.',
    headers: (key) => bearer(key),
    async listModels(key) {
      const list = await listOpenAIModels(this, key, (m) => m.raw.capabilities?.completion_chat !== false);
      const seen = new Set();
      return list
        .filter((m) => { const n = m.raw.name || m.id; if (seen.has(n)) return false; seen.add(n); return true; })
        .map((m) => ({ ...m, tools: m.raw.capabilities ? !!m.raw.capabilities.function_calling : true, context: m.raw.max_context_length || m.context }));
    },
  },
  {
    id: 'github',
    name: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    needsKey: true,
    keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    note: 'Zdarma s GitHub účtem (token s oprávněním „Models: read“). GPT, DeepSeek, Llama, Phi… s denními limity.',
    headers: (key) => ({ ...bearer(key), 'X-GitHub-Api-Version': '2022-11-28' }),
    async listModels(key) {
      const j = await getJson('https://models.github.ai/catalog/models', this.headers(key));
      return (Array.isArray(j) ? j : [])
        .filter((m) => (m.supported_output_modalities || ['text']).includes('text') && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, name: m.name, context: m.limits?.max_input_tokens, tools: (m.capabilities || []).includes('tool-calling') }));
    },
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    needsKey: true,
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    note: 'Zdarma pro vývojáře (~40 req/min). Desítky open modelů: Kimi K3.1 Pro, DeepSeek V4.1, GLM 5.3, Qwen, Nemotron…',
    headers: (key) => bearer(key),
    // Modely, které build.nvidia.com nabízí, ale veřejný seznam /v1/models je (zatím) neuvádí.
    extraModels: [
      { id: 'moonshotai/kimi-k3.1-pro', context: 1048576, tools: true }, // build.nvidia.com/moonshotai/kimi-k3_1-pro (od 4. 11. 2026)
    ],
    listModels(key) {
      return listOpenAIModels(this, key, (m) => /instruct|chat|coder|deepseek|qwen|kimi|glm|nemotron|gpt-oss|llama-3|llama-4|mistral|minimax/i.test(m.id) && !/vl|vision|nvclip|cosmos|parakeet|fuyu|neva|kosmos/i.test(m.id))
        .then((l) => [...this.extraModels.filter((x) => !l.some((m) => m.id === x.id)), ...l].map((m) => ({ ...m, tools: true })));
    },
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    needsKey: true,
    keyUrl: 'https://huggingface.co/settings/tokens',
    note: 'Router přes desítky inference poskytovatelů. Free účet má malý měsíční kredit.',
    headers: (key) => bearer(key),
    async listModels(key) {
      const list = await listOpenAIModels(this, key);
      return list.map((m) => ({ ...m, tools: (m.raw.providers || []).some((p) => p.supports_tools) || null, context: (m.raw.providers || []).map((p) => p.context_length).filter(Boolean)[0] || null }));
    },
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    needsKey: true,
    keyUrl: 'https://cloud.sambanova.ai/apis',
    note: 'Rychlé velké open modely (DeepSeek, Llama, Qwen), free tier s limity.',
    headers: (key) => bearer(key),
    listModels(key) { return listOpenAIModels(this, key).then((l) => l.map((m) => ({ ...m, tools: true }))); },
  },
  // --- přidáno 7. 11. 2026 (ověřeno živě nebo podle oficiální dokumentace) ---
  {
    id: 'ovh',
    name: 'OVHcloud AI Endpoints',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    needsKey: false,
    keyUrl: 'https://endpoints.ai.cloud.ovh.net',
    note: 'Evropský poskytovatel, funguje bez klíče i registrace: gpt-oss-120b, Qwen3.5 397B, Llama 3.3 70B… Bez klíče od listopadu 2026 jen 1 dotaz na model a IP za rok (změřeno 20. 11.: hlavička x-ratelimit-limit-year: 1, pak 429 do 1. 1.) – prakticky jen záloha. S klíčem se platí za tokeny.',
    headers: (key) => bearer(key),
    listModels(key) {
      return listOpenAIModels(this, key, (m) => !/stable-diffusion|whisper|guard|bge|e5|embed/i.test(m.id))
        .then((l) => l.map((m) => ({ ...m, tools: /gpt-oss|qwen3|llama-3_3|mistral-small/i.test(m.id) ? true : null })));
    },
  },
  {
    id: 'llm7',
    name: 'LLM7.io',
    baseUrl: 'https://api.llm7.io/v1',
    needsKey: false,
    keyUrl: 'https://llm7.io',
    note: 'Funguje bez klíče (anonymně). S free tokenem z llm7.io má vyšší limity (~60 req/min, ~100 tis. tokenů/den). Zdarma jsou jen modely tieru „turbo“ (gpt-oss 20B, Codestral, Nemotron 3 Nano…), „pro“ modely jsou placené.',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => String(m.tier).toLowerCase() !== 'pro' && (m.model_type || 'chat') === 'chat' && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, context: (typeof m.context_window === 'object' ? m.context_window?.tokens : m.context_window) || null, tools: m.tools_calling ?? null }));
    },
  },
  {
    id: 'kilo',
    name: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    needsKey: false,
    keyUrl: 'https://kilo.ai',
    note: 'Free modely brány Kilo Code bez klíče (asi 200 požadavků/hod na IP): Nemotron 3 Ultra 550B, Beam, openrouter/free… Nabídka se často mění. Kilo uvádí, že vstupy free modelů může poskytovatel ukládat – nic citlivého.',
    headers: (key) => bearer(key),
    async listModels(key) {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => /:free$|-free$|\/free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0))
        .filter((m) => (m.architecture?.output_modalities || ['text']).includes('text') && !NOT_CHAT.test(m.id) && (key || !/crouton-alpha/i.test(m.id)))
        .map((m) => ({ id: m.id, name: m.name, context: m.context_length || null, tools: (m.supported_parameters || []).includes('tools') || null }));
    },
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    needsKey: true,
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    note: 'Oficiální API GLM od Z.ai. Zdarma jsou GLM-4.7-Flash (200k kontext), GLM-4.5-Flash a GLM-4.6V-Flash (vidí obrázky), ostatní GLM jsou placené. Jen 1 souběžný požadavek. Klíč typu Standard (ne GLM Coding Plan).',
    headers: (key) => bearer(key),
    // Z.ai nemá /models; zdarma podle ceníku docs.z.ai (7. 11. 2026)
    listModels() {
      return Promise.resolve([
        { id: 'glm-4.7-flash', context: 200000, tools: null },
        { id: 'glm-4.5-flash', context: 128000, tools: null },
        { id: 'glm-4.6v-flash', context: 128000, tools: null },
      ]);
    },
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts',
    needsKey: true,
    keyUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
    keyHint: 'Account ID:API token',
    note: '10 000 neuronů denně zdarma (gpt-oss-120b, Llama 4 Scout, Qwen3, GLM-4.7-Flash, Gemma 4…). Klíč zadej jako „Account ID:API token“: v Cloudflare → Workers AI → Use REST API vytvoř token a zkopíruj i Account ID. Kimi, DeepSeek V4 a GLM 5 jsou tu jen placené.',
    splitKey(key) {
      const s = String(key || '');
      const i = s.indexOf(':');
      return i > 0 ? { account: s.slice(0, i).trim(), token: s.slice(i + 1).trim() } : { account: '', token: s.trim() };
    },
    chatUrlFor(key) { return `${this.baseUrl}/${this.splitKey(key).account}/ai/v1/chat/completions`; },
    headers(key) { return bearer(this.splitKey(key).token); },
    async listModels(key) {
      const PAID = /kimi|deepseek-v4|glm-5/i; // jen s placeným Workers / AI Gateway kredity
      const { account, token } = this.splitKey(key);
      if (!account || !token) throw new Error('Klíč zadej jako „Account ID:API token“');
      try {
        const j = await getJson(`${this.baseUrl}/${account}/ai/models/search?task=Text%20Generation&per_page=200`, bearer(token));
        const list = (j.result || []).filter((m) => m.name && !PAID.test(m.name)).map((m) => {
          const prop = (id) => (m.properties || []).find((p) => p.property_id === id)?.value;
          return { id: m.name, context: Number(prop('context_window')) || null, tools: String(prop('function_calling')) === 'true' ? true : null };
        });
        if (list.length) return list;
      } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
      return [ // záloha, kdyby vyhledávání modelů nešlo
        { id: '@cf/openai/gpt-oss-120b', context: 128000, tools: true },
        { id: '@cf/openai/gpt-oss-20b', context: 128000, tools: true },
        { id: '@cf/meta/llama-4-scout-17b-16e-instruct', context: 131000, tools: null },
        { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', context: 24000, tools: null },
        { id: '@cf/qwen/qwen3-30b-a3b-fp8', context: 32000, tools: true },
        { id: '@cf/qwen/qwen3.8-27b', context: null, tools: null },
        { id: '@cf/zai-org/glm-4.7-flash', context: null, tools: null },
        { id: '@cf/google/gemma-4-26b-a4b-it', context: null, tools: null },
        { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', context: null, tools: null },
        { id: '@cf/nvidia/nemotron-3-120b-a12b', context: null, tools: null },
      ];
    },
  },
  {
    id: 'cohere',
    name: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    needsKey: true,
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    note: 'Trial klíč zdarma: 1000 volání měsíčně, 20/min, jen nekomerční použití. Command A, Command R+, Aya.',
    headers: (key) => bearer(key),
    async listModels(key) {
      try {
        const j = await getJson('https://api.cohere.com/v1/models?endpoint=chat&page_size=100', bearer(key));
        const list = (j.models || []).filter((m) => m.name && !NOT_CHAT.test(m.name)).map((m) => ({ id: m.name, context: m.context_length || null, tools: (m.features || []).includes('tools') || (m.features || []).includes('tool_use') || null }));
        if (list.length) return list;
      } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
      return ['command-a-03-2025', 'command-r-plus-08-2024', 'command-r-08-2024', 'command-r7b-12-2024'].map((id) => ({ id, context: 128000, tools: true }));
    },
  },
  {
    id: 'unorouter',
    name: 'UnoRouter',
    baseUrl: 'https://api.unorouter.com/v1',
    needsKey: true,
    keyUrl: 'https://unorouter.com',
    note: 'Router třetí strany se 160+ modely s příponou :free (DeepSeek V4 Flash, GLM 5.3 Flash, GLM-4.7-Flash, Qwen, Cohere…). Přihlášení přes GitHub nebo Discord, bez karty. Asi 1 požadavek/min na model. Neposílej přes něj citlivá data.',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => /:free$/.test(m.id) && !NOT_CHAT.test(m.id) && (m.supported_endpoint_types || ['openai']).includes('openai'))
        .map((m) => ({ id: m.id, context: m.context_length || null, tools: null }));
    },
  },
  // ---- routery a brány s free modely (ověřeno 8. 11. 2026 z jejich veřejných /models a stránek; s klíčem
  //      neotestováno – klíč si uživatel vytvoří sám). Všechny OpenAI-kompatibilní, bez karty, není-li uvedeno jinak.
  {
    id: 'requesty',
    name: 'Requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    needsKey: true,
    keyUrl: 'https://app.requesty.ai/sign-up',
    note: 'Router s free modely: Nemotron 3 Ultra 550B a Super 120B (1M kontext), Gemma 4 31B, Leanstral, Ling 3.1 Flash… Zdarma 200 požadavků/den dohromady, bez karty.',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => zeroPrice(m.input_price, m.output_price) && (m.api || 'chat') === 'chat' && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, context: m.context_window || null, tools: m.supports_tool_calling ?? null }));
    },
  },
  {
    id: 'orcarouter',
    name: 'OrcaRouter',
    baseUrl: 'https://api.orcarouter.ai/v1',
    needsKey: true,
    keyUrl: 'https://www.orcarouter.ai/offers',
    note: 'Router s modely za $0: DeepSeek V4.1 Flash a V4 Flash, GLM 5.3 Flash, Tencent Hy3 (10 požadavků/min, 50/den) a Hy4 Preview (50/min, 250/den). Free modely jen pro účty s GitHubem, který má nějakou historii (nový účet až po čekací době).',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => /-free$|\/free$/.test(m.id) && !/orcaverify/.test(m.id) && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, name: m.name, context: m.context_length || null, tools: (m.supported_parameters || []).includes('tools') || null }));
    },
  },
  {
    id: 'routeway',
    name: 'RouteWay',
    baseUrl: 'https://api.routeway.ai/v1',
    needsKey: true,
    keyUrl: 'https://routeway.ai',
    note: 'Router s modely :free: DeepSeek V4.1 Flash, MiniMax M3.1 Flash, Muse Glimmer 30B, Gemma 4… Asi 5 požadavků/min a 200/den. Kontext free modelů jen 42–131k.',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => /:free$/.test(m.id) && m.available !== false && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, name: m.name, context: m.context_length || null, tools: (m.supported_parameters || []).includes('tools') || null }));
    },
  },
  {
    id: 'bazaarlink',
    name: 'BazaarLink',
    baseUrl: 'https://api.bazaarlink.ai/v1',
    needsKey: true,
    keyUrl: 'https://bazaarlink.ai/free',
    note: 'Brána s free modely: DeepSeek V4 Flash, Qwen 3.7 Flash, Nemotron 3.5 Lightning, Beam, auto:free (1M kontext). Bez karty 10 požadavků/min, 60 „jednotek“/den (delší vstup spotřebuje víc), 2 souběžné.',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        // každý free model má i alias bez prefixu – brát jen kanonické ID s :free
        .filter((m) => /:free$/.test(m.id) && zeroPrice(m.pricing?.prompt, m.pricing?.completion) && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, name: m.name, context: m.context_length || null, tools: null }));
    },
  },
  {
    id: 'airforce',
    name: 'Api.Airforce',
    baseUrl: 'https://api.airforce/v1',
    needsKey: true,
    keyUrl: 'https://api.airforce/signup/',
    note: 'Brána s free plánem: Kimi K2.7 Code, GLM-4.7-Flash, Mistral Large 4, Llama Instant… Jen 1 požadavek/min a 1000/den, takže jen jako poslední záloha. Neoficiální brána, citlivá data přes ni neposílej.',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => m.tier === 'free' && m.supports_chat && m.status !== 'major_outage' && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, context: m.max_tokens || null, tools: null }));
    },
  },
  {
    id: 'xkiro',
    name: 'xKiro',
    baseUrl: 'https://api.xkiro.com/v1',
    needsKey: true,
    keyUrl: 'https://xkiro.com',
    note: 'Router, zdarma 5M tokenů/den na účet: Mistral Large a Medium 3.5, Devstral Medium, Codestral, Cohere Command A, Big Pickle… Po vyčerpání do obnovy limitu chyba 429.',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => m.access_tier === 'free' && (!m.modality || /chat|text/.test(JSON.stringify(m.modality))) && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, name: m.display_name, context: m.context_length || null, tools: m.capabilities?.tools ?? null }));
    },
  },
  {
    id: 'tokenharbor',
    name: 'TokenHarbor',
    baseUrl: 'https://tokenharbor.ai/v1',
    needsKey: true,
    keyUrl: 'https://tokenharbor.ai/models?category=free',
    note: 'Modely :free (DeepSeek V4.1 Flash, MiMo V2.6 Flash) s klouzavým týdenním limitem, 60 požadavků/min. V účtu musíš nejdřív zapnout free trasy. Po zapnutí si mohou ukládat dotazy a odpovědi.',
    headers: (key) => bearer(key),
    listModels(key) { return keyedList(this, key, (m) => /:free$/.test(m.id), ['deepseek-v4.1-flash:free', 'mimo-v2.6-flash:free']); },
  },
  {
    id: 'nara',
    name: 'NaraRouter',
    baseUrl: 'https://router.bynara.id/v1',
    needsKey: true,
    keyUrl: 'https://bynara.id',
    note: 'Free plán: 7M tokenů/den, 15 požadavků/min, 8 modelů (MiniMax M3, Mistral Large a Medium 3.5, Qwen 3.8 27B, Step 3.7 Flash, Laguna S, Agnes). API odpovídá až po propojení účtu s Telegramem.',
    headers: (key) => bearer(key),
    listModels(key) {
      return keyedList(this, key, () => true, ['minimax-m3-free', 'mistral-large', 'mistral-medium-3-5', 'qwen3.8-27b', 'stepfun-3.7-flash', 'laguna-s-2.1', 'agnes-2.5-flash', 'agnes-2.0-flash']);
    },
  },
  {
    id: 'agnes',
    name: 'Agnes AI',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    needsKey: true,
    keyUrl: 'https://agnes-ai.com',
    note: 'Trvale zdarma, bez karty: vlastní modely Agnes 2.0 / 2.5 / 3.0 Flash. Na programování spíš slabší, hodí se jako záloha.',
    headers: (key) => bearer(key),
    listModels(key) { return keyedList(this, key, () => true, ['agnes-3.0-flash', 'agnes-2.5-flash', 'agnes-2.0-flash']); },
  },
  {
    id: 'arcee',
    name: 'Arcee AI',
    baseUrl: 'https://api.arcee.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://arcee.ai',
    note: 'Zdarma model Trinity Large Thinking (262k kontext), bez karty. Seznam modelů ukáže až s klíčem.',
    headers: (key) => bearer(key),
    listModels(key) { return keyedList(this, key, (m) => /trinity/i.test(m.id)); },
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    needsKey: true,
    keyUrl: 'https://vercel.com/docs/ai-gateway/pricing',
    note: 'Free modely za $0 (Nemotron 3.5 Lightning, Beam, Glyph Cluster) a k tomu $5 měsíčně na vybrané placené modely. POZOR: free kredit funguje až po zadání platební karty k týmu. Po koupi kreditu měsíční free kredit končí.',
    headers: (key) => bearer(key),
    async listModels() {
      const j = await getJson(`${this.baseUrl}/models`, {});
      return (j.data || [])
        .filter((m) => (m.type || 'language') === 'language' && zeroPrice(m.pricing?.input, m.pricing?.output) && !NOT_CHAT.test(m.id))
        .map((m) => ({ id: m.id, name: m.name, context: m.context_window || null, tools: (m.tags || []).includes('tool-use') || null }));
    },
  },
  // ---- ze seznamu github.com/OuterSpacee/free-ai-apis: jednorázový kredit nebo nejasný free tier.
  // Všechny jsou OpenAI-kompatibilní (adresy ověřené 8. 11. 2026: /models odpovídá 200/401). Bez klíče se nepoužijí.
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    needsKey: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    note: 'Jednorázový kredit po registraci (dřív 5 $), pak placené. DeepSeek, Qwen3 Coder, Kimi, GLM, Llama…',
    headers: (key) => bearer(key),
    listModels(key) {
      return listOpenAIModels(this, key, (m) => (m.raw?.type || 'chat') === 'chat' && CHAT_FAMILIES.test(m.id) && !NOT_LLM.test(m.id));
    },
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    needsKey: true,
    keyUrl: 'https://fireworks.ai/account/api-keys',
    note: 'Jednorázový kredit po registraci (1 $), pak placené. Rychlé DeepSeek, Kimi, Qwen3 Coder, GLM.',
    headers: (key) => bearer(key),
    listModels(key) {
      return listOpenAIModels(this, key, (m) => CHAT_FAMILIES.test(m.id) && !NOT_LLM.test(m.id));
    },
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    needsKey: true,
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    note: 'Kredit zdarma po registraci, pak placené (levné). Veřejný seznam modelů.',
    headers: (key) => bearer(key),
    listModels(key) {
      return listOpenAIModels(this, key, (m) => CHAT_FAMILIES.test(m.id) && !NOT_LLM.test(m.id));
    },
  },
  {
    id: 'novita',
    name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/openai',
    needsKey: true,
    keyUrl: 'https://novita.ai/settings/key-management',
    note: 'Jednorázový kredit po registraci (0,50 $), pak placené.',
    headers: (key) => bearer(key),
    listModels(key) {
      return listOpenAIModels(this, key, (m) => CHAT_FAMILIES.test(m.id) && !NOT_LLM.test(m.id));
    },
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    needsKey: true,
    keyUrl: 'https://app.hyperbolic.ai/settings',
    note: 'Free tier / kredit po registraci (limity neuvádí), pak placené.',
    headers: (key) => bearer(key),
    listModels(key) {
      return listOpenAIModels(this, key, (m) => CHAT_FAMILIES.test(m.id) && !NOT_LLM.test(m.id));
    },
  },
  {
    id: 'aimlapi',
    name: 'AI/ML API',
    baseUrl: 'https://api.aimlapi.com/v1',
    needsKey: true,
    keyUrl: 'https://aimlapi.com/app/keys',
    note: 'Agregátor, „free playground tier“ s omezeným využitím (čísla neuvádí), jinak placené.',
    headers: (key) => bearer(key),
    listModels(key) {
      return listOpenAIModels(this, key, (m) => /chat|completion/i.test(m.raw?.type || 'chat') && CHAT_FAMILIES.test(m.id) && !NOT_LLM.test(m.id));
    },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek (vlastní účet)',
    baseUrl: 'https://api.deepseek.com',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'POZOR: placené (levné), bez free tieru – použij jen s vlastním kreditem. Oficiální DeepSeek API.',
    headers: (key) => bearer(key),
    listModels(key) {
      return listOpenAIModels(this, key).then((l) => l.map((m) => ({ ...m, tools: true })));
    },
  },
  {
    id: 'horde',
    name: 'AI Horde (komunitní)',
    baseUrl: 'https://aihorde.net/api/v2',
    needsKey: false,
    keyUrl: 'https://aihorde.net/register',
    note: 'Síť dobrovolníků s vlastními GPU, hlavně necenzurované komunitní modely. Funguje bez klíče; free klíč z registrace dá přednost ve frontě. Bez nativních nástrojů, menší kontext, odpověď přijde najednou.',
    kind: 'horde',
    headers: () => ({}),
    listModels() { return horde.listModels(); },
  },
  {
    id: 'ollama',
    name: 'Ollama (lokálně)',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    local: true,
    keyUrl: 'https://ollama.com/download',
    note: 'Modely běžící na tvém PC. Zdarma navždy, bez limitů, jen tak rychlé jako tvoje GPU.',
    headers: (key) => bearer(key),
    listModels(key) { return listOpenAIModels(this, key).then((l) => l.map((m) => ({ ...m, tools: null }))); },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (lokálně)',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    local: true,
    keyUrl: 'https://lmstudio.ai',
    note: 'Lokální server LM Studia (Developer → Start Server).',
    headers: (key) => bearer(key),
    listModels(key) { return listOpenAIModels(this, key).then((l) => l.map((m) => ({ ...m, tools: null }))); },
  },
  {
    id: 'omniroute',
    name: 'OmniRoute (lokálně)',
    baseUrl: 'http://localhost:20128/v1',
    needsKey: false,
    local: true,
    keyUrl: 'https://github.com/diegosouzapw/OmniRoute',
    note: 'Lokální AI gateway (npm i -g omniroute && omniroute). Spojí další free účty, které v ní nastavíš.',
    headers: (key) => bearer(key),
    listModels(key) { return listOpenAIModels(this, key).then((l) => l.map((m) => ({ ...m, tools: null }))); },
  },
];

function makeCustomProvider(c) {
  return {
    id: c.id,
    name: c.name || c.id,
    baseUrl: String(c.baseUrl || '').replace(/\/+$/, ''),
    needsKey: false,
    custom: true,
    note: 'Vlastní OpenAI-kompatibilní endpoint.',
    headers: (key) => bearer(key),
    listModels(key) {
      if (c.models && c.models.trim()) {
        return Promise.resolve(c.models.split(/[\s,]+/).filter(Boolean).map((id) => ({ id, tools: null })));
      }
      return listOpenAIModels(this, key).then((l) => l.map((m) => ({ ...m, tools: m.tools ?? null })));
    },
  };
}

// Heuristika pořadí pro režim Auto: silnější kódovací modely dřív.
// Free modely, které 8. 11. 2026 v benchmarku (skutečné OpenCode, oprava 6 chyb v 5 souborech, test/capture-opencode.js
// bugfix) prošly 8/8: glyph-cluster za 6 kroků / 63k tokenů, beam-free 13 kroků, Nemotron 3 Ultra 11–15 kroků.
// Neprošly: cohere north-mini-code (2/8, vzdal to), stealth/crouton-alpha (403 bez účtu Kilo).
// 19. 11. 2026 (celá appka, těžší úloha: knihovna + fronta + časy proti 15 testům): tier Max s Nemotron 3 Ultra 15/15 za
// 120 s / 11 kroků, Gemini 3.6 Flash 15/15 za 199 s, Gemini 3 Flash 15/15 za 7 kroků; GLM 4.5 Flash 13/15 a nedokončil.
// 22. 11. 2026 (stejná úloha, docs/research/2026-11-22-claude-e2e/RESULTS.md): particle-1 15/15 za 40 s, ERNIE 5.5 Flash
// 15/15 za 50 s – do závodu vedle Nemotronu (ten 15/15 za 116–155 s).
// Od 22. 11. 2026 se seznam neskládá ručně: src/evidence.js + src/model-evidence.json (měření s datem, vyprší po 45 dnech).
// Regex výše uvedených modelů pouštěl i neměřené (gemini-3.7/3.8-flash) a staré měření nikdy nevypršelo.
const PROVEN = require('./evidence').matcher(require('./evidence').load());

function scoreModel(m) {
  const id = `${m.id} ${m.name || ''}`.toLowerCase();
  let s = 0;
  if (m.tools === true) s += 20;
  else if (m.tools === false) s -= 40;
  if (/coder|code|devstral|codestral/.test(id)) s += 6;
  if (/deepseek|glm-5|kimi|qwen3|big-pickle|beam|minimax|gpt-oss-120b|nemotron-3-ultra|ultra|gemini-3|gemini-2\.5-pro|large/.test(id)) s += 8;
  if (/flash|mini|nano|lite|small|lightning|2b|3b|4b|7b|8b|9b|fast/.test(id)) s -= 4;
  const b = id.match(/(\d+)b\b/);
  if (b) s += Math.min(8, Math.log2(Number(b[1]) + 1));
  if (m.context) s += Math.min(4, Math.log2(m.context / 32000 + 1) * 2);
  if (PROVEN.test(id)) s += 15; // ověřený měřením na skutečné úloze agenta (src/evidence.js)
  if (m.local) s -= 10; // lokální nechme jako zálohu (bývají pomalejší)
  if (m.eta != null) s += Math.min(5, m.workers || 1) - Math.min(25, m.eta / 10); // AI Horde: kratší fronta dřív
  return s;
}

/** Adresa /chat/completions poskytovatele (u Cloudflare závisí na Account ID v klíči). */
function chatUrlOf(p, key) {
  if (typeof p.chatUrlFor === 'function') return p.chatUrlFor(key);
  return p.chatUrl || `${p.baseUrl}/chat/completions`;
}

// Anglické popisy a názvy pro okno nastavení (jazyk English). Česky zůstává `note` přímo u poskytovatele.
const EN = {
  opencode: ['Free models from OpenCode (Big Pickle, GLM, DeepSeek Flash, Nemotron…). Without a key czek-ai offers them directly in OpenCode (OpenCode Zen group, switches to Max on limit); a key from opencode.ai adds them to the tier lists too.'],
  openrouter: ['Models with the :free suffix. About 50 requests/day free, 1000/day after a $10 top-up.'],
  pollinations: ['Works without a key or sign-up (anonymous tier). Slower, smaller models; a good backup.'],
  groq: ['Very fast. Free tier without a card (~30 req/min, ~1000 req/day per model).'],
  gemini: ['Free tier in AI Studio (Flash, Flash-Lite, Gemma). Large context.'],
  cerebras: ['Extremely fast. Free tier ~1M tokens/day, smaller context.'],
  mistral: ['Free “Experiment” plan (Devstral, Codestral, Mistral Large…), low per-second limits.'],
  github: ['Free with a GitHub account (token with “Models: read”). GPT, DeepSeek, Llama, Phi… with daily limits.'],
  nvidia: ['Free for developers (~40 req/min). Dozens of open models: Kimi K3.1 Pro, DeepSeek V4.1, GLM 5.3, Qwen, Nemotron…'],
  huggingface: ['Router across dozens of inference providers. A free account has a small monthly credit.'],
  sambanova: ['Fast large open models (DeepSeek, Llama, Qwen), free tier with limits.'],
  ovh: ['European provider, works without a key or sign-up: gpt-oss-120b, Qwen3.5 397B, Llama 3.3 70B… Without a key, since November 2026 only 1 request per model and IP per year (measured 20 Nov: header x-ratelimit-limit-year: 1, then 429 until 1 Jan) – practically a fallback only. With a key you pay for tokens.'],
  llm7: ['Works without a key (anonymously). A free token from llm7.io gives higher limits (~60 req/min, ~100k tokens/day). Only “turbo” tier models are free (gpt-oss 20B, Codestral, Nemotron 3 Nano…); “pro” models are paid.'],
  kilo: ['Free models of the Kilo Code gateway without a key (about 200 requests/hour per IP): Nemotron 3 Ultra 550B, Beam, openrouter/free… The offer changes often. Kilo says free-model prompts may be logged by the provider – nothing sensitive.'],
  zai: ['Official GLM API from Z.ai. Free: GLM-4.7-Flash (200k context), GLM-4.5-Flash and GLM-4.6V-Flash (sees images); other GLM models are paid. Only 1 concurrent request. Use a Standard key (not the GLM Coding Plan).'],
  cloudflare: ['10,000 neurons per day free (gpt-oss-120b, Llama 4 Scout, Qwen3, GLM-4.7-Flash, Gemma 4…). Enter the key as “Account ID:API token”: in Cloudflare → Workers AI → Use REST API create a token and copy the Account ID too. Kimi, DeepSeek V4 and GLM 5 are paid here.'],
  cohere: ['Free trial key: 1000 calls per month, 20/min, non-commercial use only. Command A, Command R+, Aya.'],
  unorouter: ['Third-party router with 160+ :free models (DeepSeek V4 Flash, GLM 5.3 Flash, GLM-4.7-Flash, Qwen, Cohere…). Sign in with GitHub or Discord, no card. About 1 request/min per model. Do not send sensitive data through it.'],
  requesty: ['Router with free models: Nemotron 3 Ultra 550B and Super 120B (1M context), Gemma 4 31B, Leanstral, Ling 3.1 Flash… 200 free requests/day in total, no card.'],
  orcarouter: ['Router with $0 models: DeepSeek V4.1 Flash and V4 Flash, GLM 5.3 Flash, Tencent Hy3 (10 requests/min, 50/day) and Hy4 Preview (50/min, 250/day). Free models only for accounts with a GitHub account that has some history (new accounts after a waiting period).'],
  routeway: ['Router with :free models: DeepSeek V4.1 Flash, MiniMax M3.1 Flash, Muse Glimmer 30B, Gemma 4… About 5 requests/min and 200/day. Free model context is only 42–131k.'],
  bazaarlink: ['Gateway with free models: DeepSeek V4 Flash, Qwen 3.7 Flash, Nemotron 3.5 Lightning, Beam, auto:free (1M context). Without a card: 10 requests/min, 60 “units”/day (longer input uses more), 2 concurrent.'],
  airforce: ['Gateway with a free plan: Kimi K2.7 Code, GLM-4.7-Flash, Mistral Large 4, Llama Instant… Only 1 request/min and 1000/day, so only as a last backup. Unofficial gateway; do not send sensitive data through it.'],
  xkiro: ['Router, 5M free tokens/day per account: Mistral Large and Medium 3.5, Devstral Medium, Codestral, Cohere Command A, Big Pickle… After the limit, error 429 until it resets.'],
  tokenharbor: ['Free models (DeepSeek V4.1 Flash, MiMo V2.6 Flash) with a rolling weekly limit, 60 requests/min. You must enable free routes in your account first. Once enabled, they may store prompts and replies.'],
  nara: ['Free plan: 7M tokens/day, 15 requests/min, 8 models (MiniMax M3, Mistral Large and Medium 3.5, Qwen 3.8 27B, Step 3.7 Flash, Laguna S, Agnes). The API answers only after linking the account with Telegram.'],
  agnes: ['Free forever, no card: own models Agnes 2.0 / 2.5 / 3.0 Flash. Rather weak for coding, useful as a backup.'],
  arcee: ['Free Trinity Large Thinking model (262k context), no card. The model list appears only with a key.'],
  vercel: ['$0 free models (Nemotron 3.5 Lightning, Beam, Glyph Cluster) plus $5 per month for selected paid models. NOTE: the free credit works only after adding a payment card to the team; buying credit ends the monthly free credit.'],
  together: ['One-time credit after sign-up (used to be $5), then paid. DeepSeek, Qwen3 Coder, Kimi, GLM, Llama…'],
  fireworks: ['One-time credit after sign-up ($1), then paid. Fast DeepSeek, Kimi, Qwen3 Coder, GLM.'],
  deepinfra: ['Free credit after sign-up, then paid (cheap). Public model list.'],
  novita: ['One-time credit after sign-up ($0.50), then paid.'],
  hyperbolic: ['Free tier / credit after sign-up (limits not stated), then paid.'],
  aimlapi: ['Aggregator, a “free playground tier” with limited use (no numbers given), otherwise paid.'],
  deepseek: ['NOTE: paid (cheap), no free tier; use only with your own credit. Official DeepSeek API.', 'DeepSeek (own account)'],
  horde: ['Network of volunteers with their own GPUs, mostly uncensored community models. Works without a key; a free key from sign-up gives queue priority. No native tools, smaller context, the reply arrives at once.', 'AI Horde (community)'],
  ollama: ['Models running on your PC. Free forever, no limits, only as fast as your GPU.', 'Ollama (local)'],
  lmstudio: ['LM Studio’s local server (Developer → Start Server).', 'LM Studio (local)'],
  omniroute: ['Local AI gateway (npm i -g omniroute && omniroute). Combines other free accounts you set up in it.', 'OmniRoute (local)'],
};
for (const p of PROVIDERS) {
  if (EN[p.id]) { p.noteEn = EN[p.id][0]; if (EN[p.id][1]) p.nameEn = EN[p.id][1]; }
}

module.exports = { PROVIDERS, PROVEN, makeCustomProvider, scoreModel, getJson, isUncensored, UNCENSORED, chatUrlOf };
