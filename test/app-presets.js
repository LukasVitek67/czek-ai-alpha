// CELÁ appka ze zdrojáků (skrytě, dočasný profil i pracovní složka): nová relace v okně OpenCode ukáže výběr presetu
// místo loga, klik na „Oprava chyby“ přepne nativního agenta OpenCode na bugfix, ruční přepnutí agenta v liště promptu
// (nativní menu) výběr srovná, v logu žádné chyby. Snímek: docs/research/2026-11-26-presets/app-presets.png.
//   OPENCODE_BIN=<opencode> node test/app-presets.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./app-cdp');

const CDP = Number(process.env.PRESETS_CDP_PORT) || 9365;
const OC_PORT = Number(process.env.PRESETS_OC_PORT) || 4451;
const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-apppresets-'));
const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
const ud = x('userdata');
const proj = x('proj');
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ router: 'zdarma', lang: 'cs', providers: {}, wizardDone: true, lastCwd: proj }));
const env = { ...process.env, ZDARMA_USER_DATA: ud, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'),
  ZDARMA_OC_PORT: String(OC_PORT), ZDARMA_HIDDEN: '1', ZDARMA_DEBUG: '1' };
delete env.OPENCODE_CONFIG_DIR;
// falešný model pro „Napsat plán modelem“ ve vlastním presetu (main: modelChat → ZDARMA_TEST_MODEL_URL)
const PLAN = ['## Goal of this mode', 'Write clear Czech essays for school.', '## Plan', '1. Read the assignment and the teacher rubric.', '2. Outline, then draft in Markdown.',
  '## Quality bar', '- Correct Czech grammar and a clear structure.', '## Verify before saying done', '- Re-read the whole text against the rubric.', '## Avoid', '- Copying sources without citing them.'].join('\n');
const modelHits = [];
const fakeModel = require('http').createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { modelHits.push(b.length); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'fake-max', choices: [{ message: { role: 'assistant', content: PLAN } }] })); }); });
const MODEL_PORT = 47600 + Math.floor(Math.random() * 300);
fakeModel.listen(MODEL_PORT, '127.0.0.1');
env.ZDARMA_TEST_MODEL_URL = `http://127.0.0.1:${MODEL_PORT}/v1/chat/completions`;
const OC = `127.0.0.1:${OC_PORT}`;
// každé CDP volání s limitem: během načítání stránky (dlouhý iframe) se Runtime.evaluate umí zaseknout
const ev = (expr) => Promise.race([cdp.evaluate(CDP, OC, expr), wait(8000).then(() => ({ err: 'cdp timeout' }))]).catch((e) => ({ err: e.message }));
const readLog = () => { for (const f of ['zdarma.log', 'czek-ai.log']) { const p = path.join(ud, f); if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } return ''; };
const state = () => ev(`(() => {
  const h = document.querySelector('[data-czek-presets]');
  const opts = h ? [...h.querySelectorAll('.cp-opt[data-agent]')] : [];
  const trig = [...document.querySelectorAll('form button[aria-haspopup]')].find((b) => /^(build|plan|web-design|web-app|backend|bugfix|game-3d|school|refactor|my-[a-z0-9-]+)$/.test(b.textContent.trim().toLowerCase()));
  const svg = [...document.querySelectorAll('svg')].find((s) => s.getBoundingClientRect().width > 200);
  return { path: location.pathname, picker: !!h, options: opts.map((o) => o.dataset.agent), checked: opts.filter((o) => o.getAttribute('aria-checked') === 'true').map((o) => o.dataset.agent),
    agent: trig ? trig.textContent.trim().toLowerCase() : null, status: h ? h.querySelector('.cp-status').textContent : null, bigLogoVisible: !!(svg && svg.getBoundingClientRect().height > 0) };
})()`);

(async () => {
  const child = spawn(require('electron'), ['.', '--password-store=basic', `--remote-debugging-port=${CDP}`], { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' });
  let exited = null;
  child.on('exit', (c, s) => { exited = { c, s }; });
  try {
    // okno OpenCode → nová relace (draft); když appka otevře jinou stránku, jdeme do nové relace složky projektu
    let s = null;
    for (let i = 0; i < 240; i++) {
      await wait(1000);
      if (exited) break;
      s = await state();
      if (s?.picker && s.agent) break;
      if (i >= 30 && s && !s.err && s.path && !s.path.includes('new-session') && i % 15 === 0) {
        await ev(`location.href = '/' + btoa(unescape(encodeURIComponent(${JSON.stringify(proj)}))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') + '/session'`);
      }
    }
    console.log('nová relace:', JSON.stringify(s));
    assert.ok(!exited, 'appka běží');
    assert.ok(s?.picker, 'výběr presetu v nové relaci');
    assert.deepStrictEqual(s.options, ['web-design', 'web-app', 'backend', 'bugfix', 'game-3d', 'school', 'refactor', 'build'], '8 voleb v pořadí presets.json');
    assert.ok(!s.bigLogoVisible, 'logo OpenCode místo výběru skryté');
    assert.deepStrictEqual(s.checked, [s.agent], 'vybraná volba = aktuální agent OpenCode');
    // klik na „Oprava chyby“ → nativní agent bugfix
    await ev(`document.querySelector('[data-czek-presets] .cp-opt[data-agent="bugfix"]').click()`);
    for (let i = 0; i < 20; i++) { await wait(250); s = await state(); if (s.agent === 'bugfix') break; }
    console.log('po kliku:', JSON.stringify({ agent: s.agent, checked: s.checked, status: s.status }));
    assert.strictEqual(s.agent, 'bugfix', 'nativní agent OpenCode přepnutý na bugfix');
    assert.deepStrictEqual(s.checked, ['bugfix']);
    assert.match(s.status, /bugfix · 4 skills/, 'stavový řádek: aktivní agent a počet skills');
    // ruční přepnutí v liště promptu (nativní menu) → výběr se srovná
    await ev(`(async () => {
      const ptr = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true };
      const t = [...document.querySelectorAll('form button[aria-haspopup]')].find((b) => b.textContent.trim().toLowerCase() === 'bugfix');
      t.dispatchEvent(new PointerEvent('pointerdown', ptr)); t.click();
      let it = null; for (let i = 0; i < 25 && !it; i++) { await new Promise((r) => setTimeout(r, 40)); it = [...document.querySelectorAll('[role="menuitemradio"]')].find((m) => m.textContent.trim().toLowerCase() === 'web-design'); }
      it.dispatchEvent(new PointerEvent('pointermove', ptr)); it.dispatchEvent(new PointerEvent('pointerenter', { ...ptr, bubbles: false }));
      await new Promise((r) => setTimeout(r, 30));
      for (const k of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) it.dispatchEvent(new (k.startsWith('pointer') ? PointerEvent : MouseEvent)(k, ptr));
      it.click();
    })()`);
    for (let i = 0; i < 20; i++) { await wait(250); s = await state(); if (s.checked[0] === 'web-design') break; }
    console.log('ruční přepnutí:', JSON.stringify({ agent: s.agent, checked: s.checked, status: s.status }));
    assert.strictEqual(s.agent, 'web-design');
    assert.deepStrictEqual(s.checked, ['web-design'], 'výběr následuje nativního agenta');
    // přepínač pravidel učitele nad promptem: viditelný, nepřekrývá výběr, klik → stav pro rozepsaný chat (pending)
    const tsw = () => ev(`(() => { const b = document.querySelector('[data-czek-teacher]'); const p = document.querySelector('[data-czek-presets]'); if (!b) return null;
      const r = b.getBoundingClientRect(), q = p ? p.getBoundingClientRect() : null;
      return { shown: getComputedStyle(b).display !== 'none' && r.width > 0, text: b.innerText, checked: b.getAttribute('aria-checked'), inPicker: !!b.closest('[data-czek-presets] .cp-head'), overlap: !b.closest('[data-czek-presets]') && !!(q && r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top) }; })()`);
    let t1 = null;
    for (let i = 0; i < 20; i++) { t1 = await tsw(); if (t1?.shown) break; await wait(300); }
    console.log('pravidla učitele:', JSON.stringify(t1));
    assert.ok(t1?.shown, 'přepínač pravidel učitele nad promptem');
    assert.match(t1.text, /Pravidla učitele: vypnutá/, 'výchozí stav vypnuto');
    assert.ok(!t1.overlap, 'přepínač nepřekrývá výběr presetu');
    assert.ok(t1.inPicker, 'v nové relaci je přepínač v hlavičce výběru');
    await ev(`document.querySelector('[data-czek-teacher]').click()`);
    let t2 = null;
    for (let i = 0; i < 20; i++) { await wait(250); t2 = await tsw(); if (t2?.checked === 'true') break; }
    assert.strictEqual(t2?.checked, 'true', 'klik zapne');
    const tj = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'czek-guard', 'teacher.json'), 'utf8'));
    console.log('teacher.json:', JSON.stringify({ default: tj.default, pending: tj.pending?.on, kit: fs.existsSync(path.join(tj.kitDir, 'templates', 'agentic', 'AGENTS.md')) }));
    assert.strictEqual(tj.pending?.on, true, 'rozepsaný chat: pending zapnuto pro guard');
    // vlastní preset: „+ Vlastní preset“ → dialog → plán od modelu → uložit → po obnovení OpenCode ve výběru → zvolit
    await ev(`document.querySelector('[data-czek-presets] .cp-add').click()`);
    let dlg = null;
    for (let i = 0; i < 20 && !dlg?.open; i++) { await wait(250); dlg = await ev(`(() => { const d = document.querySelector('dialog[data-czek-cpe]'); return d ? { open: d.open, skills: d.querySelectorAll('.ce-skill').length, colors: d.querySelectorAll('.ce-sw').length } : null; })()`); }
    console.log('editor:', JSON.stringify(dlg));
    assert.ok(dlg?.open && dlg.skills >= 10 && dlg.colors === 8, 'editor vlastního presetu otevřený (skills, barvy)');
    await ev(`(() => { const d = document.querySelector('dialog[data-czek-cpe]'); const [name, tag, desc] = d.querySelectorAll('input[type=text]');
      name.value = 'Slohovka'; tag.value = 'Sloh, eseje'; desc.value = 'Slohové práce do češtiny podle zadání učitele';
      d.querySelector('.ce-skill input[value="czek-research"]')?.click(); d.querySelectorAll('.ce-sw')[5].click();
      [...d.querySelectorAll('button.ce-b')].find((b) => /Napsat plán/.test(b.textContent)).click(); return 1; })()`);
    let planVal = '';
    for (let i = 0; i < 40 && !planVal.includes('## Avoid'); i++) { await wait(250); planVal = (await ev(`document.querySelector('dialog[data-czek-cpe] textarea')?.value || ''`)) || ''; }
    assert.ok(String(planVal).includes('## Avoid') && modelHits.length >= 1, 'plán napsal model (falešný)');
    await cdp.shot(CDP, OC, path.join(root, 'docs', 'research', '2026-11-26-presets', 'custom-preset-editor.png')).catch(() => {});
    await ev(`document.querySelector('dialog[data-czek-cpe] button.ce-primary').click()`);
    let saved = null;
    for (let i = 0; i < 20 && !saved; i++) { await wait(300); try { saved = (JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).customPresets || [])[0] || null; } catch {} }
    console.log('uloženo:', JSON.stringify(saved && { id: saved.id, skills: saved.skills, color: saved.color, plan: saved.plan.length }));
    assert.ok(saved && saved.id === 'my-slohovka' && saved.skills.includes("czek-research"), 'vlastní preset v nastavení');
    // OpenCode se restartuje (nic neběží) a okno se načte znovu → nový preset ve výběru
    const toNew = () => ev(`location.href = '/' + btoa(unescape(encodeURIComponent(${JSON.stringify(proj)}))).split('+').join('-').split('/').join('_').replace(/=+$/, '') + '/session'`);
    let s2 = null;
    for (let i = 0; i < 120; i++) { await wait(1000); s2 = await state(); if (s2?.options?.includes('my-slohovka')) break; if (i % 20 === 19 && s2 && !s2.err && !String(s2.path).includes('new-session')) await toNew(); }
    console.log('po obnovení:', JSON.stringify(s2?.options));
    assert.ok(s2?.options?.includes('my-slohovka'), 'vlastní preset ve výběru');
    assert.ok(s2.options.indexOf('my-slohovka') < s2.options.indexOf('build'), 'před obecným chatem');
    // po restartu OpenCode lišta promptu (tlačítko agenta) naskočí až s načtenými poskytovateli
    for (let i = 0; i < 90; i++) { s2 = await state(); if (s2?.agent) break; await wait(1000); }
    console.log('tlačítko agenta po restartu:', s2?.agent);
    if (!s2?.agent) await cdp.shot(CDP, OC, path.join(base, 'no-agent.png')).then(() => console.log('snímek', path.join(base, 'no-agent.png'))).catch(() => {});
    await ev(`document.querySelector('[data-czek-presets] .cp-opt[data-agent="my-slohovka"]').click()`);
    for (let i = 0; i < 20; i++) { await wait(250); s2 = await state(); if (s2.agent === 'my-slohovka') break; }
    console.log('zvolen vlastní:', JSON.stringify({ agent: s2.agent, status: s2.status }));
    if (s2.agent !== 'my-slohovka') {
      console.log('tlačítka:', JSON.stringify(await ev(`[...document.querySelectorAll('form button[aria-haspopup]')].map((b) => b.textContent.trim())`)));
      console.log('menu:', JSON.stringify(await ev(`(async () => { const t = [...document.querySelectorAll('form button[aria-haspopup]')][0]; t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true })); t.click(); await new Promise((r) => setTimeout(r, 400)); return [...document.querySelectorAll('[role="menuitemradio"],[role="option"],[role="menuitem"]')].map((m) => m.textContent.trim()); })()`)));
      const agents = await (await fetch(`http://${OC}/agent?directory=${encodeURIComponent(proj)}`)).json().catch((e) => e.message);
      console.log('agenti OpenCode:', JSON.stringify(Array.isArray(agents) ? agents.map((a) => a.name + ':' + a.mode) : agents));
    }
    assert.strictEqual(s2.agent, 'my-slohovka', 'nativní agent OpenCode = vlastní preset');
    const pj = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'opencode', 'plugins', 'czek-guard', 'presets.json'), 'utf8'));
    assert.ok(pj.agents['my-slohovka']?.plan.includes('## Plan'), 'guard má plán vlastního presetu');
    const out = path.join(root, 'docs', 'research', '2026-11-26-presets');
    fs.mkdirSync(out, { recursive: true });
    await cdp.shot(CDP, OC, path.join(out, 'app-presets.png')).catch((e) => console.log('snímek nevyšel:', e.message));
    // regrese 26. 11.: iframe videa (YouTube) se src nastaveným před „load“ zdržel načtení okna OpenCode o ~5 min
    const lg = readLog();
    const at = (re) => { const m = re.exec(lg); return m ? Date.parse(m[1]) : null; };
    const ready = at(/^(\S+) \[opencode\] dom-ready http:\/\/127\.0\.0\.1:\d+\//m);
    const fin = at(/^(\S+) \[opencode\] did-finish-load http:\/\/127\.0\.0\.1:\d+\//m);
    console.log('okno OpenCode: load', ready && fin ? `${fin - ready} ms po dom-ready` : 'neměřeno');
    if (ready && fin) assert.ok(fin - ready < 60000, 'video (iframe) nezdržuje načtení okna OpenCode');
    const errs = readLog().split('\n').filter((l) => /renderer gone|renderer skončil|nezachycen|uncaught|unhandled|preload-error|console\((3|error)\)|TypeError|ReferenceError/i.test(l));
    console.log('chyby v logu:', errs.length); for (const e of errs.slice(0, 8)) console.log('  ', e.slice(0, 300));
    assert.deepStrictEqual(errs, [], 'žádné chyby v logu');
    console.log('app-presets OK');
  } finally {
    try { if (process.platform === 'win32') require('child_process').execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-child.pid, 'SIGTERM'); } catch {}
    await wait(2500);
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {}
    if (!process.env.KEEP_TMP) setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 500);
  }
  process.exit(0);
})().catch((e) => { console.error('app-presets FAILED:', e.message); try { console.error(readLog().split('\n').slice(-25).join('\n').slice(0, 4000)); } catch {} process.exit(1); });
