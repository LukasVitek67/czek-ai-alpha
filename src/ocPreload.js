'use strict';
// Preload okna OpenCode. Stránce nabízí jen výběr složky přes Zdarmu; navíc
//  - před načtením rozhraní nastaví rozvržení (klasické = chaty svisle vlevo) podle volby v menu Zdarmy,
//  - do panelu Kontext přidá sekci „Limity“ s využitím API a modelů (data z proxy Zdarmy).
const { contextBridge, ipcRenderer } = require('electron');
// Preload běží v sandboxu (sandbox: true): require funguje jen pro 'electron', ne pro vlastní soubory. Dřív tu bylo
// načítání ./pollCadence → „module not found“ a celý preload od 0.15.28 nefungoval (výběr složky, rozvržení,
// panel Limity, přehrávač). Kopie src/pollCadence.js; shodu hlídá test/poll-cadence.js.
const ACTIVE_MS = 1000, IDLE_MS = 2500, HIDDEN_MS = 5000, LIMITS_MS = 8000;
const activeCadence = (hidden, running) => (hidden ? { poll: false, delay: HIDDEN_MS } : { poll: true, delay: running ? ACTIVE_MS : IDLE_MS });
const limitsCadence = (hidden) => ({ poll: !hidden, delay: LIMITS_MS });

let PREFS = {};
function applyPopupSize(w, h) {
  const width = Math.max(320, Math.min(1400, Number(w) || 640));
  const height = Math.max(260, Math.min(1100, Number(h) || 560));
  document.documentElement.style.setProperty('--czek-model-w', width + 'px');
  document.documentElement.style.setProperty('--czek-model-h', height + 'px');
  PREFS.modelPopupWidth = width;
  PREFS.modelPopupHeight = height;
}
try {
  const prefs = ipcRenderer.sendSync('oc:prefs') || {};
  PREFS = prefs;
  applyPopupSize(prefs.modelPopupWidth, prefs.modelPopupHeight);
  ipcRenderer.on('oc:popupSize', (_e, d) => { if (d) applyPopupSize(d.w, d.h); });
  if (typeof prefs.classicLayout === 'boolean') {
    const KEY = 'settings.v3'; // úložiště nastavení rozhraní OpenCode
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
    s.general = { ...(s.general || {}), newLayoutDesigns: !prefs.classicLayout, shouldDisplayTabsToast: false };
    localStorage.setItem(KEY, JSON.stringify(s));
  }
  // Jazyk rozhraní OpenCode podle Zdarmy (Nastavení → Obecné). Jen když si uživatel v OpenCode nevybral
  // jiný jazyk sám: přepíše se hodnota, kterou tam minule dala Zdarma, nebo prázdná.
  if (prefs.lang === 'cs' || prefs.lang === 'en') {
    const LK = 'opencode.global.dat:language';
    const MARK = 'zdarma.ocLanguage';
    let cur = null;
    try { cur = JSON.parse(localStorage.getItem(LK) || 'null')?.locale || null; } catch {}
    const ours = localStorage.getItem(MARK);
    if (!cur || cur === ours) {
      localStorage.setItem(LK, JSON.stringify({ locale: prefs.lang }));
      localStorage.setItem(MARK, prefs.lang);
    }
  }
} catch {}

contextBridge.exposeInMainWorld('__ZDARMA__', {
  /** @returns {Promise<string|string[]|null>} */
  pickFolder: (opts) => ipcRenderer.invoke('oc:pickFolder', { title: String(opts?.title || ''), multiple: !!opts?.multiple }),
  openSettings: (page) => ipcRenderer.invoke('oc:openSettings', page || 'providers'),
  openMonitor: () => ipcRenderer.invoke('oc:openMonitor'),
  setPopupSize: (w, h) => { applyPopupSize(w, h); return ipcRenderer.invoke('oc:setPopupSize', { w, h }); },
});

// ------------------------------------------------------------ Limity v panelu Kontext

const BAR_SEL = 'div.h-2.w-full.rounded-full.overflow-hidden.flex';
// texty přeložené hlavním procesem (Nastavení → Obecné → Jazyk)
const T = (k, v) => String((PREFS.strings || {})[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (v && v[x] != null ? String(v[x]) : m));
const LOC = PREFS.locale || 'cs-CZ';
const EN = PREFS.lang === 'en';
const nf = new Intl.NumberFormat(LOC);
const fmtNum = (n) => (n == null ? '–' : nf.format(n));
const fmtTok = (n) => (n >= 10000 ? `${nf.format(Math.round(n / 1000))}k` : nf.format(n || 0));
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const plural = (n, a, b, c) => (EN ? (n === 1 ? a : c) : n === 1 ? a : n >= 2 && n <= 4 ? b : c);
const reqWord = (n) => plural(n, T('oc.req1'), T('oc.req2'), T('oc.req5'));

function limitBar(used, limit) {
  const bar = el('div', 'h-2 w-full rounded-full bg-surface-base overflow-hidden flex');
  bar.setAttribute('data-zdarma-bar', '');
  const pct = Math.max(0, Math.min(100, (used / limit) * 100));
  const fill = el('div', 'h-full');
  fill.style.width = pct + '%';
  fill.style.backgroundColor = pct >= 90 ? '#e5534b' : pct >= 70 ? '#e8a33d' : '#3fb86b';
  bar.append(fill);
  return bar;
}

function rateText(rate) {
  if (!rate) return null;
  const parts = [];
  if (rate.reqRemaining != null) parts.push(T('oc.reqLeft', { n: fmtNum(rate.reqRemaining), of: rate.reqLimit != null ? T('oc.of', { n: fmtNum(rate.reqLimit) }) : '', reset: rate.reqReset ? T('oc.resetIn', { t: rate.reqReset }) : '' }));
  if (rate.tokRemaining != null) parts.push(T('oc.tokLeft', { n: fmtTok(rate.tokRemaining), of: rate.tokLimit != null ? T('oc.of', { n: fmtTok(rate.tokLimit) }) : '', reset: rate.tokReset ? T('oc.resetIn', { t: rate.tokReset }) : '' }));
  return parts.join(' · ') || null;
}

// Složka aktuálního projektu: OpenCode ji má v adrese jako base64url (/<složka>/session/…).
function currentSession() {
  const parts = location.pathname.split('/');
  const i = parts.indexOf('session');
  return i > 0 && parts[i + 1] ? parts[i + 1] : null;
}

// velká čísla tokenů čitelně: 54 161 366 → „54,2 M“
const fmtBig = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString(LOC, { maximumFractionDigits: 1 })} M` : fmtTok(n || 0));

// Součty v panelu Kontext: relace, projekt, dnes, vše (z databáze OpenCode) + dnešní pokusy přes OmniRoute.
function renderTotals(host, d) {
  const t = d.totals || {};
  const box = el('div', 'flex flex-col gap-1');
  box.setAttribute('data-czek-totals', '');
  const line = (label, x, extra) => {
    if (!x) return;
    const row = el('div', 'flex items-baseline justify-between gap-2');
    row.append(el('div', 'text-12-regular text-text-weak', label));
    const v = el('div', 'text-12-medium', T('oc.callsTokens', { c: fmtNum(x.calls), t: fmtBig(x.tokens.total) }) + (extra || ''));
    v.style.whiteSpace = 'nowrap';
    row.append(v);
    box.append(row);
  };
  const s = t.session;
  if (s) {
    const top = el('div', 'flex items-baseline justify-between gap-2');
    top.append(el('div', 'text-12-regular text-text-weak', T('oc.sessionTotals')));
    top.append(el('div', 'text-14-medium', T('oc.callsTokens', { c: fmtNum(s.calls), t: fmtBig(s.tokens.total) })));
    box.append(top);
    box.append(el('div', 'text-11-regular text-text-weaker', T('oc.tokDetail', { i: fmtBig(s.tokens.input), c: fmtBig(s.tokens.cacheRead), o: fmtBig(s.tokens.output), r: fmtBig(s.tokens.reasoning), u: fmtNum(s.userMessages) })));
  } else if (t.error) box.append(el('div', 'text-11-regular text-text-weaker', t.error));
  line(T('oc.projectTotals', { s: fmtNum(t.project?.sessions) }), t.project);
  line(T('oc.todayTotals'), t.today);
  line(T('oc.allTotals', { p: fmtNum(t.all?.projects) }), t.all);
  box.style.marginBottom = '10px';
  host.append(box);
  const o = d.omni;
  if (!o || o.error) { if (o?.error) host.append(el('div', 'text-11-regular text-text-weaker', o.error)); return; }
  const head = el('div', 'flex items-baseline justify-between gap-2');
  head.append(el('div', 'text-12-regular text-text-weak', T('oc.omniToday')));
  head.append(el('div', 'text-11-regular text-text-weak', T('oc.omniSummary', { n: fmtNum(o.calls), ok: fmtNum(o.ok), e: fmtNum(o.errors) })));
  host.append(head);
  for (const m of o.models.slice(0, 15)) {
    const row = el('div', 'flex items-baseline justify-between gap-2 text-11-regular');
    const name = el('div', 'text-text-weak truncate', `${m.key.slice(m.key.indexOf('/') + 1)} · ${m.providerName}`);
    name.style.minWidth = '0';
    const st = el('div', 'text-text-weaker', T('oc.omniModel', { n: fmtNum(m.calls), ok: fmtNum(m.ok), e: fmtNum(m.errors), t: fmtBig(m.tokens), s: m.calls ? (m.ms / m.calls / 1000).toFixed(1) : '0' }));
    st.style.whiteSpace = 'nowrap';
    if (m.errors) { st.title = m.lastError; if (m.errors >= m.calls) st.style.color = '#e5534b'; }
    row.append(name, st);
    host.append(row);
  }
  if (o.models.length > 15) host.append(el('div', 'text-11-regular text-text-weaker', T('oc.moreModels', { n: o.models.length - 15 })));
}

function currentDir() {
  const seg = location.pathname.split('/')[1];
  if (!seg) return null;
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(escape(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))));
  } catch { return null; }
}

function renderProject(host, d) {
  const p = d.project;
  const box = el('div', 'flex flex-col gap-1');
  const head = el('div', 'flex items-baseline justify-between gap-2');
  head.append(el('div', 'text-12-regular text-text-weak', T('oc.projectTokens')));
  head.append(el('div', 'text-11-regular text-text-weaker', p ? T('oc.since', { d: new Date(p.firstAt).toLocaleDateString(LOC) }) : ''));
  box.append(head);
  if (!p) {
    box.append(el('div', 'text-12-regular text-text-weaker', T('oc.noProject')));
  } else {
    const total = el('div', 'flex items-baseline justify-between gap-2');
    total.append(el('div', 'text-14-medium', T('oc.tokens', { n: fmtNum(p.tokensIn + p.tokensOut) })));
    total.append(el('div', 'text-11-regular text-text-weak', T('oc.inOut', { in: fmtTok(p.tokensIn), out: fmtTok(p.tokensOut), req: `${fmtNum(p.requests)} ${reqWord(p.requests)}` })));
    box.append(total);
    for (const m of p.models.slice(0, 10)) {
      const row = el('div', 'flex items-baseline justify-between gap-2 text-11-regular');
      const name = el('div', 'text-text-weak truncate', `${m.key.slice(m.key.indexOf('/') + 1)}${m.providerName ? ` · ${m.providerName}` : ''}`);
      name.style.minWidth = '0';
      const st = el('div', 'text-text-weaker', `${fmtTok(m.tokensIn + m.tokensOut)} ${T('oc.tok')} · ${fmtNum(m.requests)}×`);
      st.style.whiteSpace = 'nowrap';
      row.append(name, st);
      box.append(row);
    }
    if (p.models.length > 10) box.append(el('div', 'text-11-regular text-text-weaker', T('oc.moreModels', { n: p.models.length - 10 })));
  }
  if (d.allProjects?.projects > 1) {
    const a = d.allProjects;
    box.append(el('div', 'text-11-regular text-text-weaker', T('oc.allProjects', { n: fmtNum(a.tokensIn + a.tokensOut), p: a.projects })));
  }
  box.style.marginBottom = '10px';
  host.append(box);
}

function render(host, d) {
  host.replaceChildren();
  if (d.totals || d.omni) { renderTotals(host, d); return; }
  renderProject(host, d);
  const head = el('div', 'flex items-baseline justify-between');
  head.append(el('div', 'text-12-regular text-text-weak', T('oc.limits')), el('div', 'text-11-regular text-text-weaker', d.day ? T('oc.today') : ''));
  host.append(head);
  if (d.note) host.append(el('div', 'text-11-regular text-text-weaker', d.note));
  if (!d.providers?.length) { host.append(el('div', 'text-12-regular text-text-weaker', T('oc.noToday'))); return; }
  for (const p of d.providers) {
    const box = el('div', 'flex flex-col gap-1');
    box.style.padding = '6px 0';
    box.style.borderTop = '1px solid var(--border-weak-base, rgba(127,127,127,.18))';
    const top = el('div', 'flex items-baseline justify-between gap-2');
    top.append(el('div', 'text-12-medium', p.name));
    top.append(el('div', 'text-11-regular text-text-weak', `${fmtNum(p.requests)} ${reqWord(p.requests)}${p.errors ? T('oc.errors', { n: fmtNum(p.errors) }) : ''} · ${T('oc.tokens', { n: fmtTok(p.tokensIn + p.tokensOut) })}`));
    box.append(top);
    const rt = rateText(p.rate);
    if (p.rate?.reqLimit && p.rate.reqRemaining != null) box.append(limitBar(p.rate.reqLimit - p.rate.reqRemaining, p.rate.reqLimit));
    if (rt) box.append(el('div', 'text-11-regular text-text-weaker', rt));
    if (p.cooling) {
      const c = el('div', 'text-11-regular', T('oc.accountPause', { t: fmtTime(p.cooling.until), reason: p.cooling.reason }));
      c.style.color = '#e8a33d';
      box.append(c);
    }
    for (const m of p.models) {
      const row = el('div', 'flex items-baseline justify-between gap-2 text-11-regular');
      const name = el('div', 'text-text-weak truncate', m.key.slice(m.key.indexOf('/') + 1) + (m.tier && d.tierNames?.[m.tier] ? ` · ${d.tierNames[m.tier]}` : ''));
      name.style.minWidth = '0';
      let status = `${fmtNum(m.requests)}× · ${fmtTok(m.tokensIn + m.tokensOut)} ${T('oc.tok')}`;
      const st = el('div', 'text-text-weaker');
      st.style.whiteSpace = 'nowrap';
      if (m.cooling) { status += T('oc.pauseUntil', { t: fmtTime(m.cooling.until) }); st.style.color = '#e8a33d'; st.title = m.cooling.reason; }
      else if (m.lastError) { status += ` · ${m.lastError.kind}`; st.title = m.lastError.message; }
      st.textContent = status;
      row.append(name, st);
      box.append(row);
    }
    host.append(box);
  }
}

function initLimits() {
  let host = null;
  let timer = null;
  const refresh = async () => {
    if (!host || !host.isConnected) { clearInterval(timer); timer = null; host = null; return; }
    if (!limitsCadence(document.hidden).poll) return; // skryté okno: data se obnoví po návratu (visibilitychange)
    try { const d = await ipcRenderer.invoke('oc:limits', currentDir(), currentSession()); if (d && host) render(host, d); } catch {}
  };
  const check = () => {
    if (host && host.isConnected) return;
    const bar = [...document.querySelectorAll(BAR_SEL)].find((b) => !b.hasAttribute('data-zdarma-bar') && !b.closest('[data-zdarma-limits]'));
    const section = bar?.parentElement;
    if (!section) return;
    host = el('div', 'flex flex-col gap-2');
    host.setAttribute('data-zdarma-limits', '');
    host.style.marginTop = '16px';
    section.after(host);
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, limitsCadence(false).delay); // limity se mění pomalu → 8 s (dřív 3 s)
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; check(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

// ------------------------------------------------------------ Který model právě pracuje

// Štítek hned za výběrem modelu (tlačítko s názvem tierlistu, např. „High · 12 modelů“):
// za tierlistem je vidět skutečný model, který odpovídá (tečka pulzuje, když zrovna pracuje).
function initActive() {
  const style = document.createElement('style');
  style.textContent = '@keyframes zdarmaPulse{0%,100%{opacity:1}50%{opacity:.25}}[data-zdarma-active] .dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:middle}';
  document.head.append(style);
  let tick = 0;
  const update = async () => {
    let a = null;
    try { a = await ipcRenderer.invoke('oc:active'); } catch {}
    const names = a ? Object.values(a.tierNames || {}) : [];
    const btn = [...document.querySelectorAll('button')].find((b) => !b.closest('[data-zdarma-limits]') && (names.some((n) => b.textContent.trim().startsWith(`${n} ·`)) || /\bauto\/|OmniRoute|·\s*\d+×/i.test(b.textContent)));
    if (btn && !document.querySelector('[data-czek-keys-btn]')) {
      const kb = el('button', 'text-12-regular text-text-weak', '⚙ ' + T('oc.keysBtn'));
      kb.setAttribute('data-czek-keys-btn', '');
      kb.title = T('oc.keysBtnTitle');
      kb.style.cssText = 'display:inline-flex;align-items:center;padding:2px 8px;margin-left:6px;border-radius:5px;border:1px solid var(--border-weak-base,rgba(127,127,127,.28));background:transparent;cursor:pointer;white-space:nowrap';
      kb.onclick = (e) => { e.preventDefault(); e.stopPropagation(); ipcRenderer.invoke('oc:openSettings', 'providers'); };
      btn.after(kb);
    }
    let pill = document.querySelector('[data-zdarma-active]');
    if (!btn || !a) { pill?.remove(); return false; }
    if (!pill || pill.previousElementSibling !== btn) {
      pill?.remove();
      pill = el('span', 'text-12-regular text-text-weak');
      pill.setAttribute('data-zdarma-active', '');
      pill.style.cssText = 'display:inline-flex;align-items:center;white-space:nowrap;margin-left:6px;max-width:340px;overflow:hidden;text-overflow:ellipsis';
      btn.after(pill);
    }
    const c = a.current?.[0];
    const short = (k) => String(k || '').slice(String(k || '').indexOf('/') + 1);
    const dot = el('span', 'dot');
    let text;
    if (c) {
      dot.style.background = '#3fb86b';
      dot.style.animation = 'zdarmaPulse 1.2s ease-in-out infinite';
      text = `${short(c.model)} · ${c.providerName} · ${Math.round((a.now - c.since) / 1000)} s`;
      pill.title = T('oc.now', { model: c.model }) + (c.tier ? T('oc.nowTier', { t: a.tierNames[c.tier] || c.tier }) : '');
    } else if (a.last) {
      dot.style.background = a.last.ok ? '#8a8a8a' : '#e5534b';
      text = a.last.ok ? T('oc.lastShort', { model: short(a.last.model), prov: a.last.providerName }) : T('oc.error', { e: a.last.error || '' });
      pill.title = a.last.ok ? T('oc.last', { model: a.last.model, s: (a.last.ms / 1000).toFixed(1) }) : (a.last.error || '');
    } else if (!a.fullAuto) { pill.remove(); return false; }
    const parts = text ? [dot, document.createTextNode(text)] : [];
    if (a.fullAuto) {
      // plný automatický režim: agent se na nic neptá – musí být pořád vidět
      const warn = el('span');
      warn.textContent = T('oc.fullAuto');
      warn.title = T('oc.fullAutoTitle');
      warn.style.cssText = 'color:#fff;background:#c62828;font-weight:600;padding:1px 6px;border-radius:3px;margin-right:6px;letter-spacing:.02em';
      parts.unshift(warn);
    }
    pill.replaceChildren(...parts);
    tick++;
    return !!c; // běží volání → živý odpočet potřebuje rychlé obnovení
  };
  // Adaptivní polling oc:active (src/pollCadence.js): 1 s když model právě volá (živý čas), jinak 2,5 s; skryté
  // okno se neptá vůbec a po návratu se stav obnoví hned (visibilitychange). Šetří IPC – sebe-audit 23. 11.:
  // oc:active 22 417 opakovaných volání za 6 dní. Pill se při startu volání ukáže nejpozdeji do 2,5 s.
  const loop = async () => {
    if (!activeCadence(document.hidden, false).poll) { setTimeout(loop, activeCadence(true, false).delay); return; }
    let on = false;
    try { on = await update(); } catch {}
    setTimeout(loop, activeCadence(false, on).delay);
  };
  loop();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update().catch(() => {}); });
}

// ------------------------------------------------------------ Vylepšená vyskakovací nabídka modelů (velikost S/M/L/XL + tlačítko Klíče a poskytovatelé)

const POPUP_SIZES = [
  { id: 'S', w: 440, h: 380 },
  { id: 'M', w: 640, h: 560 },
  { id: 'L', w: 840, h: 680 },
  { id: 'XL', w: 1040, h: 780 },
];

function initModelPopupBar() {
  const decorate = () => {
    const scroll = document.querySelector('[data-slot="model-selector-scroll"]') || document.querySelector('div.w-72.h-80 [data-slot="list-scroll"]');
    const pop = scroll?.closest('[data-component="dropdown-menu-content"], div.w-72.h-80, [role="dialog"]');
    if (!pop || pop.querySelector('[data-czek-popup-bar]')) return;
    const bar = el('div');
    bar.setAttribute('data-czek-popup-bar', '');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-top:1px solid var(--border-weak-base,rgba(127,127,127,.22));font-size:11.5px;background:var(--surface-raised-base,rgba(127,127,127,.06))';
    const left = el('div');
    left.style.cssText = 'display:flex;gap:6px;align-items:center';
    const keysBtn = el('button', null, '⚙ ' + T('oc.keysBtn'));
    keysBtn.style.cssText = 'padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base,rgba(127,127,127,.3));background:transparent;cursor:pointer;font-weight:500';
    keysBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); ipcRenderer.invoke('oc:openSettings', 'providers'); };
    const modelsBtn = el('button', null, T('oc.unitedBtn'));
    modelsBtn.style.cssText = 'padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base,rgba(127,127,127,.3));background:transparent;cursor:pointer';
    modelsBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); ipcRenderer.invoke('oc:openSettings', 'models'); };
    left.append(keysBtn, modelsBtn);

    const right = el('div');
    right.style.cssText = 'display:flex;gap:3px;align-items:center';
    right.append(el('span', 'text-text-weaker', T('oc.popupSize') + ': '));
    const renderSizes = () => {
      right.querySelectorAll('button').forEach((b) => b.remove());
      for (const sz of POPUP_SIZES) {
        const active = Math.abs((PREFS.modelPopupWidth || 640) - sz.w) < 50;
        const b = el('button', null, sz.id);
        b.title = `${sz.w} × ${sz.h} px`;
        b.style.cssText = `padding:1px 6px;border-radius:3px;border:1px solid ${active ? '#3fb86b' : 'var(--border-weak-base,rgba(127,127,127,.25))'};background:${active ? 'rgba(63,184,107,.15)' : 'transparent'};cursor:pointer;font-weight:${active ? '600' : '400'}`;
        b.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          applyPopupSize(sz.w, sz.h);
          ipcRenderer.invoke('oc:setPopupSize', { w: sz.w, h: sz.h });
          renderSizes();
        };
        right.append(b);
      }
    };
    renderSizes();
    bar.append(left, right);
    pop.append(bar);
  };
  new MutationObserver(() => requestAnimationFrame(decorate)).observe(document.documentElement, { childList: true, subtree: true });
}

// ------------------------------------------------------------ Hlídání prázdného výběru modelu
// „No model results“ při prázdném hledání = web nemá žádné modely (instance vznikla, když OmniRoute ještě
// neodpovídal, 13. 11.). Nahlásí to appce, ta instanci / stránku znovu načte (main.js watchInstances).
function initNoModelsWatch() {
  let sent = 0;
  const check = () => {
    const empty = [...document.querySelectorAll('[data-slot="model-selector-scroll"], [role="dialog"]')].some((el) => /No model results/i.test(el.textContent || ''));
    if (!empty) return;
    const search = document.querySelector('[role="dialog"] input, [data-slot="model-selector-scroll"] input, input[placeholder*="Search models" i]');
    if (search && search.value) return; // prázdné kvůli hledání, ne kvůli chybě
    if (Date.now() - sent < 20000) return;
    sent = Date.now();
    ipcRenderer.send('oc:noModels');
  };
  new MutationObserver(() => check()).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

// ------------------------------------------------------------ Mini přehrávač nad promptem (vpravo)
// Uživatel 14. 11.: okénko nad promptovacím polem vpravo, objeví se po každém spuštění, tři videa, přepínání,
// zvuk zap/vyp (výchozí vypnutý). YouTube v rámečku (youtube-nocookie), ovládání přes IFrame API (postMessage).
const VIDEOS = [
  { id: 'YAgJ9XugGBo', title: 'Spinning fish' },
  { id: 'coaN2VBNgYA', title: 'chip' },
  { id: 'mFZ7Rcx80X4', title: 'niche deep house' },
];
function initVideoDock() {
  if (PREFS.videoDock === false) return;
  let idx = 0;
  let muted = true;
  let hidden = false;
  const W = 256;
  const wrap = el('div');
  wrap.setAttribute('data-czek-video', '');
  wrap.style.cssText = `position:fixed;z-index:40;width:${W}px;border-radius:8px;overflow:hidden;background:#000;border:1px solid var(--border-weak-base,rgba(127,127,127,.3));box-shadow:0 6px 20px rgba(0,0,0,.35);display:none`;
  const frame = document.createElement('iframe');
  frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  frame.setAttribute('title', 'video');
  frame.style.cssText = `display:block;width:${W}px;height:${Math.round(W * 9 / 16)}px;border:0;background:#000`;
  const bar = el('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:4px;padding:3px 6px;background:var(--background-base,#141414);font-size:12px;color:var(--text-weak,#aaa)';
  const btn = (label, title, fn) => {
    const b = el('button', null, label);
    b.title = title;
    b.style.cssText = 'background:transparent;border:0;color:inherit;cursor:pointer;padding:1px 5px;border-radius:4px;font-size:12px;line-height:18px';
    b.onmouseenter = () => { b.style.background = 'rgba(127,127,127,.18)'; };
    b.onmouseleave = () => { b.style.background = 'transparent'; };
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
    return b;
  };
  const name = el('span');
  name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center';
  const src = () => `https://www.youtube-nocookie.com/embed/${VIDEOS[idx].id}?autoplay=1&mute=${muted ? 1 : 0}&loop=1&playlist=${VIDEOS[idx].id}&controls=0&rel=0&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  const cmd = (func) => { try { frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*'); } catch {} };
  const sound = btn('', '', () => { muted = !muted; cmd(muted ? 'mute' : 'unMute'); if (!muted) cmd('playVideo'); paint(); });
  const paint = () => {
    name.textContent = `${idx + 1}/${VIDEOS.length} · ${VIDEOS[idx].title}`;
    sound.textContent = muted ? '🔇' : '🔊';
    sound.title = muted ? T('oc.videoUnmute') : T('oc.videoMute');
    wrap.dataset.idx = String(idx);
    wrap.dataset.muted = muted ? '1' : '0';
  };
  const go = (d) => { idx = (idx + d + VIDEOS.length) % VIDEOS.length; frame.src = src(); paint(); };
  bar.append(btn('◀', T('oc.videoPrev'), () => go(-1)), name, btn('▶', T('oc.videoNext'), () => go(1)), sound, btn('✕', T('oc.videoHide'), () => { hidden = true; frame.src = 'about:blank'; wrap.style.display = 'none'; }));
  wrap.append(frame, bar);
  document.body.append(wrap);
  // src až po „load“ okna: rámeček s adresou nastavenou dřív je součástí načítání stránky, takže když YouTube neodpovídá
  // (školní síť zahazuje pakety, skryté okno), OpenCode „dokončí načtení“ až po ~5 min timeoutu a vše, co na to čeká
  // (hlídač instance…), se zdrží (26. 11.: did-finish-load za 4 min 47 s, ERR_TIMED_OUT youtube-nocookie.com).
  const start = () => { if (!hidden) frame.src = src(); };
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });
  paint();
  // poloha: nad pravým okrajem pole pro prompt; bez pole (úvodní obrazovka) schované
  const place = () => {
    if (hidden) return;
    const shell = document.querySelector('[data-dock-surface="shell"]') || document.querySelector('textarea')?.closest('form');
    const r = shell?.getBoundingClientRect();
    if (!r || !r.width) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    wrap.style.left = `${Math.max(8, r.right - W)}px`;
    wrap.style.top = `${Math.max(8, r.top - wrap.offsetHeight - 8)}px`;
  };
  setInterval(place, 400);
  window.addEventListener('resize', place);
}

// ------------------------------------------------------------ Nová verze na ploše → lišta s restartem
function initUpgradeBar() {
  let shown = '';
  const check = async () => {
    let u = null;
    try { u = await ipcRenderer.invoke('app:update'); } catch {}
    const old = document.querySelector('[data-czek-upgrade]');
    if (!u) { old?.remove(); shown = ''; return; }
    if (shown === u.version && old) return;
    old?.remove();
    shown = u.version;
    const bar = el('div');
    bar.setAttribute('data-czek-upgrade', '');
    bar.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:10px;padding:6px 12px;border-radius:8px;background:#1f6f43;color:#fff;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.35)';
    bar.append(el('span', null, u.dev ? T('oc.devUpgradeReady', { v: u.version, s: u.subject }) : T('oc.upgradeReady', { v: u.version, cur: u.current })));
    const go = el('button', null, T('oc.upgradeGo'));
    go.title = T(u.dev ? 'oc.devUpgradeGoTitle' : 'oc.upgradeGoTitle');
    go.style.cssText = 'background:#fff;color:#1f6f43;border:0;border-radius:5px;padding:3px 10px;font-weight:600;cursor:pointer';
    go.onclick = async () => { go.disabled = true; go.textContent = T('oc.upgradeBusy'); const ok = await ipcRenderer.invoke('app:upgrade').catch(() => false); if (!ok) { go.disabled = false; go.textContent = T('oc.upgradeGo'); } };
    const later = el('button', null, '✕');
    later.title = T('oc.upgradeLater');
    later.style.cssText = 'background:transparent;color:#fff;border:0;cursor:pointer;font-size:13px';
    later.onclick = () => bar.remove();
    bar.append(go, later);
    document.body.append(bar);
  };
  check();
  setInterval(() => { if (!document.querySelector('[data-czek-upgrade]') || shown) check(); }, 60000);
}

// ------------------------------------------------------------ Presety chatu (uživatel 26. 11.)

// Nová relace (draft /new-session): místo loga OpenCode výběr presetu (src/presets). Preset = primární agent OpenCode
// (src/opencode.js applyPresets), plán a povinné skills mu do promptu přidá czek-guard. Klik přepne NATIVNÍ výběr agenta
// v liště promptu (stejné menu jako pod tlačítkem „Build“), takže stav drží OpenCode a ruční přepnutí se tu srovná.
// Vzhled = tokeny OpenCode (Inter, tenký ring jako u pole promptu); kompaktní režim pro nízká okna (školní 1366×768 / 125 %).
const PRESET_CSS = `
[data-czek-presets]{font-family:inherit;color:var(--text-base,#a0a0a0)}
[data-czek-presets] .cp-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 2px 10px}
[data-czek-presets] .cp-title{font-size:14px;line-height:20px;font-weight:500;color:var(--text-strong,#ededed)}
[data-czek-presets] .cp-hint{font-size:12px;line-height:16px;color:var(--text-base,#a0a0a0)}
[data-czek-presets] .cp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:4px}
[data-czek-presets] .cp-opt{all:unset;box-sizing:border-box;display:grid;grid-template-columns:8px auto minmax(0,1fr);align-items:center;column-gap:10px;height:36px;padding:0 12px;border-radius:8px;cursor:pointer;
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#888) 11%,transparent);transition:background-color .16s cubic-bezier(.25,1,.5,1),box-shadow .16s cubic-bezier(.25,1,.5,1)}
[data-czek-presets] .cp-opt:hover{background:var(--surface-base-hover,rgba(127,127,127,.08));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#888) 22%,transparent)}
[data-czek-presets] .cp-opt:active{background:color-mix(in srgb,var(--c) 18%,transparent)}
[data-czek-presets] .cp-opt[aria-checked="true"]{background:color-mix(in srgb,var(--c) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 75%,transparent)}
[data-czek-presets] .cp-opt:focus-visible{outline:2px solid var(--c);outline-offset:2px}
[data-czek-presets][aria-busy="true"] .cp-opt{cursor:progress}
[data-czek-presets] .cp-mark{width:8px;height:8px;border-radius:2px;background:var(--c)}
[data-czek-presets] .cp-name{font-size:13px;line-height:18px;font-weight:500;color:var(--text-strong,#ededed);white-space:nowrap}
[data-czek-presets] .cp-desc{font-size:12px;line-height:16px;color:var(--text-base,#a0a0a0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-czek-presets] .cp-status{margin:10px 2px 0;min-height:16px;font-size:12px;line-height:16px;color:var(--text-base,#a0a0a0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-czek-presets] .cp-status code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;color:var(--text-strong,#ededed)}
[data-czek-presets] .cp-status.cp-fail{color:var(--text-strong,#ededed)}
[data-czek-presets] .cp-add{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#888) 11%,transparent)}
[data-czek-presets] .cp-add .cp-mark{background:transparent;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#888) 45%,transparent)}
[data-czek-presets] .cp-add .cp-name{font-weight:400;color:var(--text-base,#a0a0a0)}
[data-czek-presets] .cp-add:hover .cp-name{color:var(--text-strong,#ededed)}
@media (max-height:720px){[data-czek-presets] .cp-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}[data-czek-presets] .cp-desc,[data-czek-presets] .cp-hint{display:none}[data-czek-presets] .cp-opt{grid-template-columns:8px minmax(0,1fr);height:32px}[data-czek-presets] .cp-name{overflow:hidden;text-overflow:ellipsis}}
@media (prefers-reduced-motion:reduce){[data-czek-presets] .cp-opt{transition:none}}`;

function initPresetPicker() {
  const list = Array.isArray(PREFS.presets) ? PREFS.presets.filter((p) => p && typeof p.agent === 'string') : [];
  if (list.length < 2) return; // presety vypnuté nebo bez plánů → OpenCode beze změny
  const style = document.createElement('style');
  style.textContent = PRESET_CSS;
  document.head.append(style);
  const known = new Set([...list.map((p) => p.agent), 'build', 'plan']);
  let host = null; let logo = null; let busy = false; let failUntil = 0;
  const isNew = () => location.pathname.includes('new-session');
  const promptBox = () => document.querySelector('[aria-label="Prompt"]') || document.querySelector('form [contenteditable="true"]');
  // tlačítko agenta v liště promptu: aria-label je podle jazyka, poznáme ho podle textu = jméno aktuálního agenta
  const trigger = () => [...document.querySelectorAll('form button[aria-haspopup]')].find((b) => known.has(b.textContent.trim().toLowerCase()));
  const current = () => trigger()?.textContent.trim().toLowerCase() || null;
  const ptr = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true };
  const press = (e) => { e.dispatchEvent(new PointerEvent('pointerdown', ptr)); e.dispatchEvent(new MouseEvent('mousedown', ptr)); e.dispatchEvent(new PointerEvent('pointerup', ptr)); e.dispatchEvent(new MouseEvent('mouseup', ptr)); e.click(); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const focusPrompt = () => { try { promptBox()?.focus(); } catch {} };

  // zapisuje jen při změně (stavový řádek je mutace DOM → observer → update by jinak běžel každý snímek)
  let shown = '';
  function update() {
    if (!host) return;
    const cur = current() || 'build';
    for (const b of host.querySelectorAll('.cp-opt[data-agent]')) { const v = String(b.dataset.agent === cur); if (b.getAttribute('aria-checked') !== v) b.setAttribute('aria-checked', v); }
    const failing = Date.now() < failUntil;
    const want = failing ? 'fail' : `active:${cur}`;
    if (want === shown) return;
    shown = want;
    const status = host.querySelector('.cp-status');
    status.classList.toggle('cp-fail', failing);
    if (failing) { status.textContent = T('oc.presetFail'); return; }
    const p = list.find((x) => x.agent === cur) || { agent: cur, skills: 0 };
    status.replaceChildren(`${T('oc.presetActive')} `, el('code', '', p.agent), ` · ${p.skills ? T('oc.presetSkills', { n: p.skills }) : T('oc.presetAuto')}`);
  }
  const fail = () => { failUntil = Date.now() + 8000; update(); setTimeout(update, 8100); };

  // Položka menu agenta (Kobalte) se vybere až po najetí ukazatelem: pointermove/enter, pak stisk (ověřeno 26. 11.).
  async function choose(agent) {
    if (busy) return;
    if (current() === agent) { failUntil = 0; update(); focusPrompt(); return; }
    // po (znovu)načtení okna OpenCode tlačítko agenta v liště promptu chvíli chybí → počkat (nejvýš 4 s)
    let t = trigger();
    for (let i = 0; i < 40 && !t; i++) { await wait(100); t = trigger(); }
    if (!t) { fail(); return; }
    busy = true; host?.setAttribute('aria-busy', 'true');
    try {
      t.dispatchEvent(new PointerEvent('pointerdown', ptr)); t.click();
      let items = [];
      for (let i = 0; i < 25 && !items.length; i++) { await wait(40); items = [...document.querySelectorAll('[role="menuitemradio"]')]; }
      const it = items.find((x) => x.textContent.trim().toLowerCase() === agent);
      if (!it) { items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); fail(); return; }
      it.dispatchEvent(new PointerEvent('pointermove', ptr));
      it.dispatchEvent(new PointerEvent('pointerenter', { ...ptr, bubbles: false }));
      await wait(30);
      press(it);
      for (let i = 0; i < 20 && current() !== agent; i++) await wait(25);
      if (current() === agent) failUntil = 0; else fail();
    } finally {
      busy = false; host?.removeAttribute('aria-busy'); update(); focusPrompt();
    }
  }

  function render() {
    const h = el('div');
    h.setAttribute('data-czek-presets', '');
    const head = el('div', 'cp-head');
    head.append(el('div', 'cp-title', T('oc.presetTitle')), el('div', 'cp-hint', T('oc.presetHint')));
    const grid = el('div', 'cp-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', T('oc.presetGroup'));
    const status = el('div', 'cp-status');
    status.setAttribute('aria-live', 'polite');
    for (const p of list) {
      const b = el('button', 'cp-opt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.agent = p.agent;
      b.style.setProperty('--c', /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#8A8F98');
      b.title = p.desc || '';
      b.append(el('span', 'cp-mark'), el('span', 'cp-name', p.name || p.agent), el('span', 'cp-desc', p.tag || ''));
      b.addEventListener('click', () => choose(p.agent));
      // náhled: plný popis ve stavovém řádku při najetí / fokusu
      const peek = () => { if (!busy && Date.now() >= failUntil) { status.classList.remove('cp-fail'); status.textContent = p.desc || p.name; shown = 'peek'; } };
      b.addEventListener('mouseenter', peek);
      b.addEventListener('focus', peek);
      b.addEventListener('mouseleave', update);
      b.addEventListener('blur', update);
      b.addEventListener('keydown', (e) => {
        const all = [...grid.querySelectorAll('.cp-opt')];
        const i = all.indexOf(b);
        const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
        if (to == null) return;
        e.preventDefault();
        all[(to + all.length) % all.length].focus();
      });
      grid.append(b);
    }
    // vlastní presety: editor (dialog) – nový preset, úprava, smazání
    const add = el('button', 'cp-opt cp-add');
    add.type = 'button';
    add.style.setProperty('--c', 'var(--text-strong,#ededed)');
    add.title = T('oc.cpAddTitle');
    add.append(el('span', 'cp-mark'), el('span', 'cp-name', T('oc.cpAdd')), el('span', 'cp-desc', ''));
    add.addEventListener('click', () => openPresetEditor());
    add.addEventListener('mouseenter', () => { status.classList.remove('cp-fail'); status.textContent = T('oc.cpAddTitle'); shown = 'peek'; });
    add.addEventListener('mouseleave', update);
    grid.append(add);
    h.append(head, grid, status);
    return h;
  }

  const check = () => {
    if (!isNew()) {
      if (host) { host.remove(); host = null; }
      if (logo) { logo.style.display = ''; logo = null; }
      return;
    }
    const form = promptBox()?.closest('form');
    if (!form) return;
    let col = form;
    while (col && !String(col.className || '').includes('max-w-')) col = col.parentElement;
    col = col || form.parentElement;
    if (!host || !host.isConnected) {
      host = render();
      shown = '';
      const lg = [...col.children].find((c) => !c.contains(form) && (c.matches('svg') || c.querySelector('svg')));
      if (lg) { lg.style.display = 'none'; logo = lg; }
      col.insertBefore(host, col.firstChild);
    }
    update();
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; if (!busy) check(); });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  check();
}

// ------------------------------------------------------------ Editor vlastních presetů (uživatel 26. 11.)
// Nativní <dialog> (Esc zavře, fokus uvnitř). Uložení → main zapíše agenta my-… do konfigurace OpenCode a po restartu
// serveru načte okno znovu, takže výběr ukáže nový preset. Plán může napsat model tieru Max (presets:generate).
const CPE_CSS = `
dialog[data-czek-cpe]{box-sizing:border-box;position:fixed;inset:0;margin:auto;height:fit-content;width:min(680px,94vw);max-height:88vh;padding:0;border:0;border-radius:10px;background:var(--surface-raised-base,#161616);color:var(--text-base,#a0a0a0);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;box-shadow:0 0 0 .5px color-mix(in srgb,var(--text-strong,#ededed) 18%,transparent),0 24px 60px rgba(0,0,0,.45)}
dialog[data-czek-cpe]::backdrop{background:rgba(0,0,0,.45)}
dialog[data-czek-cpe] form{display:flex;flex-direction:column;max-height:88vh}
dialog[data-czek-cpe] .ce-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px 10px}
dialog[data-czek-cpe] .ce-title{font-size:14px;font-weight:500;color:var(--text-strong,#ededed)}
dialog[data-czek-cpe] .ce-body{overflow:auto;padding:4px 18px 8px;display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}
dialog[data-czek-cpe] .ce-full{grid-column:1/-1}
dialog[data-czek-cpe] label.ce-f{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--text-base,#a0a0a0)}
dialog[data-czek-cpe] input[type=text],dialog[data-czek-cpe] select,dialog[data-czek-cpe] textarea{all:unset;box-sizing:border-box;width:100%;padding:7px 10px;border-radius:8px;background:color-mix(in srgb,var(--text-strong,#ededed) 4%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#ededed) 14%,transparent);color:var(--text-strong,#ededed);font:13px/1.45 inherit}
dialog[data-czek-cpe] select{cursor:pointer}
dialog[data-czek-cpe] textarea{min-height:190px;white-space:pre-wrap;font:12px/1.5 ui-monospace,"Cascadia Mono",Consolas,monospace;resize:vertical}
dialog[data-czek-cpe] input:focus-visible,dialog[data-czek-cpe] select:focus-visible,dialog[data-czek-cpe] textarea:focus-visible{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#ededed) 55%,transparent)}
dialog[data-czek-cpe] .ce-colors{display:flex;gap:8px;flex-wrap:wrap;padding:3px 1px}
dialog[data-czek-cpe] .ce-sw{all:unset;width:22px;height:22px;border-radius:5px;background:var(--c);cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
dialog[data-czek-cpe] .ce-sw[aria-checked=true]{box-shadow:0 0 0 2px var(--surface-raised-base,#161616),0 0 0 4px var(--c)}
dialog[data-czek-cpe] .ce-sw:focus-visible{outline:2px solid var(--text-strong,#ededed);outline-offset:3px}
dialog[data-czek-cpe] .ce-skills{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;max-height:170px;overflow:auto;padding:6px 8px;border-radius:8px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#ededed) 10%,transparent)}
dialog[data-czek-cpe] .ce-skill{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;padding:3px 2px;cursor:pointer;min-width:0}
dialog[data-czek-cpe] .ce-skill code{font:12px ui-monospace,"Cascadia Mono",Consolas,monospace;color:var(--text-strong,#ededed);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
dialog[data-czek-cpe] input[type=checkbox]{accent-color:#0F8584;margin:0}
dialog[data-czek-cpe] .ce-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
dialog[data-czek-cpe] .ce-hint{font-size:12px;color:var(--text-base,#a0a0a0)}
dialog[data-czek-cpe] .ce-foot{display:flex;align-items:center;gap:8px;padding:12px 18px 14px;box-shadow:0 -1px 0 color-mix(in srgb,var(--text-strong,#ededed) 8%,transparent)}
dialog[data-czek-cpe] .ce-status{flex:1;min-width:0;font-size:12px;color:var(--text-base,#a0a0a0)}
dialog[data-czek-cpe] .ce-status.ce-err{color:var(--text-strong,#ededed)}
dialog[data-czek-cpe] button.ce-b{all:unset;box-sizing:border-box;height:30px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:500;cursor:pointer;color:var(--text-strong,#ededed);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#ededed) 16%,transparent);transition:background-color .16s cubic-bezier(.25,1,.5,1)}
dialog[data-czek-cpe] button.ce-b:hover{background:color-mix(in srgb,var(--text-strong,#ededed) 7%,transparent)}
dialog[data-czek-cpe] button.ce-b:focus-visible{outline:2px solid var(--text-strong,#ededed);outline-offset:2px}
dialog[data-czek-cpe] button.ce-primary{background:var(--text-strong,#ededed);color:var(--surface-raised-base,#161616);box-shadow:none}
dialog[data-czek-cpe] button.ce-primary:hover{background:color-mix(in srgb,var(--text-strong,#ededed) 86%,transparent)}
dialog[data-czek-cpe] button.ce-b[disabled]{opacity:.55;cursor:progress}
dialog[data-czek-cpe] button.ce-x{all:unset;width:26px;height:26px;border-radius:6px;display:grid;place-items:center;cursor:pointer;color:var(--text-base,#a0a0a0)}
dialog[data-czek-cpe] button.ce-x:hover{color:var(--text-strong,#ededed);background:color-mix(in srgb,var(--text-strong,#ededed) 7%,transparent)}
@media (max-width:620px){dialog[data-czek-cpe] .ce-body,dialog[data-czek-cpe] .ce-skills{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){dialog[data-czek-cpe] *{transition:none}}`;

async function openPresetEditor() {
  const data = await ipcRenderer.invoke('presets:custom').catch(() => null);
  if (!data) return;
  if (!document.querySelector('style[data-czek-cpe]')) { const st = document.createElement('style'); st.setAttribute('data-czek-cpe', ''); st.textContent = CPE_CSS; document.head.append(st); }
  document.querySelector('dialog[data-czek-cpe]')?.remove();
  const dlg = el('dialog');
  dlg.setAttribute('data-czek-cpe', '');
  dlg.setAttribute('aria-labelledby', 'czek-cpe-title');
  const form = el('form');
  form.method = 'dialog';
  const head = el('div', 'ce-head');
  const title = el('div', 'ce-title', T('oc.cpTitle'));
  title.id = 'czek-cpe-title';
  const x = el('button', 'ce-x', '✕');
  x.type = 'button'; x.title = T('oc.cpClose'); x.setAttribute('aria-label', T('oc.cpClose'));
  x.addEventListener('click', () => dlg.close());
  head.append(title, x);
  const body = el('div', 'ce-body');
  const field = (labelText, input, full) => { const l = el('label', 'ce-f' + (full ? ' ce-full' : '')); l.append(el('span', null, labelText), input); body.append(l); return input; };
  const input = (max) => { const i = el('input'); i.type = 'text'; i.maxLength = max; i.spellcheck = false; return i; };
  const pick = el('select');
  field(T('oc.cpPick'), pick, true);
  const name = field(T('oc.cpName'), input(40));
  const tag = field(T('oc.cpTag'), input(40));
  const desc = field(T('oc.cpDesc'), input(160), true);
  // barva
  const colorWrap = el('div', 'ce-f ce-full');
  colorWrap.append(el('span', null, T('oc.cpColor')));
  const colors = el('div', 'ce-colors');
  colors.setAttribute('role', 'radiogroup');
  colors.setAttribute('aria-label', T('oc.cpColor'));
  let color = data.colors[0];
  const sws = data.colors.map((c) => {
    const b = el('button', 'ce-sw');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', c); b.style.setProperty('--c', c);
    b.addEventListener('click', () => { color = c; paintColors(); });
    colors.append(b); return b;
  });
  const paintColors = () => sws.forEach((b, i) => b.setAttribute('aria-checked', String(data.colors[i] === color)));
  colorWrap.append(colors);
  body.append(colorWrap);
  // skills
  const skWrap = el('div', 'ce-f ce-full');
  skWrap.append(el('span', null, T('oc.cpSkills')));
  const skBox = el('div', 'ce-skills');
  const checks = new Map();
  for (const s of data.skills) {
    const l = el('label', 'ce-skill');
    l.title = s.desc || s.name;
    const c = el('input'); c.type = 'checkbox'; c.value = s.name;
    l.append(c, el('code', null, s.name));
    skBox.append(l); checks.set(s.name, c);
  }
  skWrap.append(skBox);
  body.append(skWrap);
  // plán
  const plan = el('textarea');
  plan.placeholder = T('oc.cpPlanPh'); plan.spellcheck = false; plan.rows = 12;
  field(T('oc.cpPlan'), plan, true);
  const genRow = el('div', 'ce-row ce-full');
  const gen = el('button', 'ce-b', T('oc.cpGen'));
  gen.type = 'button';
  genRow.append(gen, el('span', 'ce-hint', T('oc.cpGenHint')));
  body.append(genRow);
  // patička
  const foot = el('div', 'ce-foot');
  const status = el('div', 'ce-status');
  status.setAttribute('aria-live', 'polite');
  const del = el('button', 'ce-b', T('oc.cpDelete')); del.type = 'button';
  const close = el('button', 'ce-b', T('oc.cpClose')); close.type = 'button';
  const save = el('button', 'ce-b ce-primary', T('oc.cpSave')); save.type = 'submit';
  foot.append(status, del, close, save);
  form.append(head, body, foot);
  dlg.append(form);
  document.body.append(dlg);

  let list = data.presets || [];
  const say = (t, err) => { status.textContent = t || ''; status.classList.toggle('ce-err', !!err); };
  const fillPick = (sel) => {
    pick.replaceChildren();
    const o = el('option', null, T('oc.cpNew')); o.value = ''; pick.append(o);
    for (const p of list) { const op = el('option', null, p.name); op.value = p.id; pick.append(op); }
    pick.value = sel || '';
  };
  const load = (id) => {
    const p = list.find((q) => q.id === id) || null;
    name.value = p?.name || ''; tag.value = p?.tag || ''; desc.value = p?.desc || ''; plan.value = p?.plan || '';
    color = p?.color && data.colors.includes(p.color) ? p.color : data.colors[list.length % data.colors.length];
    for (const [n, c] of checks) c.checked = !!p?.skills?.includes(n);
    del.hidden = !p; paintColors(); say('');
  };
  const value = () => ({ id: pick.value || null, name: name.value, tag: tag.value, desc: desc.value, color, skills: [...checks].filter(([, c]) => c.checked).map(([n]) => n), plan: plan.value });
  pick.addEventListener('change', () => load(pick.value));
  close.addEventListener('click', () => dlg.close());
  gen.addEventListener('click', async () => {
    gen.disabled = true; say(T('oc.cpGenBusy'));
    const r = await ipcRenderer.invoke('presets:generate', value()).catch((e) => ({ ok: false, error: e.message }));
    gen.disabled = false;
    if (r?.ok) { plan.value = r.plan; say(T('oc.cpGenDone', { model: r.model || 'Max' })); } else say(r?.error || '?', true);
  });
  del.addEventListener('click', async () => {
    if (!pick.value) return;
    const r = await ipcRenderer.invoke('presets:delete', pick.value).catch(() => null);
    if (!r?.ok) return;
    list = list.filter((p) => p.id !== pick.value);
    fillPick(''); load(''); say(T('oc.cpDeleted'));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    const v = value();
    const r = await ipcRenderer.invoke('presets:save', v).catch((err) => ({ ok: false, error: err.message }));
    save.disabled = false;
    if (!r?.ok) { say(r?.error || '?', true); return; }
    const rec = { ...v, id: r.id };
    list = list.some((p) => p.id === r.id) ? list.map((p) => (p.id === r.id ? rec : p)) : [...list, rec];
    fillPick(r.id); del.hidden = false; say(T('oc.cpSaved'));
  });
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
  fillPick('');
  load('');
  dlg.showModal();
  name.focus();
}

// ------------------------------------------------------------ Pravidla učitele (uživatel 26. 11.)
// Přepínač nad levým okrajem promptu: Agentic Starter Kit učitele pro TENTO chat zapnout / vypnout (vypnuto = guard
// pravidla kitu vyřízne z promptu a model je ignoruje i zpětně). Rozepsaný chat (bez id) → stav převezme 1. zpráva.
const TEACHER_CSS = `[data-czek-teacher]{position:fixed;z-index:40;display:none;align-items:center;gap:8px;height:26px;padding:0 10px 0 8px;border:0;border-radius:7px;background:var(--surface-raised-base,#1c1c1c);box-shadow:0 0 0 .5px color-mix(in srgb,var(--text-strong,#ededed) 16%,transparent);color:var(--text-base,#a0a0a0);font:500 12px/1 Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer;transition:color .16s cubic-bezier(.22,1,.36,1)}
[data-czek-teacher]:hover{color:var(--text-strong,#ededed)}
[data-czek-teacher]:focus-visible{outline:2px solid var(--text-strong,#ededed);outline-offset:2px}
[data-czek-teacher] .ct-track{position:relative;flex:none;width:22px;height:12px;border-radius:6px;background:color-mix(in srgb,var(--text-strong,#ededed) 22%,transparent);transition:background-color .16s}
[data-czek-teacher] .ct-knob{position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:var(--text-strong,#ededed);transition:transform .16s cubic-bezier(.22,1,.36,1)}
[data-czek-teacher][aria-checked="true"]{color:var(--text-strong,#ededed)}
[data-czek-teacher][aria-checked="true"] .ct-track{background:#0F8584}
[data-czek-teacher][aria-checked="true"] .ct-knob{transform:translateX(10px);background:#fff}
[data-czek-teacher].ct-inline{position:static;margin-left:auto;align-self:center;flex:none}
@media (prefers-reduced-motion:reduce){[data-czek-teacher],[data-czek-teacher] *{transition:none}}`;

function initTeacherSwitch() {
  if (PREFS.teacher !== true) return;
  const style = document.createElement('style');
  style.textContent = TEACHER_CSS;
  document.head.append(style);
  const btn = el('button');
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('data-czek-teacher', '');
  btn.title = T('oc.teacherTitle');
  const track = el('span', 'ct-track');
  track.append(el('span', 'ct-knob'));
  const label = el('span', 'ct-label');
  btn.append(track, label);
  document.body.append(btn);
  let sid = null; let draft = null; let on = false; let lastPath = null; let busy = false;
  const sidOf = () => { const m = location.pathname.match(/\/session\/([\w-]{4,80})/); return m ? m[1] : null; };
  const render = () => {
    btn.setAttribute('aria-checked', String(on));
    const t = `${T('oc.teacherLabel')}: ${on ? T('oc.teacherOn') : T('oc.teacherOff')}`;
    if (label.textContent !== t) label.textContent = t;
  };
  const refresh = async () => {
    const p = location.pathname;
    if (p === lastPath || busy) return;
    const wasDraft = (lastPath || '').includes('new-session');
    lastPath = p;
    const id = sidOf();
    busy = true;
    try {
      // rozepsaný chat se právě stal relací → přepnutí z rozepsaného chatu patří jí
      if (id && wasDraft && draft !== null) {
        const r = await ipcRenderer.invoke('teacher:set', { sid: id, on: draft, adopt: true }).catch(() => null);
        draft = null; sid = id;
        if (r) { on = r.on; render(); }
        return;
      }
      sid = id;
      if (!id) draft = null;
      const r = await ipcRenderer.invoke('teacher:get', id).catch(() => null);
      if (r) { on = r.on; render(); }
    } finally { busy = false; }
  };
  btn.addEventListener('click', async () => {
    const r = await ipcRenderer.invoke('teacher:set', { sid, on: !on }).catch(() => null);
    if (!r) return;
    if (!sid) draft = r.on;
    on = r.on;
    render();
  });
  const place = () => {
    refresh();
    // nová relace s výběrem presetu (sedí přímo nad promptem): přepínač do hlavičky výběru, jinak plovoucí nad promptem
    const head = document.querySelector('[data-czek-presets] .cp-head');
    if (head && head.getBoundingClientRect().width > 0) {
      if (btn.parentElement !== head) { head.append(btn); btn.classList.add('ct-inline'); btn.style.left = ''; btn.style.top = ''; }
      if (btn.style.display !== 'inline-flex') btn.style.display = 'inline-flex';
      return;
    }
    if (btn.parentElement !== document.body) { document.body.append(btn); btn.classList.remove('ct-inline'); }
    // pole promptu: v otevřené relaci „shell“ docku, v nové relaci (draft) formulář s polem Prompt
    const pb = document.querySelector('[aria-label="Prompt"]') || document.querySelector('form [contenteditable="true"]') || document.querySelector('textarea');
    const r = [document.querySelector('[data-dock-surface="shell"]'), pb?.closest('form'), pb].map((e) => e?.getBoundingClientRect()).find((b) => b && b.width > 0);
    if (!r) { if (btn.style.display !== 'none') btn.style.display = 'none'; return; }
    btn.style.display = 'inline-flex';
    btn.style.left = `${Math.round(r.left)}px`;
    btn.style.top = `${Math.round(Math.max(8, r.top - btn.offsetHeight - 8))}px`;
  };
  render();
  setInterval(place, 400);
  window.addEventListener('resize', place);
}

// ------------------------------------------------------------ Vložení textu z VS Code (rozšíření czek-ai, src/webBridge.js)
// „Zeptat se na výběr“, „Opravit chybu“ … ve VS Code → text do pole promptu (jen stránka se stejnou složkou projektu).
function initVscodeInsert() {
  const dirOfPage = () => {
    const seg = location.pathname.split('/').filter(Boolean);
    for (const s of seg) {
      if (s.length < 8 || !/^[A-Za-z0-9_-]+$/.test(s)) continue;
      try { const d = decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); if (/^([a-zA-Z]:[\\/]|\/)/.test(d)) return d; } catch {}
    }
    return '';
  };
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  ipcRenderer.on('vscode:insert', (_e, d) => {
    if (!d || typeof d.text !== 'string') return;
    const here = dirOfPage();
    if (d.dir && here && norm(d.dir) !== norm(here)) return;
    const box = document.querySelector('[aria-label="Prompt"]') || document.querySelector('form [contenteditable="true"]') || document.querySelector('textarea');
    if (!box) return;
    box.focus();
    const sel = window.getSelection();
    if (box.isContentEditable && sel) { sel.selectAllChildren(box); sel.collapseToEnd(); }
    const pre = (box.isContentEditable ? box.innerText : box.value).trim() ? '\n\n' : '';
    if (!document.execCommand('insertText', false, pre + d.text)) {
      if (box.isContentEditable) box.append(document.createTextNode(pre + d.text)); else box.value += pre + d.text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  });
}

// ------------------------------------------------------------ Prázdné okno (uživatel 27. 11.: „neloaduje ui“)
// Stránka OpenCode bez obsahu: po 12 s stav „OpenCode se načítá…“ s tlačítky, po 45 s jednou sama obnova (main: oc:blank
// → znovu načíst, nebo restart serveru, když neodpovídá). Zmizí, jakmile se obsah objeví.
const BLANK_CSS = `[data-czek-blank]{position:fixed;inset:0;z-index:60;display:grid;place-items:center;pointer-events:none}
[data-czek-blank] .cb-card{pointer-events:auto;box-sizing:border-box;width:min(420px,calc(100vw - 32px));padding:18px 20px;border-radius:10px;background:var(--surface-raised-base,#161616);color:var(--text-base,#a0a0a0);font:13px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;box-shadow:0 0 0 .5px color-mix(in srgb,var(--text-strong,#ededed) 18%,transparent),0 16px 40px rgba(0,0,0,.35)}
[data-czek-blank] .cb-title{margin:0 0 4px;font-size:14px;font-weight:500;color:var(--text-strong,#ededed)}
[data-czek-blank] .cb-hint{margin:0 0 14px}
[data-czek-blank] .cb-row{display:flex;gap:8px;flex-wrap:wrap}
[data-czek-blank] button{all:unset;box-sizing:border-box;height:30px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:500;cursor:pointer;color:var(--text-strong,#ededed);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-strong,#ededed) 16%,transparent)}
[data-czek-blank] button.cb-primary{background:var(--text-strong,#ededed);color:var(--surface-raised-base,#161616);box-shadow:none}
[data-czek-blank] button:focus-visible{outline:2px solid var(--text-strong,#ededed);outline-offset:2px}
[data-czek-blank] button[disabled]{opacity:.55;cursor:progress}`;
function initBlankWatch() {
  const start = Date.now();
  let card = null; let auto = false; let busy = false;
  // obsah OpenCode bez vlastních prvků czek-ai (tento stav, přehrávač, lišty) – jinak by se stav sám „vyplnil“ a blikal
  // noscript: jeho text („You need to enable JavaScript…“) innerText vrací, i když se nekreslí → prázdná stránka by nebyla prázdná
  const OWN = 'script,style,noscript,[data-czek-blank],[data-czek-video],[data-czek-upgrade],[data-czek-teacher],dialog[data-czek-cpe]';
  const empty = () => {
    const b = document.body;
    if (!b) return true;
    const vis = (e) => (typeof e.checkVisibility === 'function' ? e.checkVisibility({ checkVisibilityCSS: true }) : !!e.getClientRects().length);
    const pb = document.querySelector('[aria-label="Prompt"], form [contenteditable="true"]');
    if (pb && vis(pb)) return false;
    // viditelný text mimo vlastní prvky: textové uzly + checkVisibility (innerText u nerozkresleného okna vrací i skrytý text)
    const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement && !t.parentElement.closest(OWN) && t.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    let n = 0;
    for (let t = tw.nextNode(); t; t = tw.nextNode()) { if (vis(t.parentElement)) { n += t.nodeValue.replace(/\s+/g, '').length; if (n >= 5) return false; } }
    return true;
  };
  const act = async (action, btn) => {
    if (busy) return;
    busy = true; if (btn) btn.disabled = true;
    try { await ipcRenderer.invoke('oc:blank', { action, seconds: since ? (Date.now() - since) / 1000 : 0 }); } catch {}
    setTimeout(() => { busy = false; if (btn) btn.disabled = false; }, 4000);
  };
  const show = (secs) => {
    if (!card) {
      const st = document.createElement('style'); st.textContent = BLANK_CSS; document.head.append(st);
      card = el('div'); card.setAttribute('data-czek-blank', ''); card.setAttribute('role', 'status');
      const box = el('div', 'cb-card');
      const title = el('p', 'cb-title'); const hint = el('p', 'cb-hint', T('oc.blankHint'));
      const row = el('div', 'cb-row');
      const reload = el('button', 'cb-primary', T('oc.blankReload')); reload.type = 'button'; reload.addEventListener('click', () => act('reload', reload));
      const restart = el('button', null, T('oc.blankRestart')); restart.type = 'button'; restart.addEventListener('click', () => act('restart', restart));
      row.append(reload, restart); box.append(title, hint, row); card.append(box);
      document.body.append(card);
    }
    card.querySelector('.cb-title').textContent = T('oc.blankTitle', { s: secs });
  };
  // čas se počítá od chvíle, kdy je stránka v kuse prázdná (zbělat může i později, ne jen při načtení)
  let since = 0;
  const tick = () => {
    if (!empty()) { since = 0; auto = false; card?.remove(); card = null; return; }
    if (!since) since = Date.now();
    const secs = Math.round((Date.now() - since) / 1000);
    if (secs >= 12) show(secs);
    if (secs >= 45 && !auto) { auto = true; act('auto'); }
  };
  setInterval(tick, 1000);
}

// každá část zvlášť: chyba jedné (např. v prohlížeči přes most bez Electronu) nesmí vypnout ostatní
window.addEventListener('DOMContentLoaded', () => {
  for (const f of [initLimits, initActive, initModelPopupBar, initNoModelsWatch, initVideoDock, initUpgradeBar, initPresetPicker, initTeacherSwitch, initVscodeInsert, initBlankWatch]) {
    try { f(); } catch (e) { try { console.error('[czek-ai]', f.name, e); window.__czekErr = `${f.name}: ${e && e.message}`; } catch {} }
  }
});
