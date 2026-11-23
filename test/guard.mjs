// czek-guard: jádro detekce smyček (src/guard/guard-core.mjs). Scénáře podle skutečných případů.
import assert from 'node:assert';
import { Guard } from '../src/guard/guard-core.mjs';

// S1: 10× stejný read se stejným výsledkem → poznámka po 3., blok nejpozději u 5. volání
{
  const g = new Guard();
  const a = { filePath: 'C:/p/src/app.rs' };
  let noted = 0, blockedAt = 0;
  for (let i = 1; i <= 10 && !blockedAt; i++) {
    if (g.before('read', a)) { blockedAt = i; break; }
    if (g.after('read', a, 'same content')) noted = noted || i;
  }
  assert.strictEqual(noted, 3, 'note at 3rd identical call');
  assert.strictEqual(blockedAt, 5, 'blocked at 5th identical call');
}
// S1 polling: stejný build, ale výstup se mění → žádný blok
{
  const g = new Guard();
  const a = { command: 'npm run build 2>&1 | tail -40' };
  for (let i = 1; i <= 10; i++) { assert.strictEqual(g.before('bash', a), null); g.after('bash', a, 'out ' + i); }
}
// čekání na log (sleep; tail) se nepočítá vůbec
{
  const g = new Guard();
  const a = { command: 'sleep 30; tail -20 build.log' };
  for (let i = 1; i <= 8; i++) { assert.strictEqual(g.before('bash', a), null); assert.strictEqual(g.after('bash', a, 'Compiling'), ''); }
}
// S6 (živý případ 12. 11.): edit app.rs +1 −1 → cargo check | head -20 → … dokola
{
  const g = new Guard();
  const notes = [];
  for (let i = 1; i <= 6; i++) {
    notes.push(g.after('edit', { filePath: 'C:\\p\\src\\app.rs', oldString: 'let a = ' + i + ';', newString: 'let a: u32 = ' + i + ';' }, 'Edit applied'));
    notes.push(g.after('bash', { command: 'cargo check 2>&1 | head -20' }, 'error[E0' + i + ']: something'));
  }
  const all = notes.join('\n');
  const firstTiny = notes.findIndex((n) => /one-line edit of app\.rs/.test(n));
  assert.strictEqual(firstTiny, 4, 'tiny-edit note on the 3rd small edit: ' + firstTiny);
  assert.match(all, /output cut to 20 lines/, 'truncated check note');
  assert.ok((all.match(/one-line edit/g) || []).length <= 2, 'not on every edit');
}
// S6b (živě 13. 11.: cargo check 2>&1 | head -30): příkaz se rozšíří ještě před spuštěním
{
  const g = new Guard();
  const a = { command: 'cd /c/p && cargo check 2>&1 | head -30' };
  assert.strictEqual(g.widen('bash', a), true);
  assert.strictEqual(a.command, 'cd /c/p && cargo check --message-format=short 2>&1 | head -200');
  assert.match(g.after('bash', a, 'src/app.rs:1:1: error: x'), /widened this command \(output was cut to 30 lines/);
  const b = { command: 'npx tsc --noEmit | head -n 20' };
  assert.strictEqual(g.widen('bash', b), true);
  assert.strictEqual(b.command, 'npx tsc --noEmit | head -200');
  for (const cmd of ['git log | head -5', 'cargo check 2>&1 | head -300', 'cargo check --message-format=json | head -10']) {
    const c = { command: cmd };
    const changed = g.widen('bash', c);
    if (cmd.includes('json')) assert.strictEqual(c.command, 'cargo check --message-format=json | head -200');
    else assert.strictEqual(changed, false, cmd);
  }
  assert.strictEqual(g.widen('read', { filePath: 'x' }), false);
}
// velké edity různých souborů → nic
{
  const g = new Guard();
  for (let i = 1; i <= 6; i++) assert.strictEqual(g.after('edit', { filePath: 'f' + i + '.rs', oldString: 'a\nb\nc\nd\ne', newString: 'x\ny\nz\nw\nv\nq' }, 'ok'), '');
}
// ping-pong A-B-A-B
{
  const g = new Guard();
  const A = { command: 'ls src' }, B = { command: 'ls target' };
  let out = '';
  for (let i = 0; i < 3; i++) { out += g.after('bash', A, 'a' + i); out += g.after('bash', B, 'b' + i); }
  assert.match(out, /alternating between the same two calls/);
}
// #25254: nepovedené edity téhož souboru prokládané jinými voláními → po 3 blok, read ho uvolní
{
  const g = new Guard();
  const f = 'C:/p/src/app.ts';
  for (let i = 1; i <= 3; i++) {
    const a = { filePath: f, oldString: 'const x = ' + i, newString: 'const x: number = ' + i };
    assert.strictEqual(g.before('edit', a), null, 'edit ' + i + ' allowed');
    g.fail('edit', a, 'Could not find oldString in the file.');
    g.after('bash', { command: 'npm test ' + i }, 'fail ' + i); // jiná práce mezi tím
  }
  const blocked = g.before('edit', { filePath: f, oldString: 'y', newString: 'z' });
  assert.match(blocked, /3 edits of app\.ts have failed.*Read app\.ts again/s);
  assert.strictEqual(g.before('edit', { filePath: 'C:/p/src/other.ts', oldString: 'y', newString: 'z' }), null, 'other file not blocked');
  g.after('read', { filePath: f }, '1: const x = 5');
  assert.strictEqual(g.before('edit', { filePath: f, oldString: 'y', newString: 'z' }), null, 'read unblocks');
  // vlastní blok guardu se jako další selhání nepočítá
  g.fail('edit', { filePath: f }, 'Error: Blocked by czek-guard: …');
  assert.strictEqual(g.failed.get('app.ts') ?? 0, 0);
}
// 5 stejných NEPOVEDENÝCH editů (after se u chyby nevolá) → blok jako u stejného výsledku
{
  const g = new Guard();
  const a = { filePath: 'x.rs', oldString: 'a', newString: 'b' };
  let blockedAt = 0;
  for (let i = 1; i <= 8 && !blockedAt; i++) {
    if (g.before('edit', a)) { blockedAt = i; break; }
    g.fail('edit', a, 'Could not find oldString');
    g.failed.clear(); // izolovat pravidlo stejného vstupu od pravidla selhání souboru
  }
  assert.strictEqual(blockedAt, 5, 'identical failing call blocked at 5th: ' + blockedAt);
}
// +1 −1 tam a zpět
{
  const g = new Guard();
  const f = 'src/app.rs';
  assert.strictEqual(g.after('edit', { filePath: f, oldString: 'let a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;', newString: 'let a: u8 = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;' }, 'ok'), '');
  const n = g.after('edit', { filePath: f, oldString: 'let a: u8 = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;', newString: 'let a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;' }, 'ok');
  assert.match(n, /undoes one of your earlier edits of app\.rs/);
}
// mnoho editů téhož souboru za úkol (velké, různé) → poznámka u 8.; nová zpráva uživatele nuluje
{
  const g = new Guard();
  const big = (i) => ({ filePath: 'App.svelte', oldString: `a${i}\nb\nc\nd\ne`, newString: `x${i}\ny\nz\nw\nv` });
  const notes = [];
  for (let i = 1; i <= 8; i++) notes.push(g.after('edit', big(i), 'ok'));
  assert.strictEqual(notes.findIndex((n) => /changed App\.svelte 8 times/.test(n)), 7);
  g.userTurn();
  for (let i = 9; i <= 12; i++) assert.doesNotMatch(g.after('edit', big(i), 'ok'), /times for this request/);
}
// todowrite: krátké potvrzení místo celého JSON, 4. za sebou bez práce → blok, jiná práce nuluje
{
  const g = new Guard();
  const todos = [{ content: 'Fix blank window', status: 'in_progress' }, { content: 'Add tests', status: 'pending' }, { content: 'Setup', status: 'completed' }];
  const s = g.shrink('todowrite', { todos }, JSON.stringify(todos, null, 2));
  assert.match(s, /3 items: 1 completed, 1 in progress, 1 pending/);
  assert.match(s, /Work on: "Fix blank window"/);
  assert.strictEqual(g.shrink('read', { filePath: 'a' }, 'x'), null);
  assert.strictEqual(new Guard({ todoShrink: false }).shrink('todowrite', { todos }, 'x'), null);
  for (let i = 1; i <= 3; i++) { assert.strictEqual(g.before('todowrite', { todos }), null); g.after('todowrite', { todos }, s + i); }
  assert.match(g.before('todowrite', { todos }), /todowrite was called 3 times in a row/);
  g.after('read', { filePath: 'a.js' }, 'x');
  assert.strictEqual(g.before('todowrite', { todos }), null, 'work in between resets');
}
console.log('guard OK');
