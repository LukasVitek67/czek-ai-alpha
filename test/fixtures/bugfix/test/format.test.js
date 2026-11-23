const test = require('node:test');
const assert = require('node:assert');
const { formatDuration, totalDuration } = require('../src/format');

test('formát délky m:ss', () => {
  assert.strictEqual(formatDuration(185), '3:05');
  assert.strictEqual(formatDuration(60), '1:00');
  assert.strictEqual(formatDuration(3725), '62:05');
});
test('celková délka', () => {
  assert.strictEqual(totalDuration([{ duration: 30 }, { duration: 45 }]), '1:15');
});
