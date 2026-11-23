'use strict';
// Okno „Otevřít projekt“: rychlý přístup (připnuté + nedávné složky) a klasický dialog Windows.
const $ = (s) => document.querySelector(s);
/* global I18N */
const t = (k, v) => I18N.t(k, v);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let D = { pinned: [], recent: [] };
let rows = []; // [{path, el}] v pořadí zobrazení
let sel = 0;

const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

async function load() {
  D = await window.picker.data();
  I18N.setLang(D.lang);
  I18N.apply();
  render();
}

function row(p, pinned) {
  const r = el('div', 'pk-row');
  r.tabIndex = -1;
  const tx = el('div', 'tx');
  tx.append(el('div', 'nm', baseName(p)), el('div', 'pa', p));
  // složka s víc projekty: upozornit a nabídnout konkrétní projekty
  const subs = (D.multi || {})[p];
  if (subs?.length) {
    const w = el('div', 'pk-multi');
    w.append(el('span', null, t('picker.multi', { n: subs.length }) + ' '));
    for (const sp of subs) {
      const b = el('button', 'link', baseName(sp));
      b.onclick = (e) => { e.stopPropagation(); window.picker.choose(sp); };
      w.append(b, ' ');
    }
    tx.append(w);
  }
  const acts = el('div', 'acts');
  const pin = el('button', 'btn small', pinned ? t('picker.unpin') : t('picker.pin'));
  pin.onclick = async (e) => { e.stopPropagation(); D = await window.picker.pin(p, !pinned); render(); };
  acts.append(pin);
  if (!pinned) {
    const forget = el('button', 'btn small', t('common.remove'));
    forget.title = t('picker.forget');
    forget.onclick = async (e) => { e.stopPropagation(); D = await window.picker.forget(p); render(); };
    acts.append(forget);
  }
  r.append(tx, acts);
  r.onclick = () => window.picker.choose(p);
  r.onmouseenter = () => { sel = rows.findIndex((x) => x.el === r); mark(); };
  return r;
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const match = (p) => !q || p.toLowerCase().includes(q);
  const list = $('#list');
  list.replaceChildren();
  rows = [];
  const section = (title, items, pinned, empty) => {
    const h = el('div', 'pk-h');
    h.append(el('span', null, title));
    list.append(h);
    const shown = items.filter(match);
    if (!shown.length) { list.append(el('div', 'pk-empty', q ? t('common.nothing') : empty)); return; }
    for (const p of shown) { const r = row(p, pinned); rows.push({ path: p, el: r }); list.append(r); }
  };
  section(t('picker.pinned'), D.pinned, true, t('picker.pinnedEmpty'));
  section(t('picker.recent'), D.recent.filter((p) => !D.pinned.includes(p)), false, t('picker.recentEmpty'));
  sel = Math.min(sel, Math.max(0, rows.length - 1));
  mark();
}

function mark() {
  rows.forEach((r, i) => r.el.classList.toggle('sel', i === sel));
  rows[sel]?.el.scrollIntoView({ block: 'nearest' });
}

$('#q').addEventListener('input', () => { sel = 0; render(); });
$('#browse').onclick = () => window.picker.browse();
$('#addPinned').onclick = async () => { D = await window.picker.addPinned(); render(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); window.picker.cancel(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) { sel = (sel + 1) % rows.length; mark(); } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) { sel = (sel - 1 + rows.length) % rows.length; mark(); } }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (rows[sel]) window.picker.choose(rows[sel].path);
    else window.picker.browse();
  }
});

load();
$('#q').focus();
