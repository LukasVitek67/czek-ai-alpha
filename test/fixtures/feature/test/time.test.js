const test = require('node:test');
const assert = require('node:assert');
const { formatDuration, parseDuration } = require('../src/time');

test('formatDuration: m:ss under an hour, h:mm:ss above', () => {
  assert.strictEqual(formatDuration(0), '0:00');
  assert.strictEqual(formatDuration(5), '0:05');
  assert.strictEqual(formatDuration(65), '1:05');
  assert.strictEqual(formatDuration(599.9), '9:59'); // fractions are floored
  assert.strictEqual(formatDuration(3600), '1:00:00');
  assert.strictEqual(formatDuration(3725), '1:02:05');
});

test('formatDuration: invalid input gives --:--', () => {
  for (const v of [-1, NaN, undefined, null, 'abc', Infinity]) assert.strictEqual(formatDuration(v), '--:--', String(v));
});

test('parseDuration: m:ss, h:mm:ss and plain seconds', () => {
  assert.strictEqual(parseDuration('3:05'), 185);
  assert.strictEqual(parseDuration('1:02:05'), 3725);
  assert.strictEqual(parseDuration('42'), 42);
  assert.strictEqual(parseDuration(' 0:07 '), 7);
});

test('parseDuration: rejects malformed values with null', () => {
  for (const v of ['', '1:60', '1:2', 'a:bc', '1:00:60', '-1:00', ':30', null]) assert.strictEqual(parseDuration(v), null, String(v));
});
