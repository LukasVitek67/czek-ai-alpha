'use strict';
const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/utils/dates');

test('addDays across months and years', () => {
  assert.strictEqual(d.addDays('2026-01-25', 14), '2026-02-08');
  assert.strictEqual(d.addDays('2026-12-25', 14), '2027-01-08');
});
test('invalid dates throw', () => {
  assert.throws(() => d.parseDate('2026-02-30'), /neplatné datum/);
  assert.throws(() => d.parseDate('5. 1. 2026'), /neplatné datum/);
});
test('weekends and Czech holidays are not business days', () => {
  assert.strictEqual(d.isBusinessDay('2026-01-10'), false); // sobota
  assert.strictEqual(d.isBusinessDay('2026-10-28'), false); // státní svátek
  assert.strictEqual(d.isBusinessDay('2026-04-06'), false); // Velikonoční pondělí
  assert.strictEqual(d.isBusinessDay('2026-10-29'), true);
});
test('business days between (exclusive start, inclusive end)', () => {
  assert.strictEqual(d.businessDaysBetween('2026-01-09', '2026-01-12'), 1); // pá → po
  assert.strictEqual(d.businessDaysBetween('2026-01-05', '2026-01-05'), 0);
  assert.strictEqual(d.businessDaysBetween('2026-12-23', '2026-12-28'), 1); // 24.–27. svátky a víkend, 28. po
});
