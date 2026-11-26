// Dev verze z klonu repa (src/devUpdate.js) na skutečném gitu: holé „origin“ + klon se značkou v dočasné složce.
//  - pracovní repo bez značky se nikdy samo nemění; dokumenty se sloučí hned, kód při startu (relaunch);
//  - změněný soubor / vlastní commit / jiná větev → nic se nepřepíše; nedostupný origin → start jede dál;
//  - závislosti (package.json) → pomocný skript po konci procesu: sloučí, npm install, spustí appku znovu (Windows).
//   node test/dev-update.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const dev = require('../src/devUpdate');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-devupd-'));
const p = (...a) => path.join(base, ...a);
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rd = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); // Windows: core.autocrlf
const commit = (cwd, files, msg) => { for (const [f, s] of Object.entries(files)) write(path.join(cwd, f), s); sh(cwd, 'add', '-A'); sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); sh(cwd, 'push', '-q', 'origin', 'main'); };

(async () => {
  try {
    sh(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    sh(base, 'clone', '-q', p('origin.git'), 'seed');
    sh(p('seed'), 'checkout', '-q', '-b', 'main');
    commit(p('seed'), { 'package.json': '{"name":"czek-ai","version":"1.0.0"}\n', 'src/a.js': 'a1\n', 'docs/x.md': 'x1\n' }, 'init');
    sh(base, 'clone', '-q', p('origin.git'), 'dev');
    const D = p('dev');
    assert.strictEqual(dev.devRoot(D), null, 'bez značky není dev klon');
    assert.strictEqual(dev.devRoot(path.join(__dirname, '..')), null, 'pracovní repo není dev klon');
    write(path.join(D, '.git', dev.MARK), 'x');
    assert.strictEqual(dev.devRoot(D), D);
    const logs = [];
    const log = (...a) => logs.push(a.join(' '));

    // 1) nic nového → null
    assert.strictEqual(await dev.startup(D, { log }), null);

    // 2) jen dokumenty: za běhu se sloučí hned, lišta ne
    commit(p('seed'), { 'docs/x.md': 'x2\n' }, 'docs only');
    assert.strictEqual(await dev.poll(D, { log }), null, 'docs → bez lišty');
    assert.strictEqual(rd(path.join(D, 'docs/x.md')), 'x2\n', 'docs sloučeny za běhu');

    // 3) kód: za běhu jen stav pro lištu (nic se nesloučí), při startu sloučit + relaunch
    commit(p('seed'), { 'src/a.js': 'a2\n' }, 'feat: kód');
    const pend = await dev.poll(D, { log });
    assert.ok(pend && pend.restart && pend.behind === 1 && pend.subject === 'feat: kód', 'kód → lišta: ' + JSON.stringify(pend));
    assert.strictEqual(rd(path.join(D, 'src/a.js')), 'a1\n', 'za běhu se kód nemění');
    assert.strictEqual(await dev.startup(D, { log }), 'relaunch');
    assert.strictEqual(rd(path.join(D, 'src/a.js')), 'a2\n', 'při startu sloučeno');
    assert.strictEqual(await dev.startup(D, { log }), null, 'po sloučení už nic (žádná smyčka restartů)');

    // 4) změněný sledovaný soubor v klonu → nic se nepřepíše
    commit(p('seed'), { 'src/a.js': 'a3\n' }, 'feat: další');
    write(path.join(D, 'src/a.js'), 'moje\n');
    assert.strictEqual(await dev.startup(D, { log }), null);
    assert.strictEqual(rd(path.join(D, 'src/a.js')), 'moje\n', 'vlastní změna zůstala');
    assert.ok(logs.some((l) => /změněné soubory/.test(l)), 'důvod v logu');
    sh(D, 'checkout', '--', 'src/a.js');

    // 5) vlastní commit v klonu → nic
    write(path.join(D, 'src/b.js'), 'b\n'); sh(D, 'add', '-A'); sh(D, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'local');
    assert.strictEqual(await dev.startup(D, { log }), null);
    assert.ok(logs.some((l) => /vlastních commitů/.test(l)));
    sh(D, 'reset', '-q', '--hard', 'HEAD~1');

    // 6) nedostupný origin → fetch selže, start z posledního staženého stavu (tady a3 už stažené) a nespadne
    sh(D, 'remote', 'set-url', 'origin', p('neni.git'));
    const t0 = Date.now();
    assert.strictEqual(await dev.startup(D, { log }), 'relaunch', 'použije poslední stažený stav');
    assert.ok(Date.now() - t0 < 6000, 'offline start nečeká dlouho');
    assert.ok(logs.some((l) => /fetch nevyšel/.test(l)));
    sh(D, 'remote', 'set-url', 'origin', p('origin.git'));

    // 7) závislosti → pomocný skript po konci procesu (jen Windows: cmd)
    if (process.platform === 'win32') {
      commit(p('seed'), { 'package.json': '{"name":"czek-ai","version":"1.0.1"}\n', 'src/a.js': 'a4\n' }, 'chore: závislosti');
      const fake = spawn(process.execPath, ['-e', 'setTimeout(()=>{},2500)'], { stdio: 'ignore' }); // „běžící appka“
      const flag = p('launched.txt');
      const launcher = p('launch.js');
      write(launcher, `require('fs').writeFileSync(${JSON.stringify(flag)}, process.argv.slice(2).join('|'))`);
      const r = await dev.startup(D, { log, helper: { pid: fake.pid, exe: process.execPath, args: [launcher, D], log: p('helper.log') } });
      assert.strictEqual(r, 'helper');
      assert.strictEqual(rd(path.join(D, 'src/a.js')), 'a3\n', 'sloučí až skript po konci procesu');
      for (let i = 0; i < 60 && !fs.existsSync(flag); i++) await wait(1000);
      assert.ok(fs.existsSync(flag), 'skript appku spustil znovu; log: ' + (fs.existsSync(p('helper.log')) ? fs.readFileSync(p('helper.log'), 'utf8') : '-'));
      assert.ok(fake.exitCode !== null, 'až po konci procesu');
      assert.strictEqual(fs.readFileSync(flag, 'utf8'), D, 'stejné argumenty (launch.js je skript, za ním složka appky)');
      assert.strictEqual(rd(path.join(D, 'src/a.js')), 'a4\n', 'sloučeno');
      assert.strictEqual(sh(D, 'status', '--porcelain', '--untracked-files=no'), '', 'klon zůstal čistý (lock vrácen)');
    }
    console.log('dev-update OK (docs hned, kód při startu, nic se nepřepíše, offline, závislosti po konci procesu)');
  } finally {
    setTimeout(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }, 500);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
