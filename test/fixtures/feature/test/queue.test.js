const test = require('node:test');
const assert = require('node:assert');
const { Queue } = require('../src/queue');

const ids = [1, 2, 3, 4, 5];

test('starts at the first track; next/previous walk the list', () => {
  const q = new Queue(ids);
  assert.strictEqual(q.current, 1);
  assert.strictEqual(q.next(), 2);
  assert.strictEqual(q.next(), 3);
  assert.strictEqual(q.previous(), 2);
  assert.strictEqual(q.current, 2);
});

test('repeat off: next at the end returns null and stays; previous at the start stays', () => {
  const q = new Queue(ids);
  assert.strictEqual(q.previous(), 1);
  q.jump(4);
  assert.strictEqual(q.current, 5);
  assert.strictEqual(q.next(), null);
  assert.strictEqual(q.current, 5);
});

test('repeat all wraps around both ways; repeat one keeps the track', () => {
  const q = new Queue(ids);
  q.repeat = 'all';
  q.jump(4);
  assert.strictEqual(q.next(), 1);
  assert.strictEqual(q.previous(), 5);
  q.repeat = 'one';
  assert.strictEqual(q.next(), 5);
  assert.throws(() => { q.repeat = 'sometimes'; }, /repeat/i);
});

test('shuffle: deterministic with a seed, keeps current first, plays each track once', () => {
  const a = new Queue(ids, { seed: 42 });
  const b = new Queue(ids, { seed: 42 });
  a.next(); b.next(); // current = 2
  a.shuffle(true); b.shuffle(true);
  assert.deepStrictEqual(a.order(), b.order(), 'same seed, same order');
  assert.strictEqual(a.current, 2);
  assert.strictEqual(a.order()[0], 2, 'current track stays first');
  assert.deepStrictEqual([...a.order()].sort(), ids, 'every track exactly once');
  const c = new Queue(ids, { seed: 7 });
  c.next(); c.shuffle(true);
  assert.notDeepStrictEqual(c.order(), a.order(), 'different seed, different order');
  const seen = [a.current];
  while (a.next() !== null) seen.push(a.current);
  assert.deepStrictEqual([...seen].sort(), ids);
});

test('shuffle off restores the original order at the current track', () => {
  const q = new Queue(ids, { seed: 3 });
  q.jump(2); // current = 3
  q.shuffle(true);
  q.next();
  const cur = q.current;
  q.shuffle(false);
  assert.deepStrictEqual(q.order(), ids);
  assert.strictEqual(q.current, cur);
  assert.strictEqual(q.next(), cur === 5 ? null : cur + 1);
});

test('add / removeAt keep the current track playing', () => {
  const q = new Queue([10, 20, 30]);
  q.next(); // 20
  q.add(40);
  assert.deepStrictEqual(q.order(), [10, 20, 30, 40]);
  q.removeAt(0);
  assert.strictEqual(q.current, 20);
  q.removeAt(q.order().indexOf(20)); // removing the current track moves to the next one
  assert.strictEqual(q.current, 30);
  assert.deepStrictEqual(q.order(), [30, 40]);
});
