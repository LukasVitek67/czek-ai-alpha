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
  frame.src = src();
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
    bar.append(el('span', null, T('oc.upgradeReady', { v: u.version, cur: u.current })));
    const go = el('button', null, T('oc.upgradeGo'));
    go.title = T('oc.upgradeGoTitle');
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

window.addEventListener('DOMContentLoaded', () => { initLimits(); initActive(); initModelPopupBar(); initNoModelsWatch(); initVideoDock(); initUpgradeBar(); });
