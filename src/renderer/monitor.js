'use strict';
// Okno Monitor: snímek ze src/monitor.js každé 2 s; klik na volání načte celý obsah z úplného záznamu (src/callLog.js).
// Všechno se vkládá jako text (zprávy modelů a výstupy nástrojů můžou obsahovat cokoli).
/* global I18N */
const t = (k, v) => I18N.t(k, v);
// dynamický klíč (prefix + hodnota); úplnost hlídá test/i18n.js
const tx = (prefix, k, v) => I18N.t(prefix + k, v);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
const td = (text, cls) => el('td', cls, text == null || text === '' ? '–' : text);
const ms = (x) => (x == null ? '–' : x >= 10000 ? Math.round(x / 1000) + ' s' : x >= 1000 ? (x / 1000).toFixed(1) + ' s' : Math.round(x) + ' ms');
const bytes = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : Math.round((n || 0) / 1024) + ' kB');
const time = (at) => (at ? new Date(at).toLocaleTimeString(I18N.lang === 'en' ? 'en-GB' : 'cs-CZ') : '–');
// čas i s datem, když není dnes (pauza OmniRoute může trvat týdny)
const when = (at) => {
  if (!at) return '–';
  const d = new Date(at); const loc = I18N.lang === 'en' ? 'en-GB' : 'cs-CZ';
  const hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString(loc, { day: 'numeric', month: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }) + ' ' + hm;
};
const short = (s, n = 140) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

let last = null;
let openId = null; // otevřený detail volání (při obnově se nepřekresluje)
let langSet = false;

function rows(tbody, list, make, emptyKey, cols) {
  tbody.textContent = '';
  if (!list.length) { const tr = el('tr'); const c = el('td', 'empty', t(emptyKey)); c.colSpan = cols; tr.append(c); tbody.append(tr); return; }
  for (const x of list) tbody.append(make(x));
}

function stateCell(state) {
  const cls = { ok: 'ok', down: 'err', warn: 'warn', starting: 'warn', off: 'muted', unknown: 'muted' }[state] || '';
  return td(tx('mon.st.', state), cls);
}

function compDetail(c) {
  const d = c.detail || {};
  switch (c.id) {
    case 'omniroute': return c.state === 'ok' ? `${d.url} · ${t('mon.cd.providers', { n: d.providers })} · ${t('mon.cd.combos', { n: d.combos })}` : d.error || '';
    case 'opencode': return `${d.url || ''}${d.restarts ? ' · ' + t('mon.cd.restarts', { n: d.restarts }) : ''}`;
    case 'race': return c.state === 'off' ? t('mon.cd.raceOff') : `${d.url || ''} · ${t('mon.cd.race', { n: d.n, races: d.races, fallbacks: d.fallbacks, stalls: d.stalls })}${d.firstMs != null ? ' · ' + t('mon.cd.first', { t: ms(d.firstMs) }) : ''}`;
    case 'fulllog': return d.file || t('mon.cd.fullLogOff');
    case 'calllog': return c.state === 'ok' ? `${d.dir} · ${t('mon.cd.today', { size: bytes(d.bytes) })}` : t('mon.cd.callLogOff');
    case 'keys': return d.checked ? t('mon.cd.keys', { total: d.total, bad: d.bad.length ? d.bad.join(', ') : '0' }) : t('mon.cd.keysNotYet');
    case 'disk': return t('mon.cd.disk', { size: bytes(d.free) });
    default: return JSON.stringify(d);
  }
}

function render(s) {
  last = s;
  if (!langSet && s.lang) { I18N.setLang(s.lang); I18N.apply(); langSet = true; document.title = t('mon.title'); }
  const errs = s.alerts.filter((a) => a.level === 'error').length;
  const warns = s.alerts.filter((a) => a.level === 'warn').length;
  $('sum').textContent = errs || warns ? t('mon.problems', { e: errs, w: warns }) : t('mon.allOk');
  $('sum').className = 'mo-sum ' + (errs ? 'bad' : warns ? '' : 'ok');
  $('when').textContent = t('mon.updated', { time: time(s.at), v: s.version || '' });
  $('fulllog').checked = !!s.components.find((c) => c.id === 'fulllog' && c.state === 'ok');

  const ul = $('alerts');
  ul.textContent = '';
  if (!s.alerts.length) ul.append(el('li', 'muted', t('mon.noAlerts')));
  for (const a of s.alerts) {
    const li = el('li');
    li.append(el('b', a.level === 'error' ? 'err' : a.level === 'warn' ? 'warn' : 'muted', tx('mon.lvl.', a.level)));
    li.append(document.createTextNode(tx('mon.a.', a.code, a.params)));
    ul.append(li);
  }

  rows($('components').tBodies[0], s.components, (c) => {
    const tr = el('tr');
    tr.append(td(tx('mon.c.', c.id)), stateCell(c.state), td(compDetail(c), 'mono'));
    return tr;
  }, 'mon.noAlerts', 3);

  rows($('active').tBodies[0], s.active, (a) => {
    const tr = el('tr');
    const r = el('td');
    for (const x of a.runners) r.append(el('span', 'tag' + (/vypadl/.test(x.state) ? ' err' : x.state === 'vyhrál' ? '' : ''), `${x.model}: ${x.state}`));
    tr.append(td(a.combo, 'mono'), td(a.kind), td(ms(a.ms), 'num'), r);
    return tr;
  }, 'mon.noActive', 4);

  rows($('models').tBodies[0], s.models, (m) => {
    const tr = el('tr');
    const st = el('td');
    // „funguje“ jen s aspoň jedním úspěšným pokusem (jinak je model v tabulce jen kvůli závodu / pauze)
    if (!m.states.length) st.append(el('span', m.ok ? 'ok' : 'muted', m.ok ? t('mon.ms.ok') : '–'));
    for (const x of m.states) {
      const tag = el('span', 'tag' + (x === 'dead' ? ' err' : ' warn'), tx('mon.ms.', x, { until: when(m.pausedUntil), reason: m.pausedReason || '?', retry: when(m.reprobeAt || m.pausedUntil) }));
      if (x === 'paused') tag.title = t('mon.ms.pausedTip', { reason: m.pausedReason || '?', retry: when(m.reprobeAt || m.pausedUntil) });
      st.append(tag);
    }
    const okCls = m.okPct == null ? '' : m.okPct >= 80 ? 'num ok' : m.okPct >= 50 ? 'num warn' : 'num err';
    tr.append(td(m.model, 'mono'), st, td(m.calls, 'num'), td(m.okPct == null ? '–' : m.okPct + ' %', okCls || 'num'), td(m.fail, 'num' + (m.fail ? ' err' : '')),
      td(m.aborted, 'num muted'), td(ms(m.medianMs), 'num'), td(ms(m.ttftMs), 'num'), td(m.tokPerS, 'num'), td(m.winsTotal || m.wins || '–', 'num'),
      td(m.lastErr ? `${time(m.lastErr.at)} ${m.lastErr.status} ${short(m.lastErr.text, 120)}` : '', 'wrap muted'));
    return tr;
  }, 'mon.noModels', 11);

  const calls = $('calls').tBodies[0];
  if (!openId || !s.calls.some((c) => c.id === openId)) {
    openId = null;
    rows(calls, s.calls, callRow, s.components.find((c) => c.id === 'calllog')?.state === 'ok' ? 'mon.noCalls' : 'mon.callsOff', 10);
  }

  rows($('sessions').tBodies[0], s.sessions, (x) => {
    const tr = el('tr');
    const e = x.errors.slice(-1)[0];
    const stTxt = x.status === 'retry' ? `${t('mon.ss.retry')} (${x.attempt}): ${short(x.retryMsg, 80)}` : tx('mon.ss.', (x.status === 'busy' ? 'busy' : 'idle'));
    tr.append(td(x.id, 'mono'), td(x.dir, 'mono wrap'), td(stTxt, x.status === 'retry' ? 'warn' : ''), td(x.steps, 'num'), td(x.model, 'mono'),
      td(`${x.tokensIn} / ${x.tokensOut}`, 'num'), td(e ? `${time(e.at)} ${e.name} ${short(e.text, 100)}` : '', e ? 'err wrap' : ''));
    return tr;
  }, 'mon.noSessions', 7);

  rows($('guard').tBodies[0], s.guard, (g) => {
    const tr = el('tr');
    tr.append(td(time(g.at)), td(g.kind + (g.why ? ' (' + g.why + ')' : ''), /block|abort/.test(g.kind) ? 'warn' : ''), td(short(g.msg, 300), 'wrap'));
    return tr;
  }, 'mon.noGuard', 3);
}

function callRow(c) {
  const tr = el('tr', 'call');
  tr.dataset.id = c.id;
  const err = c.error || (c.race?.failed?.length ? t('mon.raceFailed', { n: c.race.failed.length }) : '');
  tr.append(td(time(c.t)), td(c.kind + (c.race ? ` · ${t('mon.raceOf', { n: c.race.n })}${c.race.fallback ? ' · ' + t('mon.fallback') : ''}` : '')), td(c.model, 'mono'),
    td(ms(c.ttftMs), 'num'), td(ms(c.totalMs), 'num' + (c.totalMs > 120000 ? ' warn' : '')), td(c.outTokens, 'num'), td(c.tokPerS, 'num'),
    td(c.finish), td(c.tools.join(', '), 'mono'), td(short(err, 120), c.error ? 'err wrap' : 'muted wrap'));
  tr.addEventListener('click', () => toggleDetail(tr, c.id));
  return tr;
}

async function toggleDetail(tr, id) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail-row')) { next.remove(); tr.classList.remove('open'); openId = null; return; }
  document.querySelectorAll('.detail-row').forEach((x) => x.remove());
  document.querySelectorAll('tr.call.open').forEach((x) => x.classList.remove('open'));
  tr.classList.add('open'); openId = id;
  const row = el('tr', 'detail-row');
  const cell = el('td'); cell.colSpan = 10;
  const box = el('div', 'detail', t('mon.d.loading'));
  cell.append(box); row.append(cell); tr.after(row);
  const rec = await window.monitor.call(id);
  box.textContent = '';
  if (!rec) { box.textContent = t('mon.d.notFound'); return; }
  renderDetail(box, rec);
}

const content = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p?.type === 'text' ? p.text : JSON.stringify(p))).join('\n') : c == null ? '' : JSON.stringify(c, null, 1));
function pre(text) { return el('pre', 'txt', text); }

function renderDetail(box, r) {
  const resp = r.response || {};
  box.append(el('h3', null, t('mon.d.summary')));
  box.append(el('div', 'mono', `${r.combo} → ${r.race?.winner || r.upstream?.model || '?'} · ${t('mon.col.ttft')} ${ms(r.ttftMs)} · ${t('mon.col.total')} ${ms(r.totalMs)}${resp.usage ? ` · in ${resp.usage.prompt_tokens ?? '?'} / out ${resp.usage.completion_tokens ?? '?'}` : ''}${r.error ? ' · ' + r.error : ''}`));
  if (r.runners?.length) {
    box.append(el('h3', null, t('mon.d.race')));
    const tb = el('table');
    const h = el('tr'); for (const k of ['mon.col.model', 'mon.d.start', 'mon.col.ttft', 'mon.d.end', 'mon.col.state']) h.append(el('th', null, t(k)));
    tb.append(h);
    for (const x of r.runners) {
      const tr = el('tr');
      const st = x.won ? t('mon.d.won') : x.why ? short(x.why, 200) : x.aborted ? t('mon.d.cancelled') : '';
      tr.append(td(x.model, 'mono'), td(ms(x.startMs), 'num'), td(ms(x.ttftMs), 'num'), td(ms(x.endMs), 'num'), td(st + (x.partial?.text || x.partial?.reasoning ? ' · ' + t('mon.d.partial', { text: short(x.partial.text || x.partial.reasoning, 160) }) : ''), x.why ? 'err wrap' : 'wrap'));
      tb.append(tr);
    }
    box.append(tb);
  }
  box.append(el('h3', null, t('mon.d.response')));
  if (resp.reasoning) { const d = el('details'); d.append(el('summary', null, t('mon.d.reasoning', { n: resp.reasoning.length }))); d.append(pre(resp.reasoning)); box.append(d); }
  if (resp.text) box.append(pre(resp.text));
  for (const tc of resp.toolCalls || []) { let a = tc.arguments; try { a = JSON.stringify(JSON.parse(a), null, 1); } catch {} box.append(el('div', 'mono', `${t('mon.d.toolCall')}: ${tc.name}`)); box.append(pre(a)); }
  if (resp.error) box.append(pre(JSON.stringify(resp.error, null, 1)));
  if (!resp.text && !resp.reasoning && !(resp.toolCalls || []).length && !resp.error) box.append(el('div', 'muted', t('mon.d.noResponse')));

  box.append(el('h3', null, t('mon.d.request', { n: (r.messages || []).length, tools: r.toolCount || 0 })));
  box.append(el('div', 'mono muted', JSON.stringify(r.params || {})));
  for (const [i, m] of (r.messages || []).entries()) {
    const d = el('details', 'msg');
    const text = content(m.content);
    const extra = m.tool_calls ? '\n\n' + JSON.stringify(m.tool_calls, null, 1) : '';
    const sum = el('summary');
    sum.append(el('span', 'role', `${i + 1}. ${m.role}${m.name ? ' ' + m.name : ''}${m.tool_call_id ? ' (' + m.tool_call_id + ')' : ''}`));
    sum.append(document.createTextNode(' ' + short(text.replace(/\s+/g, ' '), 160)));
    d.append(sum);
    d.addEventListener('toggle', () => { if (d.open && d.childElementCount === 1) d.append(pre(text + extra + (m.reasoning_content ? '\n\n[reasoning]\n' + m.reasoning_content : ''))); });
    if (i === (r.messages.length - 1)) d.open = true;
    box.append(d);
  }
  if (r.toolDefs?.length) {
    const d = el('details');
    d.append(el('summary', null, t('mon.d.tools', { n: r.toolDefs.length, names: r.toolDefs.map((x) => x.function?.name).join(', ') })));
    d.append(pre(JSON.stringify(r.toolDefs, null, 1)));
    box.append(d);
  }
}

async function refresh() {
  try { const s = await window.monitor.snapshot(); if (s) render(s); } catch {}
}

$('b-logs').addEventListener('click', () => window.monitor.openLogs());
$('b-calls').addEventListener('click', () => window.monitor.openCalls());
$('b-report').addEventListener('click', async (e) => { e.target.disabled = true; try { await window.monitor.report(); } finally { e.target.disabled = false; } });
$('b-copy').addEventListener('click', async (e) => { if (!last) return; await window.monitor.copy(JSON.stringify(last, null, 1)); const b = e.target; const o = b.textContent; b.textContent = t('mon.copied'); setTimeout(() => { b.textContent = o; }, 1500); });
$('fulllog').addEventListener('change', async (e) => { await window.monitor.fullLog(e.target.checked); refresh(); });
I18N.apply();
refresh();
setInterval(refresh, 2000);
