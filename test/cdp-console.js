// skills/app-debugging/scripts/cdp-console.cjs --dist: neviditelný Chrome/Edge najde chybu, kvůli které je
// okno prázdné (živě 8. 11.: lossless-player „ReferenceError: addFolder is not defined“), a u funkční
// stránky vypíše obsah. Bez Chrome/Edge na počítači se test přeskočí.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'skills', 'app-debugging', 'scripts', 'cdp-console.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-cdp-'));
const mk = (name, js) => {
  const d = path.join(tmp, name, 'assets');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(tmp, name, 'index.html'), '<!doctype html><title>Test App</title><div id="app"></div><script type="module" src="./assets/main.js"></script>');
  fs.writeFileSync(path.join(d, 'main.js'), js);
  return path.join(tmp, name);
};
const broken = mk('broken', 'function mount(){ document.getElementById("app").onclick = addFolder; document.getElementById("app").textContent = "Library"; } mount();');
const ok = mk('ok', 'document.getElementById("app").textContent = "Library: 3 albums";');

const run = (dir) => spawnSync(process.execPath, [script, '--dist', dir, '2500'], { encoding: 'utf8', timeout: 60000 });
const r1 = run(broken);
if (/NO CHROME\/EDGE FOUND/.test(r1.stdout)) { console.log('cdp-console SKIP (no Chrome/Edge)'); process.exit(0); }
assert.match(r1.stdout, /TITLE: Test App/, r1.stdout + r1.stderr);
assert.match(r1.stdout, /PAGE IS EMPTY/, r1.stdout);
assert.match(r1.stdout, /EXCEPTION: ReferenceError: addFolder is not defined/, r1.stdout);
const r2 = run(ok);
assert.match(r2.stdout, /NO CONSOLE ERRORS/, r2.stdout);
assert.match(r2.stdout, /TEXT: Library: 3 albums/, r2.stdout);
setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1000);
console.log('cdp-console OK');
