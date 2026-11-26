'use strict';
/* global marked */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => esc(text), // syrové HTML z modelu nikdy nevkládat
  },
});
const md = (s) => marked.parse(String(s || ''));
/* global I18N */
const t = (k, v) => I18N.t(k, v); // překlady (src/i18n.js)
const fm = (n) => I18N.models(n); // 1 free model, 2–4 free modely, 5+ free modelů / … free models

const S = {
  settings: null,
  models: [],
  united: [],
  status: {},
  autoOrder: [],
  cooling: [],
  sessions: [],
  sessionId: null,
  cwd: '',
  running: new Set(),
  live: null, // {wrap, body, text, think, thinkPre, reasoning}
  tools: new Map(), // id -> element
};

// ---------------------------------------------------------------- init

async function init() {
  S.settings = await window.api.getSettings();
  I18N.setLang(S.settings.lang);
  I18N.apply();
  S.cwd = S.settings.lastCwd || '';
  $('#modeSel').value = S.settings.mode || 'ask';
  renderCwd();
  renderModelBtn();
  renderUnf();
  await refreshSessions();
  showWelcome();
  loadModels(false);
  (await window.api.running()).forEach((id) => S.running.add(id));
  window.api.onEvent(onEvent);
  window.api.onSessionsChanged((list) => { S.sessions = list; renderSessions(); });
  // Z menu okna OpenCode („Klíče a poskytovatelé“) se okno otevírá rovnou v nastavení.
  window.api.onNav((view) => {
    if (view === 'chat') { document.body.classList.remove('preset-only'); closeSettings(); }
    else if (view === 'models') { openSettings(); showPage('models'); }
    else if (view === 'about') { openSettings(); showPage('about'); }
    else if (view === 'opencode') { openSettings(); showPage('opencode'); }
    else if (view === 'wizard') { openSettings(); wiz.i = null; showPage('wizard'); }
    else openSettings();
  });
  if (location.hash === '#chat') {
    document.body.classList.remove('preset-only');
    $('#input').focus();
  } else {
    document.body.classList.add('preset-only');
    openSettings();
    const h = location.hash.replace(/^#/, '');
    if (['models', 'about', 'opencode', 'tiers', 'general', 'advanced', 'diag', 'wizard'].includes(h)) showPage(h);
    else if (h === 'settings-general') showPage('general');
  }
}

async function loadModels(force) {
  $('#freeCount').textContent = t('side.loading');
  const r = await window.api.listModels(force);
  S.models = r.models;
  S.united = r.united || [];
  S.status = r.status;
  S.autoOrder = r.autoOrder;
  S.cooling = r.cooling;
  const usable = S.models.filter((m) => m.usable).length;
  const toolsN = S.models.filter((m) => m.usable && m.tools !== false).length;
  const uncN = S.models.filter((m) => m.usable && m.uncensored).length;
  $('#freeCount').textContent = t('side.count', { models: fm(usable), total: S.models.length });
  $('#freeCount').title = t('side.countTitle', { tools: toolsN, unc: uncN });
  renderModelBtn();
  if (!$('#modelPop').hidden) renderModelList();
  if (!$('#settingsView').hidden) { renderProviders(); renderUnitedModels(); }
  if ($('.welcome')) showWelcome();
}

// ---------------------------------------------------------------- hlavička

function renderCwd() {
  $('#cwdBtn').textContent = S.cwd ? S.cwd : t('chat.pickCwd');
  $('#cwdBtn').title = S.cwd ? t('chat.cwdTitle', { cwd: S.cwd }) : t('chat.cwdPick');
}

$('#cwdBtn').onclick = async () => {
  const cur = currentSessionHasMessages();
  if (cur) {
    alertNote(t('chat.cwdLocked'));
  }
  const p = await window.api.pickWorkspace(S.cwd);
  if (!p) return;
  if (cur) newChat();
  S.cwd = p;
  renderCwd();
  const recent = [p, ...(S.settings.recentCwds || []).filter((x) => x !== p)].slice(0, 10);
  S.settings = await window.api.setSettings({ lastCwd: p, recentCwds: recent });
  if ($('.welcome')) showWelcome();
};

function currentSessionHasMessages() { return !!S.sessionId; }

function modelLabel(key) {
  if (key === 'auto') return S.settings?.unfiltered ? t('chat.autoModelUnf') : t('chat.autoModel');
  const u = (S.united || []).find((x) => x.slug === key || `united:${x.slug}` === key);
  if (u) return `${u.title} (${u.usable.length}×)`;
  const m = S.models.find((x) => x.key === key);
  return m ? `${m.providerName}: ${m.id}` : key;
}

function renderModelBtn() {
  const k = S.settings?.model || 'auto';
  $('#modelBtn').textContent = modelLabel(k) + ' ▾';
}

function renderUnf() {
  // Přepínač Unfiltered je v chatu jen když si ho uživatel zapne v Nastavení → Pokročilé.
  // Skrytý přepínač zároveň znamená vypnutý režim (jinak by Auto potichu jelo jen na necenzurovaných).
  const show = S.settings?.showUnfiltered === true;
  $('#unfBtn').hidden = !show;
  const on = show && !!S.settings?.unfiltered;
  $('#unfBtn').classList.toggle('on', on);
  $('#unfBtn').setAttribute('aria-pressed', String(on));
}

$('#unfBtn').onclick = async () => {
  S.settings = await window.api.setSettings({ unfiltered: !S.settings.unfiltered });
  renderUnf();
  renderModelBtn();
  const r = await window.api.listModels(false);
  S.models = r.models;
  S.autoOrder = r.autoOrder;
  if (!$('#modelPop').hidden) renderModelList();
  if ($('.welcome')) showWelcome();
};

$('#modeSel').onchange = async (e) => { S.settings = await window.api.setSettings({ mode: e.target.value }); };

// ---------------------------------------------------------------- výběr modelu

let kbIndex = -1;
$('#modelBtn').onclick = (e) => {
  e.stopPropagation();
  const pop = $('#modelPop');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) { kbIndex = -1; $('#modelSearch').value = ''; renderModelList(); $('#modelSearch').focus(); }
};
document.addEventListener('click', (e) => { if (!e.target.closest('.picker-wrap')) $('#modelPop').hidden = true; });
$('#modelSearch').oninput = () => { kbIndex = -1; renderModelList(); };
$('#modelSearch').onkeydown = (e) => {
  const rows = [...document.querySelectorAll('#modelList .mrow')];
  if (e.key === 'ArrowDown') { kbIndex = Math.min(rows.length - 1, kbIndex + 1); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { kbIndex = Math.max(0, kbIndex - 1); e.preventDefault(); }
  else if (e.key === 'Enter') { (rows[kbIndex] || rows[0])?.click(); return; }
  else if (e.key === 'Escape') { $('#modelPop').hidden = true; $('#input').focus(); return; }
  else return;
  rows.forEach((r, i) => r.classList.toggle('kb', i === kbIndex));
  rows[kbIndex]?.scrollIntoView({ block: 'nearest' });
};
$('#refreshModels').onclick = () => loadModels(true);

const fmtCtx = (n) => (!n ? '' : n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`);

function renderModelList() {
  const q = $('#modelSearch').value.trim().toLowerCase();
  const list = $('#modelList');
  list.innerHTML = '';
  const cur = S.settings.model || 'auto';
  const favs = new Set(S.settings.favorites || []);
  const cool = new Map(S.cooling.map((c) => [c.key, c]));
  const unf = !!S.settings.unfiltered;
  if (unf) {
    const n = S.models.filter((m) => m.uncensored && m.usable).length;
    list.append(el('div', 'unf-note', n
      ? t('chat.unfListNote', { n })
      : t('chat.unfListNone')));
  }

  if (!q || 'auto'.includes(q)) {
    const r = el('div', 'mrow' + (cur === 'auto' ? ' cur' : ''));
    r.append(el('span', 'star', ' '), el('span', 'id', 'Auto'), el('span', 'tag', t('chat.autoRow', { models: fm(S.autoOrder.length), unf: unf ? t('chat.autoRowUnf') : '' })));
    r.onclick = () => chooseModel('auto');
    list.append(r);
  }

  // Sjednocené modely napříč poskytovateli (drží jednoho poskytovatele, dokud má kredit)
  const unitedHits = (S.united || []).filter((u) => {
    if (!u.usable?.length) return false;
    if (unf && !u.uncensored) return false;
    if (q && !`${u.slug} ${u.title} ${u.providers.join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (unitedHits.length) {
    const ug = el('div', 'mg');
    ug.innerHTML = `<b>${esc(t('chat.unitedGroup'))}</b><span>${unitedHits.length}</span>`;
    list.append(ug);
    for (const u of unitedHits) {
      const r = el('div', 'mrow' + (cur === u.slug || cur === `united:${u.slug}` ? ' cur' : ''));
      const id = el('span', 'id', `${u.title}`);
      id.title = `${u.slug} · ${u.providers.join(', ')}`;
      const provTag = el('span', 'tag', `${u.usable.length}× · ${u.providers.slice(0, 3).join(', ')}${u.providers.length > 3 ? '…' : ''}`);
      r.append(el('span', 'star', ' '), id, provTag);
      if (u.rawContext || u.context) r.append(el('span', 'tag', fmtCtx(u.rawContext || u.context)));
      r.onclick = () => chooseModel(u.slug);
      list.append(r);
    }
  }

  const groups = new Map();
  for (const m of S.models) {
    if (unf && !m.uncensored) continue;
    if (q && !`${m.key} ${m.name} ${m.providerName}`.toLowerCase().includes(q)) continue;
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  const provOrder = (S.settings.providerDefs || []).map((p) => p.id);
  const keys = [...groups.keys()].sort((a, b) => {
    const ua = groups.get(a)[0].usable ? 0 : 1, ub = groups.get(b)[0].usable ? 0 : 1;
    return ua - ub || provOrder.indexOf(a) - provOrder.indexOf(b);
  });
  for (const pid of keys) {
    const ms = groups.get(pid).sort((a, b) => (favs.has(b.key) - favs.has(a.key)) || ((b.tools === true) - (a.tools === true)) || a.id.localeCompare(b.id));
    const g = el('div', 'mg');
    g.innerHTML = `<b>${esc(ms[0].providerName)}</b><span>${ms.length}</span>${ms[0].usable ? '' : `<span class="tag warn">${esc(t('chat.missingKeyGroup'))}</span>`}`;
    list.append(g);
    for (const m of ms) {
      const r = el('div', 'mrow' + (m.key === cur ? ' cur' : '') + (m.usable ? '' : ' off'));
      const star = el('button', 'star' + (favs.has(m.key) ? ' on' : ''), favs.has(m.key) ? '★' : '☆');
      star.title = t('chat.favTitle');
      star.onclick = async (e) => {
        e.stopPropagation();
        const f = new Set(S.settings.favorites || []);
        f.has(m.key) ? f.delete(m.key) : f.add(m.key);
        S.settings = await window.api.setSettings({ favorites: [...f] });
        const r2 = await window.api.listModels(false);
        S.autoOrder = r2.autoOrder;
        renderModelList();
      };
      const id = el('span', 'id', m.id);
      id.title = m.name && m.name !== m.id ? m.name : m.key;
      const marked = (S.settings.uncensoredMarks || []).includes(m.key);
      const unc = el('button', 'unc' + (m.uncensored ? ' on' : '') + (m.uncAuto ? ' auto' : ''), t('chat.uncShort'));
      unc.title = m.uncAuto ? t('chat.uncAuto') : marked ? t('chat.uncMarked') : t('chat.uncMark');
      if (S.settings.showUnfiltered !== true) unc.hidden = true; // značkování jen s režimem Unfiltered (Pokročilé)
      unc.onclick = async (e) => {
        e.stopPropagation();
        if (m.uncAuto) return;
        const set = new Set(S.settings.uncensoredMarks || []);
        set.has(m.key) ? set.delete(m.key) : set.add(m.key);
        S.settings = await window.api.setSettings({ uncensoredMarks: [...set] });
        const r2 = await window.api.listModels(false);
        S.models = r2.models;
        S.autoOrder = r2.autoOrder;
        renderModelList();
      };
      r.append(star, id, unc);
      const c = cool.get(m.key) || cool.get('provider:' + m.provider);
      if (c) r.append(el('span', 'tag warn', t('chat.cooling', { min: Math.max(1, Math.round((c.until - Date.now()) / 60000)), reason: c.reason })));
      if (m.tools === false) r.append(el('span', 'tag', t('chat.noTools')));
      if (m.context) r.append(el('span', 'tag', fmtCtx(m.context)));
      r.onclick = () => {
        if (!m.usable) { $('#modelPop').hidden = true; openSettings(m.provider); return; }
        chooseModel(m.key);
      };
      list.append(r);
    }
  }
  const failed = Object.entries(S.status).filter(([, s]) => s.state === 'error');
  if (failed.length && !q) {
    const g = el('div', 'mg');
    g.textContent = t('chat.unavailable') + failed.map(([id, s]) => `${id} (${s.error.slice(0, 80)})`).join('; ');
    list.append(g);
  }
  if (!list.querySelector('.mrow, .mg')) list.append(el('div', 'mg', t('common.nothing')));
}

async function chooseModel(key) {
  S.settings = await window.api.setSettings({ model: key });
  $('#modelPop').hidden = true;
  renderModelBtn();
  $('#input').focus();
}

// ---------------------------------------------------------------- relace

async function refreshSessions() {
  S.sessions = await window.api.listSessions();
  renderSessions();
}

function renderSessions() {
  const box = $('#sessions');
  box.innerHTML = '';
  for (const s of S.sessions) {
    const row = el('div', 'sess' + (s.id === S.sessionId ? ' active' : ''));
    const txt = el('div', 't');
    txt.append(el('div', null, s.title || t('side.untitled')), el('div', 'd', s.cwd || ''));
    txt.style.minWidth = '0';
    if (S.running.has(s.id)) row.append(el('span', 'run'));
    const x = el('button', 'x', '×');
    x.title = t('side.delete');
    x.onclick = async (e) => {
      e.stopPropagation();
      if (S.running.has(s.id)) await window.api.stop(s.id);
      S.sessions = await window.api.deleteSession(s.id);
      if (S.sessionId === s.id) newChat();
      renderSessions();
    };
    row.append(txt, x);
    row.onclick = () => openSession(s.id);
    box.append(row);
  }
}

function newChat() {
  S.sessionId = null;
  S.live = null;
  S.tools.clear();
  renderSessions();
  showWelcome();
  updateRunning();
  closeSettings();
  $('#input').focus();
}
$('#newChat').onclick = newChat;

async function openSession(id) {
  closeSettings();
  const s = await window.api.getSession(id);
  if (!s) { refreshSessions(); return; }
  S.sessionId = id;
  S.cwd = s.cwd;
  S.live = null;
  S.tools.clear();
  renderCwd();
  renderSessions();
  const log = $('#log');
  log.innerHTML = '';
  const results = new Map(s.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
  for (const m of s.messages) {
    if (m.role === 'user') addUser(m.content);
    else if (m.role === 'assistant') {
      const blk = addAssistant(m.model || '');
      if (m.reasoning) setThinking(blk, m.reasoning);
      if (m.content) blk.body.innerHTML = md(m.content);
      else blk.body.remove();
      for (const tc of m.tool_calls || []) {
        let args; try { args = JSON.parse(tc.function.arguments); } catch { args = tc.function.arguments; }
        const t = addTool(blk, tc.id, tc.function.name, args);
        const r = results.get(tc.id);
        if (r) fillTool(t, r.ok !== false && !/^(Chyba|Neznámý|Uživatel akci zamítl|Zrušeno)/.test(r.content), r.content, r.display);
      }
    }
  }
  updateRunning();
  scrollDown(true);
}

// ---------------------------------------------------------------- vykreslování zpráv

function showWelcome() {
  if (S.sessionId) return;
  const usable = S.models.filter((m) => m.usable).length;
  const provs = Object.entries(S.status).filter(([, s]) => s.state === 'ok').map(([id]) => (S.settings.providerDefs.find((p) => p.id === id) || { name: id }).name);
  const noKey = (S.settings.providerDefs || []).filter((p) => p.needsKey && !S.settings.providers[p.id]?.hasKey && !p.envKey).map((p) => p.name);
  $('#log').innerHTML = `<div class="welcome">
    <h1>${esc(t('app.tagline'))}</h1>
    <p>${esc(t('chat.welcome1'))}</p>
    <p>${S.models.length ? t('chat.available', { models: esc(fm(usable)), from: provs.length ? esc(t('chat.availableFrom', { list: provs.join(', ') })) : '' }) : esc(t('chat.loadingModels'))}</p>
    ${noKey.length ? `<p class="muted">${esc(t('chat.noKeyYet', { list: noKey.join(', ') }))}<button class="link" id="wSettings">${esc(t('chat.addInSettings'))}</button>.</p>` : ''}
    ${S.settings.unfiltered && S.settings.showUnfiltered ? `<p>${t('chat.unfOn', { n: S.models.filter((m) => m.usable && m.uncensored).length })}</p>` : ''}
    <p class="muted">${t('chat.autoExplain')}</p>
    ${S.cwd ? '' : `<p><button class="btn primary" id="wPick">${esc(t('chat.pickFolderBtn'))}</button></p>`}
  </div>`;
  $('#wSettings')?.addEventListener('click', () => openSettings());
  $('#wPick')?.addEventListener('click', () => $('#cwdBtn').click());
}

function clearWelcome() { const w = $('.welcome'); if (w) w.remove(); }

function addUser(text) {
  clearWelcome();
  S.lastModel = null;
  const w = el('div', 'msg user');
  w.append(el('div', 'body', text));
  $('#log').append(w);
  return w;
}

function addAssistant(model) {
  clearWelcome();
  const w = el('div', 'msg asst');
  // jméno modelu jen když se změní (Auto může mezi kroky přepnout)
  const who = el('div', 'who', model);
  if (model && model === S.lastModel) who.style.display = 'none';
  S.lastModel = model || S.lastModel;
  w.append(who);
  const body = el('div', 'md');
  w.append(body);
  $('#log').append(w);
  return { wrap: w, body, text: '', reasoning: '' };
}

function setThinking(blk, text) {
  if (!blk.think) {
    blk.think = el('details', 'think');
    blk.think.append(el('summary', null, t('chat.thinking')));
    blk.thinkPre = el('pre');
    blk.think.append(blk.thinkPre);
    blk.wrap.insertBefore(blk.think, blk.body);
  }
  blk.thinkPre.textContent = text;
}

function toolSummary(name, args) {
  if (!args || typeof args !== 'object') return String(args || '');
  switch (name) {
    case 'read_file': return args.path + (args.offset ? t('chat.from', { n: args.offset }) : '');
    case 'write_file': case 'edit_file': case 'list_dir': return args.path || '.';
    case 'glob': return args.pattern + (args.path ? t('chat.in', { p: args.path }) : '');
    case 'grep': return `/${args.pattern}/` + (args.include ? ` ${args.include}` : '') + (args.path ? t('chat.in', { p: args.path }) : '');
    case 'run_command': return args.command;
    case 'fetch_url': return args.url;
    default: return JSON.stringify(args);
  }
}

function addTool(blk, id, name, args) {
  const t = el('div', 'tool');
  const head = el('div', 'head');
  head.append(el('span', 'st', '·'), el('span', 'nm', name), el('span', 'arg', toolSummary(name, args)));
  t.append(head);
  t._args = args;
  t._name = name;
  head.onclick = () => { const o = t.querySelector('.out, .diff'); if (o) o.hidden = !o.hidden; };
  blk.wrap.append(t);
  S.tools.set(id, t);
  return t;
}

function fillTool(tool, ok, output, display) {
  tool.classList.remove('run');
  tool.classList.add(ok ? 'ok' : 'fail');
  tool.querySelector('.st').textContent = ok ? '✓' : '✗';
  tool.querySelectorAll('.out, .diff').forEach((x) => x.remove());
  if (display?.kind === 'diff' && ok) {
    const d = el('div', 'diff');
    for (const l of display.diff || []) {
      const row = el('div', l.t === '+' ? 'a' : l.t === '-' ? 'r' : '');
      row.innerHTML = `<span class="n">${l.n}</span>${l.t} ${esc(l.s)}`;
      d.append(row);
    }
    if (!(display.diff || []).length) d.append(el('div', null, t('chat.noChange')));
    tool.append(d);
  } else {
    const o = el('div', 'out', output);
    // čtení/hledání je dlouhé a málo zajímavé → sbalené
    if (ok && ['read_file', 'list_dir', 'glob', 'grep', 'fetch_url'].includes(tool._name)) o.hidden = true;
    tool.append(o);
  }
}

function addNote(text, cls = '') {
  const w = el('div', 'msg');
  w.append(el('div', 'note ' + cls, text));
  $('#log').append(w);
  scrollDown();
}
function alertNote(text) { if (S.sessionId) addNote(text, 'warn'); }

function addError(text) {
  const w = el('div', 'msg');
  w.append(el('div', 'err', text));
  $('#log').append(w);
  scrollDown();
}

let stick = true;
$('#log').addEventListener('scroll', () => {
  const l = $('#log');
  stick = l.scrollHeight - l.scrollTop - l.clientHeight < 80;
});
function scrollDown(force) { const l = $('#log'); if (force || stick) l.scrollTop = l.scrollHeight; }

// Streamované překreslování max. 1× za snímek.
let rafPending = false;
function scheduleLive() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const L = S.live;
    if (!L) return;
    if (L.reasoning) setThinking(L, L.reasoning);
    L.body.innerHTML = md(L.text.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, ''));
    L.body.classList.add('cursor');
    scrollDown();
  });
}

// ---------------------------------------------------------------- události agenta

function onEvent(ev) {
  if (ev.type === 'idle') { S.running.delete(ev.sessionId); renderSessions(); updateRunning(); }
  if (ev.sessionId !== S.sessionId) return;
  switch (ev.type) {
    case 'assistant_start':
      S.live = addAssistant(ev.model + (ev.textMode ? t('chat.textTools') : ''));
      S.live.body.classList.add('cursor');
      setStatus(t('chat.writing', { model: ev.model }));
      scrollDown();
      break;
    case 'delta': if (S.live) { S.live.text += ev.text; scheduleLive(); } break;
    case 'reasoning': if (S.live) { S.live.reasoning += ev.text; scheduleLive(); setStatus(t('chat.thinkingStatus')); } break;
    case 'discard': if (S.live) { S.live.wrap.remove(); S.live = null; } break;
    case 'assistant_done':
      if (S.live) {
        S.live.body.classList.remove('cursor');
        if (ev.content) S.live.body.innerHTML = md(ev.content);
        else S.live.body.remove();
        if (ev.usage?.total_tokens) S.live.wrap.querySelector('.who').title = t('chat.tokens', { in: ev.usage.prompt_tokens, out: ev.usage.completion_tokens });
      }
      break;
    case 'tool_call': {
      const blk = S.live || addAssistant('');
      addTool(blk, ev.id, ev.name, ev.args);
      scrollDown();
      break;
    }
    case 'tool_running': {
      const t = S.tools.get(ev.id);
      if (t) { t.classList.add('run'); t.querySelector('.st').innerHTML = '<span class="spin">◌</span>'; }
      setStatus(I18N.t('chat.runningTool', { name: t?._name || I18N.t('chat.tool') }));
      break;
    }
    case 'tool_result': {
      const t = S.tools.get(ev.id);
      if (t) { t.querySelector('.perm')?.remove(); fillTool(t, ev.ok, ev.output, ev.display); }
      scrollDown();
      break;
    }
    case 'permission': showPermission(ev); break;
    case 'notice': addNote(ev.text, 'warn'); break;
    case 'status': setStatus(ev.text); break;
    case 'error': addError(ev.text); break;
    case 'stopped': addNote(t('chat.stopped')); break;
    case 'done': break;
    case 'idle':
      if (S.live) S.live.body?.classList.remove('cursor');
      S.live = null;
      setStatus('');
      window.api.listModels(false).then((r) => { S.cooling = r.cooling; S.autoOrder = r.autoOrder; });
      break;
  }
}

function showPermission(ev) {
  const tl = S.tools.get(ev.id);
  if (!tl) return;
  setStatus(t('chat.waitPerm'));
  const box = el('div', 'perm');
  const a = ev.args || {};
  let q, detail = '';
  if (ev.name === 'run_command') { q = t('perm.run'); detail = a.command; }
  else if (ev.name === 'write_file') { q = t('perm.write', { path: a.path }); detail = String(a.content || '').slice(0, 3000); }
  else if (ev.name === 'edit_file') { q = t('perm.edit', { path: a.path }); }
  else if (ev.name === 'fetch_url') { q = t('perm.fetch'); detail = a.url; }
  else { q = t('perm.other', { name: ev.name }); detail = JSON.stringify(a, null, 2); }
  box.append(el('div', 'q', q));
  if (ev.name === 'edit_file') {
    const d = el('div', 'diff');
    d.style.marginLeft = '0';
    String(a.old_string || '').split('\n').forEach((s) => { const r = el('div', 'r'); r.textContent = '- ' + s; d.append(r); });
    String(a.new_string || '').split('\n').forEach((s) => { const r = el('div', 'a'); r.textContent = '+ ' + s; d.append(r); });
    box.append(d);
    d.style.marginBottom = '8px';
  } else if (detail) box.append(el('pre', null, detail));
  const acts = el('div', 'acts');
  const yes = el('button', 'btn primary small', t('perm.allow'));
  const always = el('button', 'btn small', t('perm.always', { name: ev.name }));
  const no = el('button', 'btn small', t('perm.deny'));
  const note = el('input');
  note.placeholder = t('perm.note');
  const reply = (d) => {
    window.api.replyPermission(ev.reqId, d, d === 'deny' ? note.value.trim() : '');
    box.remove();
    setStatus(t('chat.working'));
  };
  yes.onclick = () => reply('allow');
  always.onclick = () => reply('always');
  no.onclick = () => reply('deny');
  note.onkeydown = (e) => { if (e.key === 'Enter') reply('deny'); };
  acts.append(yes, always, no, note);
  box.append(acts);
  tl.append(box);
  scrollDown(true);
  yes.focus();
}

// ---------------------------------------------------------------- odesílání

function setStatus(t) { $('#status').textContent = t; }

function updateRunning() {
  const run = S.sessionId && S.running.has(S.sessionId);
  $('#stopBtn').hidden = !run;
  $('#sendBtn').disabled = !!run;
  if (!run) setStatus('');
}

async function sendMessage() {
  const text = $('#input').value.trim();
  if (!text) return;
  if (S.sessionId && S.running.has(S.sessionId)) return;
  if (!S.cwd) { $('#cwdBtn').click(); return; }
  $('#input').value = '';
  autoGrow();
  addUser(text);
  scrollDown(true);
  // ID nové konverzace vzniká tady, aby první události agenta nepřišly dřív, než ho známe.
  const isNew = !S.sessionId;
  const newId = isNew ? Date.now().toString(36) + Math.random().toString(36).slice(2, 8) : undefined;
  if (isNew) S.sessionId = newId;
  const r = await window.api.send({ sessionId: isNew ? null : S.sessionId, newId, text, model: S.settings.model || 'auto', mode: $('#modeSel').value, cwd: S.cwd, unfiltered: !!S.settings.unfiltered && S.settings.showUnfiltered === true });
  if (r.error) { if (isNew) S.sessionId = null; addError(r.error); return; }
  S.sessionId = r.sessionId;
  S.running.add(r.sessionId);
  if (isNew) await refreshSessions(); else renderSessions();
  updateRunning();
  setStatus(t('chat.working'));
}

$('#sendBtn').onclick = sendMessage;
$('#stopBtn').onclick = () => S.sessionId && window.api.stop(S.sessionId);
function autoGrow() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, window.innerHeight * 0.4) + 'px'; }
$('#input').addEventListener('input', autoGrow);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.sessionId && S.running.has(S.sessionId) && $('#modelPop').hidden) window.api.stop(S.sessionId);
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
});

// Odkazy v odpovědích otevírat v prohlížeči.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (/^https?:/.test(href)) window.api.openExternal(href);
});


// ---------------------------------------------------------------- nastavení

const PAGES = ['wizard', 'providers', 'models', 'tiers', 'opencode', 'general', 'advanced', 'diag', 'about'];
let setPage = 'providers';

function showPage(name) {
  setPage = PAGES.includes(name) ? name : 'providers';
  document.querySelectorAll('#setNav button').forEach((b) => b.classList.toggle('on', b.dataset.page === setPage));
  document.querySelectorAll('.settings .page').forEach((p) => { p.hidden = p.dataset.page !== setPage; });
  $('.settings').scrollTop = 0;
  if (setPage === 'models') renderUnitedModels();
  if (setPage === 'about') renderAbout();
  if (setPage === 'wizard') renderWizard();
  clearInterval(diagTimer); diagTimer = null;
  if (setPage === 'diag') { loadDiag(); diagTimer = setInterval(() => { if (!$('#settingsView').hidden && setPage === 'diag') loadDiag(); }, 3000); }
}
document.querySelectorAll('#setNav button').forEach((b) => { b.onclick = () => showPage(b.dataset.page); });

function openSettings(focusId) {
  $('#chatView').hidden = true;
  $('#settingsView').hidden = false;
  $('#optFallback').checked = S.settings.fallback !== false;
  $('#optTemp').value = S.settings.temperature ?? '';
  $('#optLang').value = I18N.lang;
  $('#optShowUnf').checked = S.settings.showUnfiltered === true;
  renderPopupSizeInputs();
  renderProviders();
  renderUnitedModels();
  renderCustom();
  window.api.proxyStatus().then(renderProxy);
  renderFullAuto();
  loadTiers();
  showPage('providers'); // z menu „Klíče a poskytovatelé“ i z postranního panelu začít u klíčů
  if (focusId) setTimeout(() => document.getElementById('prov-' + focusId)?.scrollIntoView({ block: 'center' }), 50);
}
function closeSettings() { $('#settingsView').hidden = true; $('#chatView').hidden = false; clearInterval(diagTimer); diagTimer = null; }
$('#openSettings').onclick = () => openSettings();
$('#openOmniDash').onclick = () => window.api.openOmni();
$('#openOpencode').onclick = async () => {
  const b = $('#openOpencode');
  b.disabled = true;
  b.textContent = t('side.ocStarting');
  const r = await window.api.openOpencode();
  b.disabled = false;
  b.textContent = t('side.openOc');
  if (!r.ok) { $('#freeCount').textContent = r.error; $('#freeCount').classList.add('bad'); }
};
$('#closeSettings').onclick = async () => {
  if (document.body.classList.contains('preset-only')) {
    const r = await window.api.closeWindow();
    if (r?.closed) return;
    await window.api.openOpencode();
    await window.api.closeWindow();
    return;
  }
  closeSettings();
  loadModels(false);
};
$('#optFallback').onchange = async (e) => { S.settings = await window.api.setSettings({ fallback: e.target.checked }); };
$('#optTemp').onchange = async (e) => { S.settings = await window.api.setSettings({ temperature: e.target.value }); };
// Jazyk: uloží se a okno se načte znovu (všechny texty se vykreslí v novém jazyce)
$('#optLang').onchange = async (e) => {
  S.settings = await window.api.setSettings({ lang: e.target.value });
  location.hash = '#settings-general';
  location.reload();
};
$('#optShowUnf').onchange = async (e) => {
  const patch = { showUnfiltered: e.target.checked };
  if (!e.target.checked) patch.unfiltered = false; // skrytý přepínač = režim vypnutý
  S.settings = await window.api.setSettings(patch);
  renderUnf();
  renderModelBtn();
};

// ---------------------------------------------------------------- tierlisty

const T = { data: null, sel: 'max', query: '' };
const STRENGTH_LABEL = { max: 'Max', high: 'High', mid: 'Mid', low: 'Low' };

async function loadTiers(force) {
  T.data = await window.api.getTiers(force);
  if (!T.data.tiers.some((x) => x.id === T.sel)) T.sel = T.data.tiers[0]?.id || 'max';
  $('#optOnlyTiers').checked = T.data.onlyTiers;
  $('#optOcProviders').checked = S.settings.ocProviders !== false;
  if (document.activeElement !== $('#optPrefer')) $('#optPrefer').value = (S.settings.preferFamilies || []).join(', ');
  renderTiers();
}

/** Uloží úpravu jednoho tierlistu (vestavěný se tím přepne z automatického na vlastní pořadí). */
async function saveTier(id, patch) {
  const cur = { ...(S.settings.tiers || {}) };
  const def = T.data.tiers.find((x) => x.id === id); // u právě zakládaného vlastního tierlistu ještě není
  if (patch === null) delete cur[id]; // smazat vlastní / vrátit vestavěný na automatický
  else {
    const isCustom = def ? def.custom : !!patch.custom;
    const base = cur[id] || (isCustom ? { custom: true, name: def?.name || t('tiers.custom'), models: [] } : {});
    cur[id] = { ...base, ...patch };
  }
  S.settings = await window.api.setSettings({ tiers: cur });
  await loadTiers();
}

function modelInfo(key) { return T.data.models.find((m) => m.key === key); }
const tierModelLabel = (m) => `${m.providerName || m.provider} · ${m.id}`;

function renderTiers() {
  if (!T.data) return;
  const tabs = $('#tierTabs');
  tabs.replaceChildren();
  for (const tier of T.data.tiers) {
    const b = el('button', 'tier-tab' + (tier.id === T.sel ? ' on' : ''));
    b.append(el('span', null, tier.name), el('span', 'cnt', String(tier.keys.filter((k) => modelInfo(k)).length)));
    b.onclick = () => { T.sel = tier.id; T.query = ''; renderTiers(); };
    tabs.append(b);
  }
  const add = el('button', 'tier-tab add', t('tiers.new'));
  add.onclick = async () => {
    const id = 'c-' + Date.now().toString(36);
    T.sel = id;
    await saveTier(id, { custom: true, name: t('tiers.custom'), models: [] });
    setTimeout(() => $('#tierName')?.select(), 30);
  };
  tabs.append(add);

  const tier = T.data.tiers.find((x) => x.id === T.sel);
  const box = $('#tierEdit');
  box.replaceChildren();
  if (!tier) return;

  const head = el('div', 'tier-head');
  if (tier.custom) {
    const name = el('input');
    name.id = 'tierName';
    name.value = tier.name;
    name.maxLength = 40;
    name.onchange = () => saveTier(tier.id, { name: name.value.trim() || t('tiers.custom') });
    head.append(name);
  } else head.append(el('strong', null, `${tier.name}`), el('span', 'muted', ` · ${tier.desc}`));
  head.append(el('span', 'tier-mode', tier.auto ? t('tiers.modeAuto') : t('tiers.modeManual')));
  head.append(el('div', 'bar-spacer'));
  if (!tier.custom && !tier.auto) {
    const reset = el('button', 'btn small', t('tiers.reset'));
    reset.onclick = () => saveTier(tier.id, null);
    head.append(reset);
  }
  if (tier.custom) {
    const del = el('button', 'btn small', t('tiers.delete'));
    del.onclick = async () => { T.sel = 'max'; await saveTier(tier.id, null); };
    head.append(del);
  }
  box.append(head);

  // záložní tierlist
  const fb = el('label', 'row-inline');
  fb.append(t('tiers.fallback'));
  const sel = el('select');
  sel.append(new Option(t('tiers.fallbackNone'), ''));
  for (const o of T.data.tiers) if (o.id !== tier.id) sel.append(new Option(o.name, o.id));
  sel.value = tier.fallback || '';
  sel.onchange = () => saveTier(tier.id, { fallback: sel.value || null });
  fb.append(sel);
  box.append(fb);

  // kontextový limit pro OpenCode: prázdné = automaticky (medián kontextů prvních modelů)
  const nf = new Intl.NumberFormat(I18N.locale());
  const cx = el('label', 'row-inline');
  cx.append(t('tiers.ctx'));
  const ci = el('input');
  ci.type = 'number';
  ci.min = 4000;
  ci.max = 2000000;
  ci.step = 1000;
  ci.className = 'tier-ctx';
  ci.placeholder = t('tiers.ctxAuto', { n: nf.format(tier.contextAuto) });
  ci.value = tier.contextOverride || '';
  ci.onchange = () => saveTier(tier.id, { context: ci.value ? Number(ci.value) : null });
  cx.append(ci);
  cx.append(el('span', 'muted small', tier.contextOverride ? t('tiers.ctxCustom', { n: nf.format(tier.contextAuto) }) : t('tiers.ctxNote')));
  if (tier.contextOverride) {
    const auto = el('button', 'btn small', t('tiers.ctxAutoBtn'));
    auto.onclick = (e) => { e.preventDefault(); saveTier(tier.id, { context: null }); };
    cx.append(auto);
  }
  box.append(cx);

  // seznam modelů v pořadí
  const list = el('ol', 'tier-list');
  const keys = tier.keys.slice();
  const setKeys = (next) => saveTier(tier.id, { models: next });
  keys.forEach((k, i) => {
    const m = modelInfo(k);
    const li = el('li', 'tier-row' + (m ? '' : ' gone'));
    li.draggable = true;
    li.dataset.i = i;
    const tx = el('div', 'tx');
    tx.append(el('span', 'nm', m ? tierModelLabel(m) : k));
    const meta = m ? [m.context ? `${Math.round(m.context / 1000)}k` : '', m.tools === false ? t('tiers.noTools') : '', m.local ? t('tiers.local') : ''].filter(Boolean).join(' · ') : t('tiers.gone');
    if (meta) tx.append(el('span', 'meta', meta));
    const acts = el('div', 'acts');
    const up = el('button', 'btn small', '↑'); up.title = t('tiers.up'); up.disabled = i === 0;
    up.onclick = () => { const n = keys.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; setKeys(n); };
    const down = el('button', 'btn small', '↓'); down.title = t('tiers.down'); down.disabled = i === keys.length - 1;
    down.onclick = () => { const n = keys.slice(); [n[i + 1], n[i]] = [n[i], n[i + 1]]; setKeys(n); };
    const rm = el('button', 'btn small', t('common.remove'));
    rm.onclick = () => setKeys(keys.filter((_, j) => j !== i));
    acts.append(up, down, rm);
    li.append(el('span', 'num', String(i + 1)), tx, acts);
    li.ondragstart = (e) => { e.dataTransfer.setData('text/plain', String(i)); li.classList.add('drag'); };
    li.ondragend = () => li.classList.remove('drag');
    li.ondragover = (e) => { e.preventDefault(); li.classList.add('over'); };
    li.ondragleave = () => li.classList.remove('over');
    li.ondrop = (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(from) || from === i) return;
      const n = keys.slice();
      const [it] = n.splice(from, 1);
      n.splice(i, 0, it);
      setKeys(n);
    };
    list.append(li);
  });
  if (!keys.length) list.append(el('li', 'tier-empty', tier.auto ? t('tiers.emptyAuto') : t('tiers.empty')));
  box.append(list);

  // přidání modelu
  const addRow = el('div', 'tier-add');
  const q = el('input');
  q.type = 'text';
  q.placeholder = t('tiers.addPh');
  q.value = T.query;
  const res = el('div', 'tier-results');
  const showResults = () => {
    T.query = q.value;
    res.replaceChildren();
    const s = q.value.trim().toLowerCase();
    if (!s) return;
    const hits = T.data.models.filter((m) => !keys.includes(m.key) && `${m.key} ${m.providerName}`.toLowerCase().includes(s)).slice(0, 30);
    if (!hits.length) { res.append(el('div', 'muted small', t('common.nothing'))); return; }
    for (const m of hits) {
      const r = el('button', 'tier-hit');
      r.append(el('span', 'nm', tierModelLabel(m)), el('span', 'meta', `${STRENGTH_LABEL[m.strength] || ''}${m.context ? ` · ${Math.round(m.context / 1000)}k` : ''}${m.uncensored ? t('tiers.uncens') : ''}`));
      r.onclick = () => { T.query = q.value; setKeys([...keys, m.key]).then(() => setTimeout(() => $('.tier-add input')?.focus(), 20)); };
      res.append(r);
    }
  };
  q.oninput = showResults;
  addRow.append(q, res);
  box.append(addRow);
  if (T.query) showResults();
}

// Plný automatický režim: zapnutí jen přes červené varování a výslovné potvrzení
function renderFullAuto() {
  const on = S.settings?.ocFullAuto === true;
  $('#optFullAuto').checked = on;
  $('#fullAutoOn').hidden = !on;
  if (on) $('#fullAutoWarn').hidden = true;
}
$('#optFullAuto').onchange = async (e) => {
  if (e.target.checked) { e.target.checked = false; $('#fullAutoWarn').hidden = false; $('#fullAutoYes').focus(); return; }
  S.settings = await window.api.setSettings({ ocFullAuto: false });
  renderFullAuto();
};
$('#fullAutoYes').onclick = async () => { S.settings = await window.api.setSettings({ ocFullAuto: true }); renderFullAuto(); };
$('#fullAutoNo').onclick = () => { $('#fullAutoWarn').hidden = true; };
function renderPopupSizeInputs() {
  const w = Number(S.settings?.modelPopupWidth) || 680;
  const h = Number(S.settings?.modelPopupHeight) || 560;
  if ($('#optPopupW')) $('#optPopupW').value = w;
  if ($('#optPopupWNum')) $('#optPopupWNum').value = w;
  if ($('#optPopupH')) $('#optPopupH').value = h;
  if ($('#optPopupHNum')) $('#optPopupHNum').value = h;
}
async function setPopupSize(w, h) {
  const patch = {};
  if (w != null) patch.modelPopupWidth = Math.max(320, Math.min(1400, Number(w) || 680));
  if (h != null) patch.modelPopupHeight = Math.max(260, Math.min(1100, Number(h) || 560));
  S.settings = await window.api.setSettings(patch);
  renderPopupSizeInputs();
}
$('#optPopupW')?.addEventListener('input', (e) => { $('#optPopupWNum').value = e.target.value; setPopupSize(e.target.value, null); });
$('#optPopupWNum')?.addEventListener('change', (e) => setPopupSize(e.target.value, null));
$('#optPopupH')?.addEventListener('input', (e) => { $('#optPopupHNum').value = e.target.value; setPopupSize(null, e.target.value); });
$('#optPopupHNum')?.addEventListener('change', (e) => setPopupSize(null, e.target.value));
document.querySelectorAll('.popup-preset').forEach((b) => {
  b.onclick = () => setPopupSize(b.dataset.w, b.dataset.h);
});
$('#optOnlyTiers').onchange = async (e) => { S.settings = await window.api.setSettings({ ocOnlyTiers: e.target.checked }); };
$('#optOcProviders').onchange = async (e) => { S.settings = await window.api.setSettings({ ocProviders: e.target.checked }); };
$('#optPrefer').onchange = async (e) => {
  S.settings = await window.api.setSettings({ preferFamilies: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) });
  loadTiers(true);
};
$('#openSkills').onclick = () => window.api.openSkills();

// ---------------------------------------------------------------- proxy

function renderProxy(st) {
  if (!st) return;
  $('#optProxy').checked = st.enabled;
  if (document.activeElement !== $('#optProxyPort')) $('#optProxyPort').value = st.port;
  $('#proxyUrl').textContent = st.url;
  const state = $('#proxyState');
  state.className = 'state ' + (st.running ? 'ok' : st.error ? 'bad' : '');
  state.textContent = st.running ? (st.note ? `${t('common.running')} · ${st.note}` : t('common.running')) : st.error || t('common.off');
  $('#optOmni').checked = S.settings?.router !== 'zdarma';
  $('#omniState').textContent = st.router?.text || '';
  $('#proxyOpencode').textContent = st.opencodeConfigured ? t('proxy.configured') : t('proxy.configure');
  $('#proxyLog').replaceChildren(...st.log.slice(-6).reverse().map((e) => {
    const time = new Date(e.at).toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return el('div', e.ok ? '' : 'bad', `${time}  ${e.requested} → ${e.model || '–'}  ${(e.ms / 1000).toFixed(1)} s${e.ok ? (e.tools ? t('proxy.tool', { n: e.tools }) : '') : '  · ' + e.error}`);
  }));
}
window.api.onProxyChanged((st) => { if (!$('#settingsView').hidden) renderProxy(st); });
// služba kontroly klíčů: výsledek poslední kontroly (běží sama každých 30 min) + ruční spuštění
const setKeyHealth = (kh) => { S.keyHealth = kh; if ($('#provList')) renderProviders(); };
window.api.onKeyHealth(setKeyHealth);
window.api.keyHealth(false).then(setKeyHealth).catch(() => {});
$('#checkKeys').onclick = async () => {
  const b = $('#checkKeys');
  b.disabled = true;
  $('#testAllState').textContent = t('prov.khRunning');
  try { setKeyHealth(await window.api.keyHealth(true)); const bad = (S.keyHealth.items || []).filter((i) => !i.ok).length; $('#testAllState').textContent = t('prov.khDone', { n: (S.keyHealth.items || []).length, bad }); }
  finally { b.disabled = false; }
};
// klíče v soukromém repu (private/keys.json)
function showKeysFile(st) {
  $('#kfPath').textContent = st.file || t('kf.none');
  const when = st.updatedAt ? new Date(st.updatedAt).toLocaleString(I18N.lang === 'en' ? 'en-GB' : 'cs-CZ') : '';
  let txt = st.file ? (st.exists ? t('kf.state', { n: st.count, when }) : t('kf.notYet')) : '';
  if (st.imported?.length) txt += ' ' + t('kf.imported', { list: st.imported.join(', ') });
  if (st.error) txt += ' ' + st.error;
  $('#kfState').textContent = txt.trim();
}
window.api.keysFile().then(showKeysFile).catch(() => {});
// klíče na více zařízeních (src/keyVault.js): jeden kód, šifrováno v appce
function renderVault(st, msg) {
  const box = $('#vaultBox');
  if (!box) return;
  box.replaceChildren();
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (key, fn, cls = 'btn small') => { const b = mk('button', cls, t(key)); b.onclick = async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }; return b; };
  const status = mk('div', 'muted small');
  const after = async (r) => {
    S.settings = await window.api.getSettings(); renderProviders(); renderCustom();
    renderVault(await window.api.vault('get'), r && r.ok === false ? (r.error || '') : r?.imported?.length ? t('vault.imported', { list: r.imported.join(', ') }) : (r?.msg || ''));
  };
  if (st.linked) {
    const row = mk('div', 'vault-row');
    const code = mk('span', 'vault-code', '••••-••••-••••-••••-••••');
    let shown = false;
    const show = btn('vault.show', () => { shown = !shown; code.textContent = shown ? st.code : '••••-••••-••••-••••-••••'; show.textContent = t(shown ? 'vault.hide' : 'vault.show'); });
    row.append(mk('span', null, t('vault.linked')), code, show, btn('vault.copy', async () => { await window.api.copyText(st.code); status.textContent = t('vault.copied'); }));
    const row2 = mk('div', 'vault-row');
    row2.append(btn('vault.syncNow', async () => after(await window.api.vault('sync'))), btn('vault.unlink', async () => after(await window.api.vault('unlink', false))),
      btn('vault.wipe', async () => { if (confirm(t('vault.wipeConfirm'))) after(await window.api.vault('unlink', true)); }));
    box.append(row, row2, mk('p', 'muted small vault-warn', t('vault.warn')));
    const when = st.at ? new Date(st.at).toLocaleString(I18N.lang === 'en' ? 'en-GB' : 'cs-CZ') : '';
    status.textContent = msg || (st.error ? st.error : when ? t('vault.lastSync', { when }) : '');
  } else {
    const row = mk('div', 'vault-row');
    row.append(btn('vault.create', async () => after(await window.api.vault('create')), 'btn small primary'));
    const row2 = mk('div', 'vault-row');
    const inp = mk('input'); inp.type = 'text'; inp.placeholder = 'XXXX-XXXX-XXXX-XXXX-XXXX'; inp.spellcheck = false; inp.autocomplete = 'off'; inp.maxLength = 32;
    inp.setAttribute('aria-label', t('vault.codeLabel'));
    row2.append(mk('span', null, t('vault.haveCode')), inp, btn('vault.join', async () => after(await window.api.vault('join', inp.value))));
    const row3 = mk('div', 'vault-row');
    row3.append(btn('vault.toFile', async () => { const r = await window.api.vault('exportFile'); if (r?.ok) status.textContent = t('vault.fileSaved', { code: r.code }); }),
      btn('vault.fromFile', async () => { const r = await window.api.vault('importFile', inp.value); if (r?.ok) after({ imported: r.imported, msg: t('vault.fileNone') }); else if (r?.error) status.textContent = r.error; }));
    box.append(row, row2, mk('p', 'muted small vault-or', t('vault.fileIntro')), row3, mk('p', 'muted small vault-warn', t('vault.warn')));
    status.textContent = msg || '';
  }
  status.setAttribute('aria-live', 'polite');
  box.append(status);
}
window.api.vault('get').then((st) => renderVault(st)).catch(() => {});
$('#wizVault')?.addEventListener('click', () => { showPage('providers'); $('#vaultSection')?.scrollIntoView({ block: 'start' }); setTimeout(() => $('#vaultBox input')?.focus(), 50); });
window.api.onKeysChanged?.(async () => { S.settings = await window.api.getSettings(); renderProviders(); renderCustom(); renderVault(await window.api.vault('get')); });
$('#kfPick').onclick = async () => { showKeysFile(await window.api.keysFilePick()); S.settings = await window.api.getSettings(); renderProviders(); renderCustom(); };
$('#kfSync').onclick = async () => { showKeysFile(await window.api.keysFileSync()); S.settings = await window.api.getSettings(); renderProviders(); renderCustom(); };
$('#optProxy').onchange = async (e) => { S.settings = await window.api.setSettings({ proxy: e.target.checked }); };
$('#optOmni').onchange = async (e) => { S.settings = await window.api.setSettings({ router: e.target.checked ? 'omniroute' : 'zdarma' }); };
$('#optProxyPort').onchange = async (e) => { S.settings = await window.api.setSettings({ proxyPort: Number(e.target.value) }); };
$('#proxyOpencode').onclick = async () => {
  const r = await window.api.configureOpencode();
  const res = $('#proxyOcRes');
  res.className = 'test ' + (r.ok ? 'ok' : 'bad');
  res.textContent = r.ok ? t('proxy.written', { file: r.file }) : r.error;
  renderProxy(r.status);
};

// ---------------------------------------------------------------- poskytovatelé

function provState(id) {
  const st = S.status[id];
  if (!st) return ['', ''];
  switch (st.state) {
    case 'ok': return [fm(st.count), 'ok'];
    case 'nokey': return [st.count ? t('prov.stMissingN', { models: fm(st.count) }) : t('prov.stMissing'), ''];
    case 'off': return [t('common.off'), ''];
    case 'offline': return [t('prov.stOffline'), ''];
    case 'error': return [st.error, 'bad'];
    default: return ['', ''];
  }
}

const hasKey = (p) => !!(S.settings.providers[p.id]?.hasKey || p.envKey);
// „použitelný“ = s klíčem, nebo funguje bez klíče (a není lokální, kde test vyžaduje běžící server)
const usableProv = (p) => hasKey(p) || (!p.needsKey && !p.local);
const provNote = (p) => (I18N.lang === 'en' && p.noteEn ? p.noteEn : p.note) || '';

// ---------------------------------------------------------------- průvodce klíči (src/wizard.js)
// Krok za krokem: proč ten poskytovatel, jak získat klíč, vložit → uložit → hned ověřit dotazem na model.
const wiz = { i: null, msg: null };
function wizDef(id) { return (S.settings.providerDefs || []).find((p) => p.id === id); }
function wizKeyed() { return WIZARD.STEPS.filter((s) => S.settings.providers[s.id]?.hasKey).length; }
function renderWizard() {
  const steps = WIZARD.STEPS;
  if (wiz.i == null) wiz.i = WIZARD.firstOpen({ providers: S.settings.providers });
  const k = wizKeyed();
  $('#wizProgress').textContent = '· ' + t('wiz.progress', { k, n: steps.length });
  $('#wizIntro').textContent = t('wiz.intro', { n: WIZARD.ENOUGH });
  const dots = $('#wizDots');
  dots.innerHTML = '';
  steps.forEach((s, i) => {
    const d = el('li', (S.settings.providers[s.id]?.hasKey ? 'ok' : '') + (i === wiz.i ? ' on' : ''));
    const b = el('button', 'link', (S.settings.providers[s.id]?.hasKey ? '✓ ' : '') + (wizDef(s.id)?.name || s.id));
    b.onclick = () => { wiz.i = i; wiz.msg = null; renderWizard(); };
    d.append(b);
    dots.append(d);
  });
  const card = $('#wizCard');
  card.innerHTML = '';
  if (wiz.i >= steps.length) return renderWizardDone(card, k);
  const s = steps[wiz.i];
  const p = wizDef(s.id) || { id: s.id, name: s.id };
  const box = el('div', 'prov wiz-card');
  const top = el('div', 'top');
  top.append(el('span', 'muted small', t('wiz.step', { i: wiz.i + 1, n: steps.length })), el('strong', 'nm', p.name));
  const have = S.settings.providers[s.id]?.hasKey;
  if (have) top.append(el('span', 'state ok', t('prov.keySaved')));
  box.append(top);
  box.append(el('h3', 'sub', t('wiz.whyH')), el('p', '', t(`wiz.${s.id}.why`)));
  if (s.adult) box.append(el('p', 'wiz-warn', t('wiz.adult')));
  box.append(el('h3', 'sub', t('wiz.howH')));
  const ol = el('ol', 'wiz-how');
  t(`wiz.${s.id}.how`).split('|').forEach((x) => ol.append(el('li', '', x)));
  box.append(ol);
  const open = el('button', 'btn primary small', t('wiz.open'));
  open.onclick = () => window.api.openExternal(p.keyUrl);
  const openRow = el('div', 'keyrow');
  openRow.append(open);
  box.append(openRow);
  if (have) box.append(el('p', 'muted small', t('wiz.have', { k: S.settings.providers[s.id].key })));
  const kr = el('div', 'keyrow');
  const inp = el('input');
  inp.type = 'password';
  inp.id = 'wizKey';
  inp.placeholder = t('wiz.paste');
  inp.autocomplete = 'off';
  const save = el('button', 'btn primary small', t('wiz.saveTest'));
  const res = el('div', 'test' + (wiz.msg ? ' ' + wiz.msg.cls : ''), wiz.msg?.text || '');
  save.onclick = async () => {
    const v = WIZARD.cleanKey(inp.value);
    if (!v) { inp.focus(); return; }
    const nk = WIZARD.notKey(v);
    if (nk) { res.className = 'test bad'; res.textContent = nk === 'url' ? t('wiz.notKey.url') : nk === 'email' ? t('wiz.notKey.email') : t('wiz.notKey.short'); inp.focus(); return; }
    // klíč jiného poskytovatele (podle prefixu) → uložit tam, kam patří, a říct to
    const owner = WIZARD.ownerOf(v);
    const target = owner && owner !== s.id && wizDef(owner) ? owner : s.id;
    save.disabled = true;
    res.className = 'test';
    res.textContent = t('wiz.checking');
    S.settings = await window.api.setSettings({ provider: { id: target, key: v, enabled: true } });
    inp.value = '';
    let r;
    try { r = await window.api.testProvider(target); } catch (e) { r = { ok: false, error: e.message }; }
    const moved = target !== s.id ? t('wiz.moved', { name: wizDef(target)?.name || target, here: p.name }) + ' ' : '';
    wiz.msg = r.ok ? { cls: 'ok', text: moved + t('wiz.ok', { model: r.model, s: (r.ms / 1000).toFixed(1) }) } : { cls: 'bad', text: moved + t('wiz.bad', { err: r.error }) };
    loadModels(true);
    renderWizard();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') save.click(); };
  kr.append(inp, save);
  box.append(kr, res);
  const nav = el('div', 'keyrow wiz-nav');
  const back = el('button', 'btn small', t('wiz.back'));
  back.disabled = wiz.i === 0;
  back.onclick = () => { wiz.i -= 1; wiz.msg = null; renderWizard(); };
  const next = el('button', 'btn small' + (have ? ' primary' : ''), have ? t('wiz.next') : t('wiz.skip'));
  next.id = 'wizNext';
  next.onclick = () => { wiz.i += 1; wiz.msg = null; renderWizard(); };
  nav.append(back, el('div', 'bar-spacer'), next);
  box.append(nav);
  card.append(box);
  if (!have) setTimeout(() => inp.focus(), 0);
}
function renderWizardDone(card, k) {
  const box = el('div', 'prov wiz-card');
  box.append(el('h3', 'sub', t('wiz.doneH')));
  const n = WIZARD.ENOUGH;
  box.append(el('p', '', k >= n ? t('wiz.doneEnough', { k }) : k > 0 ? t('wiz.doneFew', { k, n }) : t('wiz.doneNone')));
  // zkouška celé cesty (klíče + OmniRoute + závod) jedním krátkým dotazem
  if (k > 0) {
    const sm = el('div', 'keyrow');
    const btn = el('button', 'btn small', t('wiz.smoke'));
    btn.id = 'wizSmoke';
    const out = el('div', 'test');
    out.id = 'wizSmokeOut';
    btn.onclick = async () => {
      btn.disabled = true; out.className = 'test'; out.textContent = t('wiz.smokeRun');
      let r; try { r = await window.api.wizardSmoke(); } catch (e) { r = { ok: false, error: e.message }; }
      out.className = 'test ' + (r.ok ? 'ok' : 'bad');
      out.textContent = r.ok ? t('wiz.smokeOk', { model: r.model, s: (r.ms / 1000).toFixed(1) }) : t('wiz.smokeBad', { err: r.error || r.status });
      btn.disabled = false;
    };
    sm.append(btn);
    box.append(sm, out);
  }
  // lehký benchmark modelů (jednou po prvním průvodci; jde přeskočit): drobný dotaz na čelo každého tieru
  if (k > 0 && !S.settings.benchAt && !S.settings.benchSkipped) {
    const bb = el('div', 'wiz-bench');
    bb.id = 'wizBench';
    bb.append(el('p', '', t('wiz.benchQ')));
    const brow = el('div', 'keyrow');
    const run = el('button', 'btn small primary', t('wiz.benchRun'));
    run.id = 'wizBenchRun';
    const skip = el('button', 'btn small', t('wiz.benchSkip'));
    skip.id = 'wizBenchSkip';
    const bout = el('div', 'test');
    bout.id = 'wizBenchOut';
    run.onclick = async () => {
      run.disabled = skip.disabled = true; bout.className = 'test'; bout.textContent = t('wiz.benchBusy');
      let r; try { r = await window.api.modelsBench(); } catch (e) { r = { ok: false, reason: 'error', error: e.message }; }
      if (r.ok) {
        bout.className = 'test ' + (r.working ? 'ok' : 'bad');
        bout.textContent = t('wiz.benchOk', { working: r.working, probed: r.probed, broken: r.broken, s: Math.round(r.ms / 1000) }) + (r.shared ? ' ' + t('wiz.benchShared') : '');
        S.settings.benchAt = new Date().toISOString();
        skip.remove();
      } else {
        bout.className = 'test bad';
        bout.textContent = r.reason === 'installing' ? t('wiz.benchInstalling') : r.reason === 'omni' ? t('wiz.benchNoOmni') : t('wiz.benchErr', { err: r.error || r.reason });
        run.disabled = skip.disabled = false;
      }
    };
    skip.onclick = async () => { S.settings = await window.api.setSettings({ benchSkipped: true }); bb.remove(); };
    brow.append(run, skip);
    bb.append(brow, bout);
    box.append(bb);
  }
  box.append(el('p', 'muted small', t('wiz.more')));
  const row = el('div', 'keyrow wiz-nav');
  const again = el('button', 'btn small', t('wiz.restart'));
  again.onclick = () => { wiz.i = 0; wiz.msg = null; renderWizard(); };
  const fin = el('button', 'btn primary', t('wiz.finish'));
  fin.id = 'wizFinish';
  fin.onclick = async () => { S.settings = await window.api.setSettings({ wizardDone: true }); $('#closeSettings').click(); };
  row.append(again, el('div', 'bar-spacer'), fin);
  box.append(row);
  card.append(box);
}

$('#provSearch').oninput = () => renderProviders();
$('#provFilter').onchange = () => renderProviders();
$('#unitedSearch').oninput = () => renderUnitedModels();
$('#unitedFilter').onchange = () => renderUnitedModels();

function renderUnitedModels() {
  const box = $('#unitedList');
  if (!box) return;
  box.replaceChildren();
  const all = S.united || [];
  const usableCount = all.filter((u) => u.usable?.length > 0).length;
  const multiCount = all.filter((u) => u.usable?.length >= 2).length;
  $('#unitedCount').textContent = '· ' + t('united.count', { usable: usableCount, multi: multiCount });
  const q = ($('#unitedSearch')?.value || '').trim().toLowerCase();
  const f = $('#unitedFilter')?.value || 'all';
  const cool = new Map(S.cooling.map((c) => [c.key, c]));
  const curModel = S.settings?.model || 'auto';

  const list = all.filter((u) => {
    if (f !== 'locked' && !u.usable?.length) return false;
    if (f === 'multi' && (u.usable?.length || 0) < 2) return false;
    if (f === 'max' && u.strength !== 'max') return false;
    if (f === 'high' && u.strength !== 'high') return false;
    if (q) {
      const hay = `${u.slug} ${u.title} ${(u.providers || []).join(' ')} ${(u.lockedProviders || []).map((p) => p.name).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!list.length) {
    box.append(el('div', 'muted small prov-empty', t('common.nothing')));
    return;
  }

  for (const u of list) {
    const row = el('div', 'prov');
    const top = el('div', 'top');
    top.append(el('span', 'nm', u.title));
    top.append(el('span', 'strength-tag s-' + u.strength, STRENGTH_LABEL[u.strength] || u.strength));
    if (u.rawContext || u.context) top.append(el('span', 'state', fmtCtx(u.rawContext || u.context)));
    top.append(el('span', 'state mono', `opencode-omniroute/${u.slug}`));
    top.append(el('div', 'bar-spacer'));
    if (u.usable?.length) {
      const isSel = curModel === u.slug || curModel === `united:${u.slug}`;
      const pickBtn = el('button', 'btn small' + (isSel ? ' primary' : ''), isSel ? t('united.selected') : t('united.useChat'));
      pickBtn.onclick = async () => {
        S.settings = await window.api.setSettings({ model: u.slug });
        renderModelBtn();
        renderUnitedModels();
      };
      top.append(pickBtn);
    }
    row.append(top);

    if (u.usable?.length) {
      const pills = el('div', 'united-pills');
      pills.append(el('span', 'muted small', t('united.activeProv')));
      u.usable.forEach((m, idx) => {
        const c = cool.get(m.key) || cool.get('provider:' + m.provider);
        const isActive = (u.activeKey ? u.activeKey === m.key : idx === 0) && !c;
        const p = el('span', 'united-pill ' + (c ? 'cool' : isActive ? 'pin' : 'ok'), `${idx + 1}. ${m.providerName || m.provider}`);
        p.title = c ? `${m.key} · ${t('chat.cooling', { min: Math.max(1, Math.round((c.until - Date.now()) / 60000)), reason: c.reason })}` : m.key;
        pills.append(p);
      });
      row.append(pills);
    }

    if (u.lockedProviders?.length) {
      const lockPills = el('div', 'united-pills');
      lockPills.append(el('span', 'muted small', t('united.unlockProv')));
      for (const lp of u.lockedProviders) {
        const b = el('button', 'united-pill lock', `+ ${lp.name}`);
        b.onclick = () => {
          showPage('providers');
          setTimeout(() => document.getElementById('prov-' + lp.id)?.scrollIntoView({ block: 'center' }), 50);
        };
        lockPills.append(b);
      }
      row.append(lockPills);
    }

    box.append(row);
  }
}

function renderProviders() {
  const box = $('#provList');
  box.innerHTML = '';
  const defs = S.settings.providerDefs || [];
  const keyed = defs.filter((p) => p.needsKey && hasKey(p)).length;
  const needing = defs.filter((p) => p.needsKey).length;
  $('#provCount').textContent = '· ' + t('prov.count', { keyed, needing, total: defs.length });
  const q = $('#provSearch').value.trim().toLowerCase();
  const f = $('#provFilter').value;
  const pass = (p) => {
    if (q && !`${p.name} ${p.id} ${provNote(p)}`.toLowerCase().includes(q)) return false;
    if (f === 'key') return hasKey(p);
    if (f === 'free') return !p.needsKey;
    if (f === 'missing') return p.needsKey && !hasKey(p);
    return true;
  };
  // poskytovatelé s uloženým klíčem nahoře, ostatní v původním pořadí
  const list = [...defs.filter(hasKey), ...defs.filter((x) => !hasKey(x))].filter(pass);
  if (!list.length) box.append(el('div', 'muted small prov-empty', t('common.nothing')));
  for (const p of list) {
    const cfg = S.settings.providers[p.id] || {};
    const row = el('div', 'prov');
    row.id = 'prov-' + p.id;
    const top = el('div', 'top');
    const en = el('input');
    en.type = 'checkbox';
    en.checked = cfg.enabled !== false;
    en.title = t('prov.use');
    en.onchange = async () => { S.settings = await window.api.setSettings({ provider: { id: p.id, enabled: en.checked } }); loadModels(true); };
    const [stText, stCls] = provState(p.id);
    top.append(en, el('span', 'nm', p.name));
    if (hasKey(p)) top.append(el('span', 'state ok', t('prov.keySaved')));
    const kh = (S.keyHealth?.items || []).find((i) => i.provider === p.id);
    if (kh) {
      const use = kh.calls24h ? t('prov.khUse', { n: kh.calls24h, ok: kh.ok24h }) + (kh.limited24h ? t('prov.khLim', { n: kh.limited24h }) : '') : t('prov.khIdle');
      const badge = el('span', 'state ' + (kh.ok ? 'ok' : 'bad'), kh.ok ? t('prov.khOk', { use }) : t('prov.khBad', { err: kh.error || kh.status }));
      if (kh.lastTested) badge.title = t('prov.khWhen', { when: new Date(kh.lastTested).toLocaleString() });
      top.append(badge);
    }
    top.append(el('span', 'state ' + stCls, stText));
    row.append(top, el('div', 'note2', provNote(p)));

    const kr = el('div', 'keyrow');
    if (p.needsKey || !p.local) {
      const inp = el('input');
      inp.type = 'password';
      inp.placeholder = cfg.hasKey ? t('prov.savedKey', { k: cfg.key }) : p.envKey ? t('prov.envKey', { v: `${p.id.toUpperCase()}_API_KEY` }) : (p.keyHint ? t('prov.paste', { hint: p.keyHint }) : p.needsKey ? t('prov.pasteKey') : t('prov.optional'));
      const save = el('button', 'btn small', t('common.save'));
      save.onclick = async () => {
        if (!inp.value.trim()) return;
        S.settings = await window.api.setSettings({ provider: { id: p.id, key: inp.value.trim() } });
        inp.value = '';
        await loadModels(true);
        renderProviders();
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') save.click(); };
      kr.append(inp, save);
      if (cfg.hasKey) {
        const del = el('button', 'btn small', t('prov.deleteKey'));
        del.onclick = async () => { S.settings = await window.api.setSettings({ provider: { id: p.id, key: '' } }); await loadModels(true); renderProviders(); };
        kr.append(del);
      }
    }
    const get = el('button', 'link', p.local ? t('prov.download') : t('prov.getKey'));
    get.onclick = () => window.api.openExternal(p.keyUrl);
    const test = el('button', 'btn small', t('common.test'));
    const res = el('div', 'test');
    res.dataset.prov = p.id;
    test.onclick = () => runTest(p.id, res);
    kr.append(test, get);
    row.append(kr, res);
    box.append(row);
  }
}

async function runTest(id, res) {
  res.className = 'test';
  res.textContent = t('common.testing');
  const r = await window.api.testProvider(id);
  res.className = 'test ' + (r.ok ? 'ok' : 'bad');
  res.textContent = r.ok ? t('prov.works', { model: r.model, s: (r.ms / 1000).toFixed(1), reply: r.reply }) : t('prov.fails', { err: r.error });
  return r.ok;
}

// Otestovat všechny použitelné (s klíčem nebo bez klíče) postupně, výsledek u každého řádku
$('#testAll').onclick = async () => {
  const btn = $('#testAll');
  const state = $('#testAllState');
  $('#provFilter').value = 'all';
  $('#provSearch').value = '';
  renderProviders();
  const todo = (S.settings.providerDefs || []).filter((p) => usableProv(p) && (S.settings.providers[p.id]?.enabled !== false));
  btn.disabled = true;
  let ok = 0;
  for (let i = 0; i < todo.length; i++) {
    state.textContent = t('prov.testAllRun', { i: i + 1, n: todo.length });
    const res = document.querySelector(`.test[data-prov="${todo[i].id}"]`);
    if (res && await runTest(todo[i].id, res)) ok++;
  }
  state.textContent = t('prov.testAllDone', { ok, n: todo.length });
  btn.disabled = false;
};

function renderCustom() {
  const box = $('#customList');
  box.innerHTML = '';
  for (const c of S.settings.customProviders || []) {
    const row = el('div', 'prov');
    const [stText, stCls] = provState(c.id);
    const top = el('div', 'top');
    top.append(el('span', 'nm', c.name || c.id), el('span', 'state ' + stCls, stText));
    const g = el('div', 'custom-grid');
    const f = (label, key, ph, type = 'text') => {
      const i = el('input');
      i.type = type;
      i.value = key === 'key' ? '' : (c[key] || '');
      i.placeholder = key === 'key' && c.hasKey ? t('prov.savedKey', { k: c.key }) : ph;
      g.append(el('label', null, label), i);
      return i;
    };
    const name = f(t('custom.name'), 'name', t('custom.namePh'));
    const url = f('Base URL', 'baseUrl', 'https://…/v1');
    const key = f(t('custom.key'), 'key', t('custom.keyPh'), 'password');
    const models = f(t('custom.models'), 'models', t('custom.modelsPh'));
    const kr = el('div', 'keyrow');
    const save = el('button', 'btn small', t('common.save'));
    save.onclick = async () => {
      const patch = { id: c.id, name: name.value.trim(), baseUrl: url.value.trim(), models: models.value.trim() };
      if (key.value.trim()) patch.key = key.value.trim();
      S.settings = await window.api.setSettings({ custom: patch });
      await loadModels(true);
      renderCustom();
    };
    const test = el('button', 'btn small', t('common.test'));
    const res = el('div', 'test');
    test.onclick = async () => {
      res.textContent = t('common.testing');
      const r = await window.api.testProvider(c.id);
      res.className = 'test ' + (r.ok ? 'ok' : 'bad');
      res.textContent = r.ok ? t('prov.worksShort', { model: r.model, s: (r.ms / 1000).toFixed(1) }) : t('prov.fails', { err: r.error });
    };
    const del = el('button', 'btn small', t('common.remove'));
    del.onclick = async () => { S.settings = await window.api.setSettings({ custom: { id: c.id, remove: true } }); await loadModels(true); renderCustom(); };
    kr.append(save, test, del);
    row.append(top, g, kr, res);
    box.append(row);
  }
}
$('#addCustom').onclick = async () => {
  S.settings = await window.api.setSettings({ custom: { name: t('custom.default'), baseUrl: '', models: '' } });
  renderCustom();
};


// ---------------------------------------------------------------- diagnostika

let diagTimer = null;
let diagSession = null; // vybraná konverzace OpenCode pro rozbor
let diagBusy = false;
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString(I18N.locale(), { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const fmtS = (ms) => (ms == null ? '' : ms < 10000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms / 1000) + ' s');
const fmtK = (n) => (!n ? '0' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
const fmtMB = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(1) + ' MB');

/** Holá tabulka: cols = [[nadpis, funkce(řádek) → text, třída buňky]] */
function table(cols, rows, opts = {}) {
  if (!rows || !rows.length) return el('div', 'muted small', t('diag.none'));
  const tb = el('table', 'dt');
  const hr = el('tr');
  for (const [h] of cols) hr.append(el('th', null, h));
  tb.append(hr);
  for (const r of rows) {
    const tr = el('tr', opts.rowCls ? opts.rowCls(r) : '');
    for (const [, fn, cls] of cols) { const v = fn(r); const td = el('td', cls || ''); td.textContent = v == null ? '' : String(v); tr.append(td); }
    if (opts.onClick) { tr.classList.add('click'); tr.onclick = () => opts.onClick(r); }
    tb.append(tr);
  }
  return tb;
}

async function loadDiag() {
  if (diagBusy) return;
  diagBusy = true;
  try { renderDiag(await window.api.diagData(diagSession)); $('#diagState').textContent = fmtTime(Date.now()); }
  catch (e) { $('#diagState').textContent = e.message; }
  finally { diagBusy = false; }
}
$('#diagRefresh').onclick = () => loadDiag();
$('#diagExport').onclick = async () => { const f = await window.api.diagExport(); $('#diagState').textContent = t('diag.exported', { file: f }); };
$('#diagFolder').onclick = () => window.api.diagOpenFolder();

function kvRows(rows) {
  return rows.map(([k, v]) => { const tr = el('tr'); tr.append(el('th', null, k), el('td', null, v)); return tr; });
}

function renderDiag(d) {
  // co je špatně
  $('#diagFindings').replaceChildren(...(d.findings.length ? d.findings.map((x) => el('div', 'finding ' + x.level, t(x.key, x.vars))) : [el('div', 'muted small', t('diag.noFindings'))]));
  // stav
  const h = d.health;
  const act = h.active && h.active.current && h.active.current[0];
  const om = h.omniroute;
  $('#diagHealth').replaceChildren(...kvRows([
    [t('diag.hProxy'), h.proxy.running ? `${t('diag.up')} · :${h.proxy.port} · ${h.proxy.inflight} ${t('diag.cReq')}${h.proxy.note ? ' · ' + h.proxy.note : ''}` : `${t('diag.down')} ${h.proxy.error}`],
    [t('diag.hOc'), h.opencode.running ? `${t('diag.up')} · ${h.opencode.url} ${h.opencode.version || ''}` : t('diag.down')],
    [t('diag.hOmni'), !om.enabled ? t('diag.off') : om.ready ? `${t('diag.up')} · ${om.version} · :${om.port}${om.lastSync ? ` · ${om.lastSync.providers} / ${om.lastSync.combos}` : ''}${om.slow.length ? ' · ' + om.slow.join(', ') : ''}` : `${t('diag.down')} ${om.error}`],
    [t('diag.hNow'), act ? `${act.model} · ${act.providerName} · ${Math.round((h.active.now - act.since) / 1000)} s` : h.active && h.active.last ? `${t('diag.idle')} · ${h.active.last.model || ''} ${h.active.last.ok ? '' : '✗ ' + (h.active.last.error || '')}` : t('diag.idle')],
    [t('diag.hModels'), `${h.models.usable} / ${h.models.total}`],
    [t('diag.hCooling'), h.cooling.length ? h.cooling.map((c) => `${c.key} (${Math.max(1, Math.round((c.until - Date.now()) / 60000))} min: ${c.reason})`).join(' · ') : '–'],
    [t('diag.hVersion'), `Zdarma ${h.version} · Electron ${h.electron} · Node ${h.node} · ${h.platform}`],
  ]));
  // modely
  $('#diagModels').replaceChildren(table([
    [t('diag.cModel'), (r) => r.model, 'mono'],
    [t('diag.cReq'), (r) => r.requests, 'num'],
    [t('diag.cOk'), (r) => r.ok, 'num'],
    [t('diag.cMed'), (r) => fmtS(r.medianMs), 'num'],
    [t('diag.cTok'), (r) => `${fmtK(r.tokIn)} / ${fmtK(r.tokOut)}`, 'num'],
    [t('diag.cTools'), (r) => r.tools, 'num'],
    [t('diag.cFixed'), (r) => r.fixedArgs || '', 'num'],
    [t('diag.cErrors'), (r) => Object.entries(r.errors).map(([e, n]) => `${n}× ${e}`).join(' · ')],
  ], d.stats, { rowCls: (r) => (r.failed > r.ok ? 'bad' : '') }));
  // požadavky
  const okA = (r) => (r.attempts || []).find((x) => x.ok);
  $('#diagRequests').replaceChildren(table([
    [t('diag.cTime'), (r) => fmtTime(r.at)],
    [t('diag.cTier'), (r) => r.requested],
    [t('diag.cModel'), (r) => r.model || (r.attempts || []).map((a) => a.model).join(' → '), 'mono'],
    [t('diag.cMs'), (r) => fmtS(r.ms), 'num'],
    [t('diag.cTok'), (r) => { const a = okA(r); return a ? `${fmtK(a.inTok)} / ${fmtK(a.outTok)}` : `~${fmtK(r.estTok)}`; }, 'num'],
    [t('diag.cTools'), (r) => (okA(r) ? okA(r).toolCalls : ''), 'num'],
    [t('diag.cFixed'), (r) => (okA(r) && okA(r).fixedArgs) || '', 'num'],
    [t('diag.cStatus'), (r) => (r.ok ? (okA(r) && okA(r).finish) || 'ok' : r.error || '✗')],
  ], d.requests, { rowCls: (r) => (r.ok ? '' : 'bad') }));
  // OmniRoute
  $('#diagOmni').replaceChildren(table([
    [t('diag.cTime'), (r) => (r.at ? fmtTime(Date.parse(r.at)) : '')],
    [t('diag.cStatus'), (r) => r.status, 'num'],
    [t('diag.cModel'), (r) => r.model, 'mono'],
    [t('diag.cMs'), (r) => fmtS(r.ms), 'num'],
    ['TTFT', (r) => fmtS(r.ttft), 'num'],
    [t('diag.cErrors'), (r) => r.error],
  ], d.omniAttempts, { rowCls: (r) => (r.status && r.status >= 400 ? 'bad' : '') }));
  // konverzace
  const sel = d.detail && d.detail.id;
  $('#diagSessions').replaceChildren(d.sessions.error && !d.sessions.list.length ? el('div', 'muted small', d.sessions.error) : table([
    [t('diag.cTime'), (r) => fmtDateTime(r.updated)],
    [t('diag.cTitle'), (r) => r.title],
    [t('diag.cDir'), (r) => r.directory, 'mono'],
    [t('diag.cMsgs'), (r) => r.messages, 'num'],
    [t('diag.cTools'), (r) => r.toolCalls, 'num'],
    [t('diag.cToolErr'), (r) => r.toolErrors || '', 'num'],
    [t('diag.cComp'), (r) => r.compactions || '', 'num'],
    [t('diag.cTok'), (r) => `${fmtK(r.tokensIn)} / ${fmtK(r.tokensOut)}`, 'num'],
  ], d.sessions.list, { rowCls: (r) => (r.id === sel ? 'sel' : ''), onClick: (r) => { diagSession = r.id; loadDiag(); } }));
  renderDiagDetail(d.detail);
  // poskytovatelé
  $('#diagProviders').replaceChildren(table([
    ['ID', (r) => r.id, 'mono'],
    [t('diag.cTitle'), (r) => r.name],
    [t('diag.cStatus'), (r) => r.state],
    [t('diag.hModels'), (r) => r.count, 'num'],
    [t('diag.cErrors'), (r) => r.error],
  ], d.providers, { rowCls: (r) => (r.state === 'error' ? 'bad' : '') }));
  // logy
  $('#diagOmniLog').textContent = d.logs.omniroute.map((x) => `${x.at ? fmtTime(Date.parse(x.at)) : ''} ${x.level.toUpperCase()} ${x.tag} ${x.status || ''} ${x.msg}`).join('\n') || t('diag.none');
  $('#diagZdarmaLog').textContent = d.logs.zdarma.join('\n') || t('diag.none');
  // velikosti
  $('#diagSizes').replaceChildren(...kvRows([
    ['Zdarma (userData)', fmtMB(d.sizes.userData || 0)],
    ['  diagnostics', fmtMB(d.sizes.diagnostics || 0)],
    ['  omniroute', fmtMB(d.sizes.omnirouteData || 0)],
    ['OpenCode (opencode.db + wal)', fmtMB(d.sizes.opencodeDb || 0)],
  ]));
}

function renderDiagDetail(det) {
  const box = $('#diagDetail');
  box.replaceChildren();
  if (!det) { box.append(el('div', 'muted small', t('diag.none'))); return; }
  if (det.error) { box.append(el('div', 'muted small', det.error)); return; }
  const s = det.summary;
  box.append(el('p', null, `${det.title} · ${det.directory}`));
  box.append(el('p', 'muted small', t('diag.sumLine', { steps: s.steps, users: s.userMessages, tin: fmtK(s.tokensIn), tout: fmtK(s.tokensOut), med: fmtS(s.medianStepMs), comp: s.compactions })));
  const kv = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k} ${v}×`).join(' · ');
  box.append(el('p', 'small', `${t('diag.cModel')}: ${kv(s.models)}`));
  box.append(el('p', 'small', `${t('diag.cTools')}: ${kv(s.toolCount)}${Object.keys(s.toolErr || {}).length ? ` · ${t('diag.cToolErr')}: ${kv(s.toolErr)}` : ''}`));
  if (Object.keys(s.errors || {}).length) box.append(el('p', 'small tool-err', `${t('diag.cErrors')}: ${kv(s.errors)}`));
  if (s.toolErrorSamples.length) {
    box.append(el('h3', 'sub', t('diag.toolErrs')));
    box.append(table([['×', (r) => r.count, 'num'], [t('diag.cErrors'), (r) => r.error, 'mono']], s.toolErrorSamples));
  }
  if (s.loops.length) {
    box.append(el('h3', 'sub', t('diag.loops')));
    box.append(table([['×', (r) => r.count, 'num'], [t('diag.cWhat'), (r) => r.call, 'mono']], s.loops));
  }
  box.append(el('h3', 'sub', t('diag.requests')));
  const wrap = el('div', 'tbl-wrap');
  wrap.append(table([
    [t('diag.cTime'), (r) => fmtDateTime(r.at)],
    [t('diag.cModel'), (r) => (r.kind === 'user' ? 'USER' : r.model), 'mono'],
    [t('diag.cMs'), (r) => fmtS(r.ms), 'num'],
    [t('diag.cTok'), (r) => (r.kind === 'user' ? '' : `${fmtK(r.tokIn + r.cache)} / ${fmtK(r.tokOut)}`), 'num'],
    [t('diag.cThink'), (r) => (r.thinking ? r.thinking : ''), 'num'],
    [t('diag.cWhat'), (r) => (r.kind === 'user' ? r.text : [r.compaction ? 'COMPACTION' : '', r.error ? '✗ ' + r.error : '', ...r.tools.map((x) => `${x.error ? '✗ ' : ''}${x.tool} ${x.input}${x.error ? ' → ' + x.error : ''}`), r.text].filter(Boolean).join('\n'))],
  ], det.steps.slice().reverse(), { rowCls: (r) => (r.kind === 'user' ? 'step-user' : r.error || r.tools.some((x) => x.error) ? 'bad' : '') }));
  box.append(wrap);
}

// ---------------------------------------------------------------- o aplikaci

async function renderAbout() {
  const a = await window.api.about();
  const rows = [
    [t('about.version'), `Zdarma ${a.version}`],
    ['OpenCode', a.opencode || t('about.notInstalled')],
    ['OmniRoute', a.omniroute || t('about.notInstalled')],
    ['Node.js', a.node || t('about.notInstalled')],
    ['Electron', a.electron],
  ];
  $('#aboutTable').replaceChildren(...rows.map(([k, v]) => { const tr = el('tr'); tr.append(el('th', null, k), el('td', null, v)); return tr; }));
  $('#dataPath').textContent = a.dataDir;
}
$('#openData').onclick = () => window.api.openDataDir();

init().then(() => {
  // po přepnutí jazyka se okno načte znovu na stránce Obecné
  const m = /^#settings-(\w+)$/.exec(location.hash);
  if (m) { openSettings(); showPage(m[1]); history.replaceState(null, '', location.pathname); }
});
