'use strict';
// Přehled přibalených skills s návody (data: skills/catalog.json + stav instalace ze Zdarmy).
const $ = (s) => document.querySelector(s);
/* global I18N */
const t = (k, v) => I18N.t(k, v);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let D = null;
const open = new Set();

let STATUS = {};
const setStatusLabels = () => {
  STATUS = {
    installed: [t('skills.active'), 'on'], updated: [t('skills.active'), 'on'], ok: [t('skills.active'), 'on'],
    claude: [t('skills.activeClaude'), 'ext'], user: [t('skills.activeOwn'), 'ext'],
    error: [t('skills.error'), 'bad'],
  };
};

async function load(resync) {
  D = resync ? await window.skills.resync() : await window.skills.data();
  I18N.setLang(D.lang);
  I18N.apply();
  setStatusLabels();
  render();
}

function matches(s, q) {
  if (!q) return true;
  return [s.name, s.summary, s.badge, s.what, ...(s.when || [])].join(' ').toLowerCase().includes(q);
}

function guide(s) {
  const g = el('div', 'sk-guide');
  g.append(el('h3', null, t('skills.what')), el('p', null, s.what));
  if (s.when?.length) {
    g.append(el('h3', null, t('skills.when')));
    const ul = el('ul');
    for (const w of s.when) ul.append(el('li', null, w));
    g.append(ul);
  }
  if (s.examples?.length) {
    g.append(el('h3', null, t('skills.examples')));
    for (const ex of s.examples) {
      const row = el('div', 'sk-ex');
      const b = el('button', 'btn small', t('common.copy'));
      b.onclick = async (e) => { e.stopPropagation(); await window.skills.copy(ex); b.textContent = t('common.copied'); setTimeout(() => (b.textContent = t('common.copy')), 1400); };
      row.append(el('div', 't', ex), b);
      g.append(row);
    }
  }
  if (s.needs) g.append(el('h3', null, t('skills.needs')), el('p', null, s.needs));
  if (s.note) g.append(el('h3', null, t('skills.note')), el('p', 'sk-note', s.note));
  const src = D.catalog.sources?.[s.source] || {};
  const st = D.status[s.name];
  const foot = el('p', 'sk-src');
  if (src.url) {
    const a = el('a', null, src.url.replace(/^https:\/\//, ''));
    a.href = '#';
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); window.skills.openUrl(src.url); };
    foot.append(a, t('skills.license', { l: src.license }));
  } else foot.append(src.license || '');
  if (st?.path) foot.append(` · ${st.path}`);
  if (st?.error) foot.append(` · ${st.error}`);
  g.append(el('h3', null, t('skills.source')), foot);
  return g;
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const list = $('#list');
  list.replaceChildren();
  const all = D.catalog.skills || [];
  let shown = 0;
  for (const grp of D.catalog.groups || []) {
    const items = all.filter((s) => s.group === grp.id && matches(s, q));
    if (!items.length) continue;
    list.append(el('div', 'sk-group', grp.title));
    for (const s of items) {
      shown++;
      const row = el('div', 'sk-row' + (open.has(s.name) ? ' open' : ''));
      const bar = el('div');
      const fill = el('div', 'sk-impact');
      fill.style.width = `${Math.max(8, s.impact || 0)}%`;
      bar.append(fill);
      const [label, cls] = STATUS[D.status[s.name]?.status] || [t('skills.notInstalled'), 'bad'];
      row.append(bar, el('span', 'sk-name', s.name), el('span', 'sk-sum', s.summary), el('span', 'sk-badge', s.badge), el('span', `sk-st ${cls}`, label));
      row.onclick = () => { if (open.has(s.name)) open.delete(s.name); else open.add(s.name); render(); };
      list.append(row);
      if (open.has(s.name)) list.append(guide(s));
    }
  }
  if (!shown) list.append(el('p', 'muted', t('common.nothing')));
  const active = all.filter((s) => (STATUS[D.status[s.name]?.status] || [])[1] && STATUS[D.status[s.name]?.status][1] !== 'bad').length;
  $('#count').textContent = t('skills.count', { n: all.length, active }) + (q ? t('skills.shown', { n: shown }) : '');
}

$('#q').addEventListener('input', render);
$('#folder').onclick = () => window.skills.openFolder();
$('#resync').onclick = () => load(true);
document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); } });
load();
