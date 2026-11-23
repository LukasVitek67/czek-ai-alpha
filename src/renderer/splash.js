'use strict';
// Úvodní okno: vykreslí kroky startu, které posílá hlavní proces (main.js → splashPush).
const $ = (id) => document.getElementById(id);
let started = Date.now();

function render(s) {
  document.documentElement.lang = s.lang || 'cs';
  $('ver').textContent = s.version ? 'v' + s.version : '';
  $('title').textContent = s.title || '';
  $('hint').textContent = s.hint || '';
  if (s.started) started = s.started;
  const ol = $('steps');
  ol.replaceChildren(...s.steps.map((st) => {
    const li = document.createElement('li');
    li.className = st.state;
    li.dataset.id = st.id;
    const ic = document.createElement('span'); ic.className = 'ic';
    const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = st.label;
    li.append(ic, lbl);
    if (st.progress != null) {
      const bar = document.createElement('div'); bar.className = 'bar';
      const fill = document.createElement('i'); fill.style.width = Math.max(0, Math.min(100, st.progress)) + '%';
      bar.append(fill); li.append(bar);
    }
    if (st.detail) { const d = document.createElement('span'); d.className = 'detail'; d.textContent = st.detail; d.title = st.detail; li.append(d); }
    return li;
  }));
}

function tick() {
  const s = Math.floor((Date.now() - started) / 1000);
  $('elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(tick, 500);
window.splash?.onState(render);
