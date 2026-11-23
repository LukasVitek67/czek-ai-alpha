// Test sebehodnotícího reportu (src/selfReport.js): fixture logu v dočasné složce, kontrola nálezů,
// třídění chyb (výpadek sítě != mrtvý model), interní volání, šum hlídače a maskování klíče.
// Nikdy nesahá na skutečný profil uživatele.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateReport } = require('../src/selfReport');

const FAKE = 'sk-or-v1-' + 'A'.repeat(24); // falešný klíč, jen pro test maskování
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-selfreport-'));
const day = '2026-11-20';
const base = Date.parse(day + 'T10:00:00Z');

// Záznamy o sekundu dál, ať je pořadí jasné.
function builder() {
  const recs = [];
  let n = 0;
  const add = (kind, src, msg, data) => recs.push({ t: new Date(base + 1000 * n++).toISOString(), src, kind, msg, data });
  return { recs, add };
}
// Zapíše den; jeden rozbitý řádek se vloží mezi záznamy (musí se přeskočit).
function writeDay(dir, recs) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = recs.map((r) => JSON.stringify(r));
  lines.splice(2, 0, '{rozbity json');
  fs.writeFileSync(path.join(dir, day + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

// ---- A: hlavní fixture ----
const A = builder();
const { add } = A;
add('start', 'app', 'Spuštěno', { version: '0.0.0-test' });
add('step-start', 'opencode', 'Krok modelu začal', { part: { type: 'step-start', messageID: 'm1' } });
// výpadek sítě: 8× 502 ENOTFOUND (nesmí být "mrtvý"), 2× OK
for (let i = 0; i < 8; i++) add('call', 'omniroute', 'Volání glm-x: HTTP 502', { model: 'glm-x', status: 502, duration: 40, error: 'fetch failed (cause: ENOTFOUND getaddrinfo api.z.ai)' });
for (let i = 0; i < 2; i++) add('call', 'omniroute', 'Volání glm-x: HTTP 200', { model: 'glm-x', status: 200, duration: 9000 });
for (let i = 0; i < 3; i++) add('call', 'omniroute', 'Volání zdarma-max: HTTP 200', { model: 'zdarma-max', status: 200, duration: 4000 });
// poražený v závodě: status 0 „aborted" × 4 (třída přerušeno – ne chyba modelu, nesmí být „bad" ani nález)
for (let i = 0; i < 4; i++) add('call', 'omniroute', 'Volání beta-x: HTTP 0', { model: 'beta-x', status: 0, duration: 1200, error: 'aborted' });
// interní test připojení (nesmí být v tabulce modelů)
for (let i = 0; i < 3; i++) add('call', 'omniroute', 'Test připojení: HTTP 0', { model: 'connection-test', status: 0, duration: 5, error: 'aborted' });
add('call', 'omniroute', 'Test připojení: HTTP 200', { model: 'connection-test', status: 200, duration: 300 });
add('call', 'omniroute', 'Synchronizace modelů: HTTP 200', { model: 'model-sync', status: 200, duration: 800 });
// pomalý bash 160 s
add('tool-completed', 'opencode', 'Nástroj hotový: bash cargo build --release (160000 ms)',
  { part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'cargo build --release' }, time: { start: 1000, end: 161000 } } } });
// neexistující nástroj ls
add('tool-error', 'opencode', 'Nástroj SELHAL: invalid – důvod: unavailable tool',
  { part: { type: 'tool', tool: 'invalid', state: { status: 'error', input: { tool: 'ls' }, error: "Model tried to call unavailable tool 'ls'." } } });
// tři stejné bash příkazy s falešným klíčem v argumentech
const cmd = `curl -s -H "Authorization: Bearer ${FAKE}" https://example.invalid/api`;
for (let i = 0; i < 3; i++) add('tool-completed', 'opencode', 'Nástroj hotový: bash curl (250 ms)',
  { part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: cmd }, time: { start: 0, end: 250 } } } });
// příkaz spuštěný přes czek-guard (kill-preamble + běh na pozadí): report má ukázat skutečný příkaz, ne boilerplate
const launched = 'czek_kill() {\n  local p="${1%%:*}"\n}\nfor f in /tmp/sess-*.pid; do czek_kill "$(cat "$f")"; rm -f "$f"; done\n(\nnpm run tauri dev\n) > /tmp/czek-run/x.log 2>&1 < /dev/null &\necho "$!" > /tmp/sess.pid';
add('tool-completed', 'opencode', 'Nástroj hotový: bash czek_kill() {… (12000 ms)',
  { part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: launched }, time: { start: 0, end: 12000 } } } });
// nereálně dlouhý čas (uspání PC během běhu na pozadí): 80 min – nesmí se počítat ani hlásit jako „>= 110 s"
const slept = '(\n./vivid-music-player.exe\n) > /tmp/czek-run/y.log 2>&1 < /dev/null &';
add('tool-completed', 'opencode', 'Nástroj hotový: bash (4800000 ms)',
  { part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: slept }, time: { start: 0, end: 4800000 } } } });
// dva kroky modelu s tokeny
add('step-finish', 'opencode', 'Krok modelu skončil – důvod: tool-calls; tokeny vstup 1200, cache 0, výstup 80, myšlení 0',
  { part: { type: 'step-finish', messageID: 'm1', reason: 'tool-calls', tokens: { input: 1200, output: 80 } } });
add('step-start', 'opencode', 'Krok modelu začal', { part: { type: 'step-start', messageID: 'm2' } });
add('step-finish', 'opencode', 'Krok modelu skončil – důvod: stop; tokeny vstup 900, cache 0, výstup 40, myšlení 0',
  { part: { type: 'step-finish', messageID: 'm2', reason: 'stop', tokens: { input: 900, output: 40 } } });
// hlídač smyček: skutečná smyčka 3×, init pluginu 20×, automatická kontrola po editu 4×
for (let i = 0; i < 3; i++) add('guard', 'czek-guard', 'Hlídač: opakovaný příkaz', { msg: 'block: opakovaný příkaz' });
for (let i = 0; i < 20; i++) add('guard', 'czek-guard', 'Hlídač: plugin načten', { msg: 'plugin načten: czek-guard' });
for (let i = 0; i < 4; i++) add('guard', 'czek-guard', 'Hlídač: automatická kontrola po editu', { msg: 'automatická kontrola po editu (cargo check)' });
for (let i = 0; i < 4; i++) add('guard', 'czek-guard', 'Hlídač: poznámka', { msg: 'poznámka modelu k write: czek-guard ran cargo check after this edit' }); // druhá půlka téže kontroly
// hlídač bez modelů se střílí na timeru
for (let i = 0; i < 5; i++) add('watch', 'czek-guard', 'Hlídač: bez modelů (OmniRoute nedostupný)', {});
// souhrn kontroly zdraví vypisuje „timeout“ u cizích modelů – není to selhání žádného volání (23. 11. na Windows)
add('log', 'app', '[omniroute] kontrola zdraví: 20 modelů z čela tierů za 11179 ms, nefunkční 10 (a/b timeout, c/d 400)', {});
// přetečení kontextu: 2× compaction, 1× uříznutý výstup (reason length)
for (let i = 0; i < 2; i++) add('session-status', 'opencode', 'Relace ses_x: kontext zkrácen (compaction)', {});
add('step-finish', 'opencode', 'Krok modelu skončil – důvod: length; tokeny vstup 50000, cache 0, výstup 8192, myšlení 0',
  { part: { type: 'step-finish', messageID: 'mlen', reason: 'length', tokens: { input: 50000, output: 8192 } } });

// ---- B: model s trvalou chybou 500 (musí být doporučen k vyřazení) ----
const B = builder();
B.add('start', 'app', 'Spuštěno', { version: '0.0.0-test' });
B.add('step-start', 'opencode', 'Krok modelu začal', { part: { type: 'step-start', messageID: 'b1' } });
for (let i = 0; i < 6; i++) B.add('call', 'omniroute', 'Volání bad-x: HTTP 500', { model: 'bad-x', status: 500, duration: 1000, error: 'Internal server error' });
B.add('call', 'omniroute', 'Volání bad-x: HTTP 200', { model: 'bad-x', status: 200, duration: 1000 });

// ---- C: skutečně offline (skoro žádný úspěch) → globální poznámka + souhrn, žádné jednotlivé nálezy ----
const C = builder();
C.add('start', 'app', 'Spuštěno', { version: '0.0.0-test' });
C.add('step-start', 'opencode', 'Krok modelu začal', { part: { type: 'step-start', messageID: 'c1' } });
for (let i = 0; i < 6; i++) C.add('call', 'omniroute', 'Volání net-x: HTTP 502', { model: 'net-x', status: 502, duration: 40, error: 'fetch failed (cause: ENOTFOUND getaddrinfo api.z.ai)' });

const logs = path.join(root, 'logs');
const logsB = path.join(root, 'logs-b');
const logsC = path.join(root, 'logs-c');
const outDir = path.join(root, 'report');
const outB = path.join(root, 'report-b');
const outC = path.join(root, 'report-c');
writeDay(logs, A.recs);
writeDay(logsB, B.recs);
writeDay(logsC, C.recs);
fs.writeFileSync(path.join(logs, 'guard.jsonl'), 'nesmí se číst\n', 'utf8'); // není YYYY-MM-DD.jsonl

(async () => {
  // --- A ---
  const res = await generateReport({ dir: logs, days: 1, outDir, now: new Date(base + 3600000) });
  const file = path.join(outDir, day + '.md');
  assert.ok(fs.existsSync(file), 'report .md existuje');
  assert.strictEqual(res.file, file, 'vrácená cesta');
  assert.strictEqual(res.days, 1, 'jeden den');
  const md = fs.readFileSync(file, 'utf8');
  // (a) online relace (dost úspěchů) s dílčími síťovými chybami: glm-x v tabulce i jako nález, bez "vyřadit";
  //     relace NENÍ offline (okAll ≥ práh), takže žádná globální offline poznámka ani souhrnné schování
  assert.ok(md.includes('| chyby | přeruš. |'), 'tabulka odděluje skutečné chyby a závodní přerušení');
  assert.ok(md.includes('| !glm-x | 10 | 2 | 8 | 0 |'), 'glm-x: 8 skutečných chyb, 0 přerušení');
  assert.ok(md.includes('| síť/offline |'), 'hlavní chyba = síť/offline v tabulce');
  assert.ok(md.includes('glm-x: 8/10 chyb (80 %)'), 'glm-x jako skutečný nález (online relace)');
  assert.ok(!md.includes('vyřadit glm-x'), 'síťový výpadek není důvod k vyřazení');
  assert.ok(!md.includes('během relace byla nedostupná síť'), 'relace s dostatkem úspěchů není offline');
  // (a2) přerušeno v závodě (status 0 „aborted") = ne chyba modelu: vlastní sloupec „přeruš.", 0 skutečných chyb, bez nálezu
  assert.ok(md.includes('| beta-x | 4 | 0 | 0 | 4 |'), 'beta-x: 0 chyb, 4 přerušení (poražený v závodě)');
  assert.ok(!md.includes('- POZOR beta-x'), 'poražený v závodě není samostatný nález');
  // (c) interní volání nejsou v tabulce modelů ani v doporučeních
  assert.ok(!md.includes('| connection-test'), 'connection-test není v tabulce');
  assert.ok(!md.includes('vyřadit connection-test') && !md.includes('| model-sync'), 'interní volání bez doporučení');
  assert.ok(md.includes('interní volání czek-ai'), 'interní volání jen v souhrnu');
  // (d) zachované kontroly
  assert.ok(md.includes('cargo build --release') && md.includes('160.0 s'), 'pomalý bash a jeho sekundy');
  assert.ok(md.includes("'ls' 1×"), 'neexistující nástroj ls');
  assert.ok(md.includes('stejný bash 3×'), 'opakovaný příkaz');
  // (e) guardí launch: skutečný příkaz, ne czek_kill boilerplate
  assert.ok(md.includes('npm run tauri dev'), 'report ukazuje skutečný spuštěný příkaz');
  assert.ok(!md.includes('czek_kill'), 'kill-preamble se v reportu neukazuje');
  // (f) nereálný čas (uspání PC): vynecháno, ne hlášeno jako pomalé volání
  assert.ok(md.includes('nereálně dlouhým časem') && md.includes('uspání PC'), 'nereálný čas označen a vynechán');
  assert.ok(!md.includes('4800.0 s') && !md.includes('80.0 min'), 'nafouknutý čas není mezi nejpomalejšími');
  // šum: init pluginu není smyčka, automatická kontrola je informativní, hlídač bez modelů jeden nález
  assert.ok(!md.includes('czek-guard plugin'), 'init pluginu není smyčka');
  assert.ok(md.includes('czek-guard automatická kontrola po editu (4×)'), 'autocheck jako informativní řádek');
  assert.ok(md.includes("hlídač 5× hlásil 'bez modelů'"), 'bez modelů jako jeden nález');
  assert.ok(!md.includes('prázdný výběr'), 'žádný zbytek "prázdný výběr"');
  // start: 10 s po startu, pod prahem → žádný nález
  assert.ok(!md.includes('start → první odpověď'), 'rychlý start se nehlásí');
  // souhrn kontroly zdraví (obsahuje slovo timeout u jiných modelů) se nehlásí jako timeout nástroje
  assert.ok(!md.includes('× timeout'), 'kontrola zdraví není nález „timeout“');
  // klíč: v logu je, v reportu ne
  const keysIn = fs.readFileSync(path.join(logs, day + '.jsonl'), 'utf8').split(FAKE).length - 1;
  assert.ok(keysIn >= 3, 'fixture obsahuje falešný klíč');
  assert.ok(!md.includes(FAKE), 'surový klíč není v reportu');
  const keysOut = md.split('sk-or-***').length - 1;
  assert.ok(keysOut >= 1, 'klíč zamaskován');
  // (g) sekce 7 Kontext: přetečení (compaction) a uříznutý výstup
  assert.ok(md.includes('## 7. Kontext'), 'sekce Kontext');
  assert.ok(md.includes('2× kontext zkrácen (compaction)'), 'compaction započítán');
  assert.ok(md.includes('výstup modelu uříznut'), 'uříznutý výstup (reason length)');
  assert.strictEqual(res.sessions, 1, 'relace = počet start');
  assert.strictEqual(res.steps, 3, 'tři kroky modelu (2 + 1 length)');
  assert.ok(res.findings >= 4, 'nálezy nad prahem');

  // --- B ---
  const resB = await generateReport({ dir: logsB, days: 1, outDir: outB, now: new Date(base + 3600000) });
  const mdB = fs.readFileSync(resB.file, 'utf8');
  // (b) trvalá chyba 500 ≥5× → doporučeno vyřadit; bez poznámky o síti
  assert.ok(mdB.includes('bad-x: 6/7 chyb'), 'chyby bad-x');
  assert.ok(mdB.includes('vyřadit bad-x z combo'), 'trvale chybný model se doporučí k vyřazení');
  assert.ok(!mdB.includes('nedostupná síť'), 'bez výpadku sítě se žádná poznámka neobjeví');

  // --- C: skutečně offline (0 úspěchů) → globální poznámka + souhrn, žádné jednotlivé modely jako nálezy ---
  const resC = await generateReport({ dir: logsC, days: 1, outDir: outC, now: new Date(base + 3600000) });
  const mdC = fs.readFileSync(resC.file, 'utf8');
  assert.ok(mdC.includes('během relace byla nedostupná síť'), 'offline relace → globální poznámka');
  assert.ok(mdC.includes('neuvádím jako nálezy (ověřit online): net-x'), 'offline modely jen souhrnně');
  assert.ok(!mdC.includes('- POZOR net-x:'), 'offline model není samostatný nález');

  console.log(`self-report OK (relace ${res.sessions}, kroky ${res.steps}, nálezy ${res.findings}; klíče v logu ${keysIn}, v reportu 0, zamaskováno ${keysOut}; výpadek/přerušení/trvalá chyba rozlišeny, offline jen při málu úspěchů)`);
  fs.rmSync(root, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
