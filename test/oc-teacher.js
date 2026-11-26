// Pravidla učitele (Agentic Starter Kit) na skutečném OpenCode (izolované XDG) + czek-guard + falešný model:
//  - projekt s AGENTS.md kitu, výchozí stav vypnuto → blok AGENTS.md se z promptu VYŘÍZNE + pokyn ignorovat i dřívější,
//    ostatní pokyny (czek-method) zůstanou;
//  - zapnout v téže relaci → AGENTS.md zpět + „platí, i když dřív ne“; vypnout znovu → zase pryč;
//  - projekt bez kitu: výchozí vypnuto = žádný blok; zapnuto → pravidla kitu před bootstrapem + cesta ke kitu;
//  - přepnutí rozepsaného chatu (pending) převezme 1. zpráva nové relace;
//  - příkazy kitu (/bootstrap-agentic-environment …) v OpenCode, kit zkopírovaný vedle pluginu; vypnutí funkce uklidí.
//   OPENCODE_BIN=<opencode> node test/oc-teacher.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { findOpencode, serveEnv } = require('../src/opencodeServer');

const METHOD = path.join(__dirname, '..', 'skills', 'czek-method', 'SKILL.md');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zd-teacher-')));
  const x = (k) => { const d = path.join(base, k); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = serveEnv({ ...process.env, XDG_CONFIG_HOME: x('config'), XDG_DATA_HOME: x('data'), XDG_STATE_HOME: x('state'), XDG_CACHE_HOME: x('cache'), OPENCODE_DISABLE_CLAUDE_CODE: '1' });
  delete env.OPENCODE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const kitProj = x('kitproj');
  const plain = x('plain');
  // AGENTS.md po bootstrapu kitu (šablona s doplněným názvem) + značka pro test
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'src', 'teacher-kit', 'templates', 'agentic', 'AGENTS.md'), 'utf8').replace(/\{\{PROJECT_NAME\}\}/g, 'Test').replace(/\{\{LANGUAGE\}\}/g, 'čeština').replace(/\{\{APPROVER\}\}/g, 'Učitel');
  fs.writeFileSync(path.join(kitProj, 'AGENTS.md'), tpl + '\nKITMARK-XYZ\n');
  const oc = require('../src/opencode');
  const seen = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const j = JSON.parse(b);
      if ((j.tools || []).length) seen.push(j.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ch = (d, f) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.end(ch({ role: 'assistant', content: 'OK' }, null) + ch({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  const upPort = 46900 + Math.floor(Math.random() * 300);
  await new Promise((r) => up.listen(upPort, '127.0.0.1', r));
  let child = null;
  const state = { default: false, sessions: {}, pending: null };
  const conf = (extra = {}) => oc.writeConfig(upPort, [], { tiers: [{ id: 'max', name: 'Max', keys: [] }], snapshotOff: true, dcp: false, caveman: false, method: true, methodSkill: METHOD, presets: false, teacherState: state, ...extra });
  try {
    conf();
    const cfg = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
    assert.ok(cfg.command?.['bootstrap-agentic-environment']?.description?.startsWith(oc.TEACHER_MARK), 'příkaz /bootstrap-agentic-environment v konfiguraci');
    assert.ok(['discover-project', 'plan-increment', 'work-task'].every((c) => cfg.command[c]), '3 vstupní příkazy kitu');
    assert.match(cfg.command['bootstrap-agentic-environment'].template, /\$ARGUMENTS/, 'šablona s $ARGUMENTS');
    assert.ok(cfg.command['bootstrap-agentic-environment'].template.includes(path.join(oc.TEACHER_DIR(), 'templates', 'agentic')), 'cesta k šablonám kitu');
    assert.ok(fs.existsSync(path.join(oc.TEACHER_DIR(), 'templates', 'agentic', 'AGENTS.md')), 'kit zkopírovaný vedle pluginu');
    const setState = () => oc.writeTeacherState(state, true);

    child = spawn(findOpencode(), ['serve', '--port', '4347', '--hostname', '127.0.0.1'], { cwd: kitProj, env, windowsHide: true, stdio: 'ignore' });
    const u = 'http://127.0.0.1:4347';
    const post = async (dir, p, body) => (await fetch(u + p + '?directory=' + encodeURIComponent(dir), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    for (let i = 0; i < 80; i++) { try { if ((await fetch(u + '/')).ok) break; } catch {} await wait(500); }
    const cmds = await (await fetch(u + '/command?directory=' + encodeURIComponent(kitProj))).json().catch(() => []);
    assert.ok(Array.isArray(cmds) && cmds.some((c) => c.name === 'bootstrap-agentic-environment'), 'OpenCode zná příkaz /bootstrap-agentic-environment');
    const turn = async (dir, sid) => {
      const before = seen.length;
      await post(dir, `/session/${sid}/message`, { model: { providerID: 'zdarma', modelID: 'max' }, parts: [{ type: 'text', text: 'pokračuj v práci' }] });
      return seen.slice(before).at(-1) || '';
    };
    const A = (await post(kitProj, '/session', {})).id;
    const off1 = await turn(kitProj, A);
    assert.ok(off1.length > 1000, 'zachycený prompt');
    assert.ok(!off1.includes('KITMARK-XYZ') && !off1.includes('provozní řád projektu Test'), 'vypnuto (výchozí): AGENTS.md kitu vyříznuté');
    assert.match(off1, /Teacher's rules: OFF/, 'vypnuto: pokyn ignorovat');
    assert.match(off1, /How you work \(always on\)/, 'ostatní pokyny (czek-method) zůstaly');
    state.sessions[A] = true; setState();
    const on1 = await turn(kitProj, A);
    assert.ok(on1.includes('KITMARK-XYZ'), 'zapnuto: AGENTS.md kitu v promptu');
    assert.match(on1, /Teacher's rules: ON/);
    assert.match(on1, /including rules you were told to ignore earlier/, 'zapnuto: platí i po dřívějším vypnutí');
    assert.ok(!/Teacher's rules: OFF/.test(on1));
    state.sessions[A] = false; setState();
    const off2 = await turn(kitProj, A);
    assert.ok(!off2.includes('KITMARK-XYZ') && /Teacher's rules: OFF/.test(off2), 'znovu vypnuto: zase pryč');
    assert.match(off2, /also any you followed earlier in this conversation/, 'vypnuto: i zpětně');

    const B = (await post(plain, '/session', {})).id;
    const p0 = await turn(plain, B);
    assert.ok(!/Teacher's rules/.test(p0), 'projekt bez kitu, výchozí vypnuto: žádný blok (žádné tokeny navíc)');
    state.sessions[B] = true; setState();
    const p1 = await turn(plain, B);
    assert.match(p1, /not set up with the kit yet/, 'bez kitu, zapnuto: pravidla před bootstrapem');
    assert.ok(p1.includes(oc.TEACHER_DIR()), 'cesta ke kitu');

    state.pending = { on: true, at: Date.now() }; setState();
    const C = (await post(plain, '/session', {})).id;
    const c1 = await turn(plain, C);
    assert.match(c1, /Teacher's rules: ON/, 'přepnutí rozepsaného chatu převezme 1. zpráva');

    // funkce vypnutá → bez příkazů kitu a bez teacher.json
    conf({ teacher: false });
    const cfg2 = JSON.parse(fs.readFileSync(oc.CONFIG_FILE(), 'utf8'));
    assert.ok(!cfg2.command?.['bootstrap-agentic-environment'] && !fs.existsSync(path.join(oc.GUARD_DIR(), 'teacher.json')), 'teacher:false uklidí');
    console.log(`oc-teacher OK (vypnuto: AGENTS.md vyříznuté ${off1.length} znaků promptu; zapnuto ${on1.length}; bez kitu nic navíc; pending; 4 příkazy kitu)`);
  } finally {
    if (child) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill('SIGKILL'); } catch {} } }
    up.close();
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 1500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
