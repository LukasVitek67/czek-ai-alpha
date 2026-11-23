// Diagnostika: záznam požadavků (zápis, čtení konce, rotace), statistiky modelů, rozbor konverzace OpenCode.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const d = require('../src/diagnostics');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdarma-diag-'));
const write = d.traceWriter(dir);
const now = Date.now();
write({ at: now - 1000, requested: 'max', ok: true, model: 'kilo/a', ms: 2000, attempts: [{ model: 'kilo/a', ok: true, inTok: 100, outTok: 10, toolCalls: 1, fixedArgs: 2 }] });
write({ at: now - 900, requested: 'max', ok: true, model: 'kilo/a', ms: 4000, attempts: [{ model: 'kilo/a', ok: true, inTok: 200, outTok: 20, toolCalls: 0 }] });
write({ at: now - 800, requested: 'high', ok: false, error: 'limit', model: 'nvidia/b', attempts: [] });
write({ at: now - 48 * 3600 * 1000, requested: 'max', ok: true, model: 'old/c', ms: 1, attempts: [] });
const recs = d.readTrace(dir, 10);
assert.strictEqual(recs.length, 4);
const st = d.modelStats(recs, now);
const a = st.find((x) => x.model === 'kilo/a');
assert.deepStrictEqual([a.requests, a.ok, a.tokIn, a.tokOut, a.tools, a.fixedArgs, a.medianMs], [2, 2, 300, 30, 1, 2, 2000]);
assert.strictEqual(st.find((x) => x.model === 'nvidia/b').failed, 1);
assert.ok(!st.find((x) => x.model === 'old/c'), 'starší než 24 h se nepočítá');
const f = d.findings({ stats: [{ model: 'x', requests: 4, failed: 3, ok: 1, medianMs: 50000, fixedArgs: 1 }], sessionsList: [{ title: 'T', tokensIn: 3e6, directory: 'C:/u/Documents/Claude code' }], sizes: {}, health: { proxy: { running: false } } });
const keys = f.map((x) => x.key);
for (const k of ['diag.fModelFails', 'diag.fModelSlow', 'diag.fFixedArgs', 'diag.fHugeSession', 'diag.fParentDir', 'diag.fProxyDown']) assert.ok(keys.includes(k), k);

// rozbor konverzace na malé testovací databázi ve tvaru OpenCode
const { DatabaseSync } = require('node:sqlite');
const dbf = path.join(dir, 'opencode.db');
const db = new DatabaseSync(dbf);
db.exec("create table session (id text, title text, directory text, parent_id text, time_created int, time_updated int, tokens_input int, tokens_output int, tokens_reasoning int, tokens_cache_read int, model text); create table message (id text, session_id text, time_created int, data text); create table part (id text, message_id text, session_id text, time_created int, data text);");
db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?)').run('s1', 'Test', 'C:/p', null, 1, 2, 500, 50, 0, 0, '{"id":"max"}');
db.prepare('insert into message values (?,?,?,?)').run('m1', 's1', 1, '{"role":"user"}');
db.prepare('insert into part values (?,?,?,?,?)').run('p1', 'm1', 's1', 1, '{"type":"text","text":"udělej to"}');
for (let i = 2; i <= 5; i++) {
  db.prepare('insert into message values (?,?,?,?)').run('m' + i, 's1', i, JSON.stringify({ role: 'assistant', providerID: 'zdarma', modelID: 'max', time: { created: i * 1000, completed: i * 1000 + 500 }, tokens: { input: 10, output: 5, cache: { read: 0 } }, finish: 'tool-calls' }));
  db.prepare('insert into part values (?,?,?,?,?)').run('p' + i, 'm' + i, 's1', i, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: i === 5 ? 'error' : 'completed', input: { command: 'cargo check' }, error: 'boom' } }));
}
db.close();
const ses = d.sessions(dbf);
assert.strictEqual(ses.list[0].toolCalls, 4);
assert.strictEqual(ses.list[0].toolErrors, 1);
const det = d.sessionDetail('s1', dbf);
assert.strictEqual(det.summary.steps, 4);
assert.strictEqual(det.summary.loops[0].count, 4, 'stejné volání 4× = smyčka');
assert.strictEqual(det.summary.toolErr.bash, 1);
assert.strictEqual(det.summary.medianStepMs, 500);
console.log('diagnostics OK');
