'use strict';
// Streamovaný klient pro OpenAI-kompatibilní /chat/completions.

class ProviderError extends Error {
  constructor(message, { status = 0, kind = 'other', retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // 'rate' | 'quota' | 'auth' | 'server' | 'network' | 'timeout' | 'no_tools' | 'context' | 'bad_request' | 'other'
    this.retryAfter = retryAfter;
  }
}

function classify(status, msg) {
  const m = String(msg || '').toLowerCase();
  if (/(does not|doesn't|not) support (tools|tool|function)|tool[s_ ]*(calling|use)? (is )?not supported|no endpoints found that support tool|tool_choice/i.test(m)) return 'no_tools';
  if (/context length|context_length|maximum context|too many tokens|reduce the length|prompt is too long|input is too long|max_tokens/i.test(m) && status === 400) return 'context';
  if (status === 413 || /request too large|on tokens per minute|request entity too large/i.test(m)) return 'too_large';
  if (/freeusagelimit|free usage limit|quota|per[- ]day|per[- ]month|daily|exceeded your|insufficient|credits|billing|payment/i.test(m) || status === 402) return 'quota';
  if (status === 429 || /rate limit|rate-limit|too many requests|overloaded|capacity|busy/i.test(m)) return 'rate';
  if (status === 401 || status === 403 || /api key|unauthorized|authentication|invalid token|forbidden/i.test(m)) return 'auth';
  if (status === 404 || /model .*not found|no such model|does not exist|unknown model|not a valid model/i.test(m)) return 'not_found';
  if (status >= 500) return 'server';
  if (status === 400 || status === 422) return 'bad_request';
  return 'other';
}

function errorText(body) {
  try {
    const j = JSON.parse(body);
    const e = j.error ?? j;
    let msg = (typeof e === 'string' ? e : e.message || e.detail || j.message || j.detail) || body;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    const extra = e?.metadata?.raw; // OpenRouter balí chybu upstreamu
    return extra && typeof extra === 'string' ? `${msg} — ${extra.slice(0, 300)}` : msg;
  } catch {
    return body.slice(0, 500) || 'prázdná odpověď';
  }
}

// Hlavičky s limity (Groq, OpenRouter, Cerebras, Mistral, GitHub Models, Together…). Různé názvy → jeden tvar.
function rateHeaders(h) {
  const get = (...names) => { for (const n of names) { const v = h.get(n); if (v != null && v !== '') return v; } return null; };
  const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const r = {
    reqLimit: num(get('x-ratelimit-limit-requests', 'x-ratelimit-limit-requests-day', 'x-ratelimit-limit', 'ratelimit-limit')),
    reqRemaining: num(get('x-ratelimit-remaining-requests', 'x-ratelimit-remaining-requests-day', 'x-ratelimit-remaining', 'ratelimit-remaining')),
    reqReset: get('x-ratelimit-reset-requests', 'x-ratelimit-reset-requests-day', 'x-ratelimit-reset', 'ratelimit-reset'),
    tokLimit: num(get('x-ratelimit-limit-tokens', 'x-ratelimit-limit-tokens-minute', 'x-ratelimit-limit-tokens-day')),
    tokRemaining: num(get('x-ratelimit-remaining-tokens', 'x-ratelimit-remaining-tokens-minute', 'x-ratelimit-remaining-tokens-day')),
    tokReset: get('x-ratelimit-reset-tokens', 'x-ratelimit-reset-tokens-minute', 'x-ratelimit-reset-tokens-day'),
  };
  return Object.values(r).some((v) => v != null) ? r : null;
}

/**
 * @returns {Promise<{content:string, reasoning:string, toolCalls:Array, finishReason:string, usage:object|null, rate:object|null}>}
 */
async function streamChat({ url, headers, body, signal, onDelta, onReasoning, timeoutMs = 120000, firstByteMs = timeoutMs }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort); }
  // Časovače: do prvních dat (řádek data:) nejvýš firstByteMs – udržovací komentáře (": PROCESSING")
  // ho neprodlužují; potom ticho nejvýš timeoutMs. Živě 8. 11.: NVIDIA DeepSeek V4.1 Flash nechal
  // krok agenta čekat 150 s, než se přešlo na Nemotron (ten pak odpověděl za ~30 s).
  let idle;
  let started = false;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(started ? 'idle' : 'first'), started ? timeoutMs : firstByteMs); };
  touch();
  const timedOut = () => ctrl.signal.reason === 'idle' || ctrl.signal.reason === 'first';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', ...headers },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(idle);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw new ProviderError('Zastaveno', { kind: 'aborted' });
    if (timedOut()) throw new ProviderError(`Server neodpověděl včas (${Math.round(firstByteMs / 1000)} s)`, { kind: 'timeout' });
    throw new ProviderError(`Síťová chyba: ${e.cause?.code || e.message}`, { kind: 'network' });
  }

  const cleanup = () => { clearTimeout(idle); if (signal) signal.removeEventListener('abort', onAbort); };

  const rate = rateHeaders(res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    cleanup();
    const msg = errorText(text);
    const ra = Number(res.headers.get('retry-after')) || 0;
    const err = new ProviderError(`HTTP ${res.status}: ${msg}`, { status: res.status, kind: classify(res.status, msg), retryAfter: ra });
    err.rate = rate;
    throw err;
  }

  const out = { content: '', reasoning: '', toolCalls: [], finishReason: '', usage: null, rate };
  const tc = []; // akumulace tool_calls podle indexu

  const handleChunk = (j) => {
    if (j.error) {
      const msg = errorText(JSON.stringify(j));
      throw new ProviderError(msg, { status: j.error.code || 0, kind: classify(Number(j.error.code) || 0, msg) });
    }
    if (j.usage) out.usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) return;
    const d = ch.delta || ch.message || {};
    const r = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (typeof r === 'string' && r) { out.reasoning += r; onReasoning?.(r); }
    if (typeof d.content === 'string' && d.content) { out.content += d.content; onDelta?.(d.content); }
    if (Array.isArray(d.tool_calls)) addToolCallDeltas(tc, d.tool_calls, !!ch.message);
    if (ch.finish_reason) out.finishReason = ch.finish_reason;
  };

  const ctype = res.headers.get('content-type') || '';
  try {
    if (!ctype.includes('event-stream')) {
      // Server ignoroval stream:true a vrátil celý JSON (hlavičky přišly = začal odpovídat).
      started = true;
      touch();
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new ProviderError(`Neplatná odpověď: ${text.slice(0, 200)}`, { kind: 'server' }); }
      handleChunk(j);
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (!started && /(^|\n)data:/.test(buf)) started = true;
        if (started) touch();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j;
          try { j = JSON.parse(data); } catch { continue; }
          handleChunk(j);
        }
      }
    }
  } catch (e) {
    cleanup();
    if (e instanceof ProviderError) throw e;
    if (signal?.aborted) throw new ProviderError('Zastaveno', { kind: 'aborted' });
    if (ctrl.signal.reason === 'first') throw new ProviderError(`Server nezačal odpovídat do ${Math.round(firstByteMs / 1000)} s`, { kind: 'timeout' });
    throw new ProviderError(ctrl.signal.reason === 'idle' ? 'Server přestal odpovídat' : `Přerušené spojení: ${e.message}`, { kind: 'network' });
  }
  cleanup();

  out.toolCalls = finishToolCalls(tc);
  return out;
}

/**
 * Přidá kusy tool_calls (ze streamu nebo celé zprávy) do akumulátoru `tc`. Servery se liší: jméno
 * po kouscích nebo v každém chunku, chybějící index, poslední kus argumentů s jiným indexem/id…
 */
function addToolCallDeltas(tc, deltas, whole = false) {
  deltas.forEach((t, k) => {
    let i;
    if (typeof t.index === 'number') i = t.index;
    else if (whole) i = k; // neštreamovaná odpověď
    else if (!tc.length || (t.id && tc[tc.length - 1].id && t.id !== tc[tc.length - 1].id)) i = tc.length;
    else i = tc.length - 1;
    // Nový slot bez jména je ve skutečnosti pokračování předchozího volání
    // (některé servery u posledního kusu argumentů pošlou jiný index/id).
    if (!tc[i] && !t.function?.name && tc.length) i = tc.length - 1;
    if (!tc[i]) tc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (t.id && !tc[i].id) tc[i].id = t.id;
    // Gemini: thought_signature v extra_content.google – musí se poslat zpět, jinak HTTP 400
    if (t.extra_content) tc[i].extra_content = t.extra_content;
    const nm = t.function?.name;
    if (typeof nm === 'string' && nm) {
      const cur = tc[i].function.name;
      // někdo posílá jméno po kouscích, někdo celé v každém chunku
      tc[i].function.name = !cur || nm.startsWith(cur) ? nm : cur === nm ? cur : cur + nm;
    }
    if (t.function?.arguments != null) {
      tc[i].function.arguments += typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments);
    }
  });
}

/** Hotová volání: slot bez jména přilepit k předchozímu, doplnit id. */
function finishToolCalls(tc) {
  const merged = [];
  for (const t of tc.filter(Boolean)) {
    if (!t.function.name && merged.length) merged[merged.length - 1].function.arguments += t.function.arguments;
    else merged.push(t);
  }
  return merged.map((t, i) => ({ ...t, id: t.id || `call_${Date.now().toString(36)}_${i}` }));
}

module.exports = { streamChat, ProviderError, classify, rateHeaders, addToolCallDeltas, finishToolCalls };
