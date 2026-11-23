'use strict';
// AI Horde (aihorde.net) – komunitní síť dobrovolníků s vlastními GPU. Bez klíče (anonymně) nebo
// s free klíčem z registrace (vyšší priorita ve frontě). Nemá /chat/completions: prompt se poskládá
// podle šablony modelu, odešle se jako úloha do fronty a výsledek se vyzvedává dotazováním.
const { ProviderError } = require('./llm');

const API = 'https://aihorde.net/api/v2';
const ANON = '0000000000';
const CLIENT = 'Zdarma:0.9.2:unknown';

const headers = (key) => ({ 'Content-Type': 'application/json', apikey: key || ANON, 'Client-Agent': CLIENT });

// Šablona podle jména modelu. Horde posílá prompt workerům tak, jak je, takže ho musíme naformátovat sami.
function templateFor(model) {
  const m = String(model).toLowerCase();
  if (/llama-?3|(^|[/_-])l3[.-]|stheno|lunaris|euryale/.test(m)) return 'llama3';
  if (/gemma/.test(m)) return 'gemma';
  if (/phi-3|phi3/.test(m)) return 'phi3';
  return 'chatml';
}

const TEMPLATES = {
  chatml: {
    turn: (role, text) => `<|im_start|>${role}\n${text}<|im_end|>\n`,
    open: '<|im_start|>assistant\n',
    stop: ['<|im_end|>', '<|im_start|>', '<|endoftext|>'],
  },
  llama3: {
    begin: '<|begin_of_text|>',
    turn: (role, text) => `<|start_header_id|>${role}<|end_header_id|>\n\n${text}<|eot_id|>`,
    open: '<|start_header_id|>assistant<|end_header_id|>\n\n',
    stop: ['<|eot_id|>', '<|start_header_id|>', '<|end_of_text|>'],
  },
  gemma: { // bez role system → přilepí se k první zprávě uživatele
    turn: (role, text) => `<start_of_turn>${role === 'assistant' ? 'model' : 'user'}\n${text}<end_of_turn>\n`,
    open: '<start_of_turn>model\n',
    stop: ['<end_of_turn>', '<start_of_turn>', '<eos>'],
    noSystem: true,
  },
  phi3: {
    turn: (role, text) => `<|${role}|>\n${text}<|end|>\n`,
    open: '<|assistant|>\n',
    stop: ['<|end|>', '<|user|>', '<|endoftext|>'],
  },
};

const toks = (s) => Math.ceil(s.length / 3.3);

/** Zprávy (už v textovém tvaru, bez tool_calls) → prompt, který se vejde do kontextu workeru. */
function buildPrompt(model, messages, ctx, maxLen) {
  const t = TEMPLATES[templateFor(model)];
  let msgs = messages.map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: String(m.content ?? '') }));
  let sys = msgs[0]?.role === 'system' ? msgs.shift().content : '';
  const budget = Math.max(256, ctx - maxLen - 64);
  // systém max. polovina kontextu, zbytek historie od konce
  if (toks(sys) > budget / 2) sys = sys.slice(0, Math.floor((budget / 2) * 3.3)) + '\n…';
  let used = toks(sys) + 16;
  const kept = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    let c = msgs[i].content;
    const room = budget - used;
    if (toks(c) > room) {
      if (!kept.length) c = '…' + c.slice(-Math.max(200, Math.floor(room * 3.3))); // poslední zprávu aspoň zkrátit
      else break;
    }
    used += toks(c) + 8;
    kept.unshift({ ...msgs[i], content: c });
  }
  if (t.noSystem && sys) {
    const firstUser = kept.find((m) => m.role === 'user');
    if (firstUser) firstUser.content = `${sys}\n\n${firstUser.content}`;
    else kept.unshift({ role: 'user', content: sys });
    sys = '';
  }
  let out = t.begin || '';
  if (sys) out += t.turn('system', sys);
  for (const m of kept) out += t.turn(m.role, m.content);
  return { prompt: out + t.open, stop: t.stop };
}

// <think>…</think> u reasoning modelů oddělit od odpovědi.
function splitThink(text) {
  let s = String(text || '');
  let reasoning = '';
  s = s.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, r) => { reasoning += r; return ''; });
  if (/<\/think>/.test(s)) { const i = s.indexOf('</think>'); reasoning += s.slice(0, i); s = s.slice(i + 8); }
  return { content: s.trim(), reasoning: reasoning.trim() };
}

async function api(path, { method = 'GET', key, body, signal } = {}) {
  let r;
  try {
    r = await fetch(API + path, { method, headers: headers(key), body: body ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('Zastaveno', { kind: 'aborted' });
    throw new ProviderError(`Síťová chyba: ${e.cause?.code || e.message}`, { kind: 'network' });
  }
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!r.ok) {
    const msg = (j && (j.message || j.rc)) || text.slice(0, 300);
    const kind = r.status === 429 ? 'rate' : r.status === 401 ? 'auth' : r.status === 403 ? 'bad_request' : r.status >= 500 ? 'server' : 'bad_request';
    throw new ProviderError(`AI Horde HTTP ${r.status}: ${msg}`, { status: r.status, kind });
  }
  return j;
}

/** Seznam modelů podle běžících workerů. Kontext/délka = worker s největším kontextem (na něj se úloha vejde). */
async function listModels() {
  const [workers, stats] = await Promise.all([api('/workers?type=text'), api('/status/models?type=text').catch(() => [])]);
  const stat = new Map((stats || []).map((x) => [x.name, x]));
  const by = new Map(); // model -> [{ctx, len}]
  for (const w of workers || []) {
    if (!w.online || w.maintenance_mode) continue;
    for (const name of w.models || []) {
      if (!by.has(name)) by.set(name, []);
      by.get(name).push({ ctx: w.max_context_length || 2048, len: w.max_length || 512 });
    }
  }
  // Kontext, který zvládne aspoň polovina workerů (do 16k) – ať úlohu může vzít víc z nich.
  for (const [name, ws] of by) {
    const sorted = ws.map((w) => w.ctx).sort((x, y) => y - x);
    const ctx = Math.min(16384, sorted[Math.floor((sorted.length - 1) / 2)]);
    const len = Math.min(...ws.filter((w) => w.ctx >= ctx).map((w) => w.len));
    by.set(name, { count: ws.length, ctx, len });
  }
  return [...by.entries()].map(([id, v]) => ({
    id,
    name: `${id} · ${v.count}× worker · kontext ${v.ctx}`,
    context: v.ctx,
    maxLen: v.len,
    tools: false,
    workers: v.count,
    eta: stat.get(id)?.eta ?? null, // odhad čekání ve frontě (s)
  }));
}

/** Stejný tvar výsledku jako streamChat. */
async function chat({ key, model, messages, signal, onDelta, onReasoning, onStatus, timeoutMs = 240000, queueTimeoutMs = 60000, maxLen, ctx }) {
  const C = Math.min(ctx || 4096, 16384);
  const L = Math.min(maxLen || 512, 1024, Math.floor(C / 2));
  const { prompt, stop } = buildPrompt(model, messages, C, L);
  const params = { max_context_length: C, max_length: L, stop_sequence: stop, temperature: 0.7, rep_pen: 1.08 };
  const job = await api('/generate/text/async', { method: 'POST', key, signal, body: { prompt, params, models: model ? [model] : [] } });
  if (!job?.id) throw new ProviderError(`AI Horde nepřijal úlohu: ${JSON.stringify(job).slice(0, 200)}`, { kind: 'server' });
  const cancel = () => api(`/generate/text/status/${job.id}`, { method: 'DELETE', key }).catch(() => {});
  const t0 = Date.now();
  let lastPos = null;
  let started = false;
  let st = null;
  try {
    for (;;) {
      if (signal?.aborted) throw new ProviderError('Zastaveno', { kind: 'aborted' });
      if (Date.now() - t0 > timeoutMs) throw new ProviderError('AI Horde: fronta je moc dlouhá, vypršel čas', { kind: 'server' });
      await new Promise((r) => setTimeout(r, 2500));
      // u textu je jen /status (vrací rovnou i hotový výsledek)
      const s = await api(`/generate/text/status/${job.id}`, { key, signal }).catch((e) => { if (e.kind === 'aborted') throw e; return null; });
      if (!s) continue;
      if (s.faulted) throw new ProviderError('AI Horde: úloha selhala u workeru', { kind: 'server' });
      if (s.is_possible === false) throw new ProviderError('AI Horde: pro tento model teď neběží žádný vhodný worker', { kind: 'server' });
      if (s.processing > 0 || s.finished > 0) started = true;
      // Anonymní úlohy mají nejnižší prioritu: když se fronta nehýbe, radši zkusit jiný model.
      if (!started && !s.done && Date.now() - t0 > queueTimeoutMs) {
        throw new ProviderError(`AI Horde: fronta se nehýbe (pozice ${s.queue_position}); bez klíče máš nejnižší prioritu`, { kind: 'rate' });
      }
      if (!s.done && s.queue_position !== lastPos && onStatus) { lastPos = s.queue_position; onStatus({ queue: s.queue_position, wait: s.wait_time }); }
      if (s.done) { st = s; break; }
    }
    const g = st?.generations?.[0];
    if (!g) throw new ProviderError('AI Horde vrátil prázdný výsledek', { kind: 'server' });
    let text = String(g.text || '');
    for (const s of stop) { const i = text.indexOf(s); if (i >= 0) text = text.slice(0, i); }
    const { content, reasoning } = splitThink(text);
    if (reasoning) onReasoning?.(reasoning);
    if (content) onDelta?.(content);
    return { content, reasoning, toolCalls: [], finishReason: 'stop', usage: null, worker: g.worker_name, servedModel: g.model };
  } catch (e) {
    cancel();
    throw e;
  }
}

module.exports = { listModels, chat, buildPrompt, templateFor, splitThink, ANON };
