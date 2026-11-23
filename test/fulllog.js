// Jádro úplného logu (src/fullLog.js): klíče zamaskované, text a myšlení modelu celé a jen jednou (ne každý
// průběžný kousek), nástroj ve všech stavech s celým vstupem/výstupem, důvody chyb a opakování, sledování
// jiného souboru.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FullLog, collapseConsole } = require('../src/fullLog');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-fulllog-'));
const secret = 'my-private-key-value-123456';
const L = new FullLog({ dir, secrets: () => [secret] });
const ev = (type, properties) => L.ocEvent({ directory: 'C:\\p', payload: { type, properties } });
const long = 'x'.repeat(20000);

ev('message.updated', { info: { id: 'm1', sessionID: 's1', role: 'assistant', providerID: 'opencode-omniroute', modelID: 'zdarma-max', time: { created: 1 } } });
ev('message.part.updated', { part: { id: 'r1', messageID: 'm1', sessionID: 's1', type: 'reasoning', text: 'thinking...' } });
ev('message.part.updated', { part: { id: 'r1', messageID: 'm1', sessionID: 's1', type: 'reasoning', text: 'thinking about the borrow error ' + long, time: { start: 1, end: 2 } } });
ev('message.part.delta', { delta: 'ignored' });
for (const status of ['pending', 'running', 'running', 'completed']) {
  ev('message.part.updated', { part: { id: 't1', messageID: 'm1', sessionID: 's1', type: 'tool', tool: 'bash', state: { status, input: { command: 'cargo check' }, output: status === 'completed' ? 'error[E0502] ' + long : undefined, time: { start: 1, end: 5 } } } });
}
ev('message.part.updated', { part: { id: 't2', messageID: 'm1', sessionID: 's1', type: 'tool', tool: 'edit', state: { status: 'error', input: { filePath: 'a.rs' }, error: 'Could not find oldString' } } });
ev('message.part.updated', { part: { id: 'f1', messageID: 'm1', sessionID: 's1', type: 'step-finish', reason: 'tool-calls', tokens: { input: 1200, output: 80, reasoning: 30, cache: { read: 50000 } } } });
ev('session.status', { sessionID: 's1', status: { type: 'retry', attempt: 3, message: '[529] overloaded', next: Date.now() + 7000 } });
ev('message.updated', { info: { id: 'm1', sessionID: 's1', role: 'assistant', providerID: 'opencode-omniroute', modelID: 'zdarma-max', time: { created: 1, completed: 900 }, finish: 'stop', tokens: { input: 1200, output: 80, cache: { read: 50000 } } } });
L.write('app', 'ipc', 'akce s klíčem', { key: secret, other: 'sk-or-v1-' + 'a'.repeat(40) });

// Šumové události: heartbeat, sync, opakovaný plugin.added, prázdný session.diff → jen počty v souhrnu.
for (let i = 0; i < 30; i++) ev('server.heartbeat', {});
for (let i = 0; i < 5; i++) ev('sync', { dir: 'C:\\p' });
ev('plugin.added', { id: 'agent', dir: 'C:\\p' });
ev('plugin.added', { id: 'agent', dir: 'C:\\p' });
ev('plugin.added', { id: 'agent', dir: 'C:\\p' });
ev('plugin.added', { id: 'skill', dir: 'C:\\p' });
for (let i = 0; i < 4; i++) ev('session.diff', { sessionID: 's1', diff: [] });
ev('session.diff', { sessionID: 's1', diff: [{ file: 'a.rs', additions: 3 }] });
// Konzolové šumy: stejně jako main.js – řádek se zapíše jen když collapseConsole nevrátí 'repeat'.
const consoleLines = [
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop completed with undelivered notifications.',
  'The powerPreference option is currently ignored when calling getContext()',
  'The powerPreference option is currently ignored when calling getContext()',
  'obyčejná zpráva z konzole',
];
const consoleResults = consoleLines.map((m) => {
  const r = collapseConsole(m);
  if (r !== 'repeat') L.write('app', 'console', m);
  return r;
});

const other = path.join(dir, 'other.log');
fs.writeFileSync(other, 'old line\n');
L.follow(other, 'omniroute', 'proces', (l) => 'OmniRoute: ' + l);
fs.appendFileSync(other, 'new line A\n{"msg":"json line"}\n');

setTimeout(() => {
  L.stop();
  const raw = fs.readFileSync(L.file(), 'utf8');
  const recs = raw.trim().split('\n').map((l) => JSON.parse(l));
  const by = (k) => recs.filter((r) => r.kind === k);
  assert.strictEqual(by('thinking').length, 1, 'reasoning written once (final)');
  assert.ok(by('thinking')[0].msg.includes(long), 'full reasoning text, not cut');
  assert.deepStrictEqual(by('tool-pending').length + by('tool-running').length + by('tool-completed').length, 3, 'each tool state once');
  assert.ok(by('tool-completed')[0].data.part.state.output.includes(long), 'full tool output');
  assert.match(by('tool-error')[0].msg, /SELHAL: edit a\.rs – důvod: Could not find oldString/);
  assert.match(by('step-finish')[0].msg, /důvod: tool-calls; tokeny vstup 1200, cache 50000, výstup 80, myšlení 30/);
  assert.match(by('session-status')[0].msg, /pokus 3.*důvod: \[529\] overloaded/);
  assert.match(by('message-done')[0].msg, /hotová za 899 ms – konec: stop/);
  assert.ok(!recs.some((r) => r.msg === 'ignored' || JSON.stringify(r).includes('"delta":"ignored"')), 'deltas skipped');
  assert.ok(!raw.includes(secret), 'stored key masked');
  assert.ok(!/sk-or-v1-a{40}/.test(raw), 'key pattern masked');
  assert.ok(by('proces').some((r) => r.msg === 'OmniRoute: new line A') && !by('proces').some((r) => /old line/.test(r.msg)), 'follow: only new lines');
  assert.ok(by('proces').some((r) => r.data?.msg === 'json line'), 'follow: JSON lines parsed');
  // šum: nic z něj se nezapsalo po řádku
  assert.strictEqual(by('event').filter((r) => /server\.heartbeat|: sync$/.test(r.msg)).length, 0, 'heartbeat and sync not written per row');
  const plug = by('event').filter((r) => r.msg.endsWith('plugin.added'));
  assert.deepStrictEqual(plug.map((r) => r.data.id), ['agent', 'skill'], 'first plugin.added per plugin+dir kept, duplicate dropped');
  const diffs = by('event').filter((r) => r.msg.endsWith('session.diff'));
  assert.strictEqual(diffs.length, 1, 'only non-empty session.diff written');
  assert.strictEqual(diffs[0].data.diff.length, 1, 'non-empty diff kept whole');
  // konzole: první výskyt zapsán, opakování jen počítána
  assert.deepStrictEqual(consoleResults, ['first', 'repeat', 'repeat', 'first', 'repeat', null], 'console collapse');
  assert.strictEqual(raw.split('ResizeObserver loop completed').length - 1, 1, 'ResizeObserver written once');
  assert.strictEqual(raw.split('powerPreference option is currently ignored').length - 1, 1, 'powerPreference written once');
  assert.ok(raw.includes('obyčejná zpráva z konzole'), 'normal console line kept');
  // souhrn: jeden řádek event-repeats s počty (zapsán při stop)
  const rep = by('event-repeats');
  assert.strictEqual(rep.length, 1, 'one summary row');
  const c = rep[0].data.counts;
  assert.strictEqual(c['server.heartbeat'], 30, 'heartbeat counted');
  assert.strictEqual(c.sync, 5, 'sync counted');
  assert.strictEqual(rep[0].data.detail.sync['C:\\p'], 5, 'sync per dir');
  assert.strictEqual(c['plugin.added opakovaně'], 2, 'duplicate plugin.added counted');
  assert.strictEqual(c['session.diff prázdný'], 4, 'empty session.diff counted');
  assert.strictEqual(c['konzole: ResizeObserver loop'], 2, 'ResizeObserver repeats counted');
  assert.strictEqual(c['konzole: powerPreference ignored'], 1, 'powerPreference repeats counted');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`fulllog OK (${recs.length} záznamů: myšlení celé 1×, nástroj ve 3 stavech, důvody chyb, klíče zamaskované)`);
}, 2600);
