'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { overlaps, conflicts, freeSlots } = require('../src/timetable');

const L = (day, start, end, subject = 'x') => ({ day, start, end, subject, room: '1' });

test('overlapping lessons on the same day', () => {
  assert.strictEqual(overlaps(L('po', '08:00', '08:45'), L('po', '08:30', '09:15')), true);
});
test('adjacent lessons do not overlap', () => {
  assert.strictEqual(overlaps(L('po', '08:00', '08:45'), L('po', '08:45', '09:30')), false);
});
test('different days never overlap', () => {
  assert.strictEqual(overlaps(L('po', '08:00', '09:00'), L('út', '08:00', '09:00')), false);
});
test('one lesson inside another overlaps', () => {
  assert.strictEqual(overlaps(L('st', '08:00', '12:00'), L('st', '09:00', '09:45')), true);
});
test('conflicts lists index pairs', () => {
  const ls = [L('po', '08:00', '08:45'), L('po', '08:45', '09:30'), L('po', '09:00', '09:45'), L('út', '09:00', '09:45')];
  assert.deepStrictEqual(conflicts(ls), [[1, 2]]);
});
test('free slots between lessons, from 08:00 to 16:00', () => {
  const ls = [L('čt', '09:00', '10:00'), L('čt', '08:00', '08:45'), L('čt', '10:00', '11:00'), L('pá', '08:00', '16:00')];
  assert.deepStrictEqual(freeSlots(ls, 'čt'), [{ start: '08:45', end: '09:00' }, { start: '11:00', end: '16:00' }]);
  assert.deepStrictEqual(freeSlots(ls, 'pá'), []);
  assert.deepStrictEqual(freeSlots(ls, 'po'), [{ start: '08:00', end: '16:00' }]);
});
test('free slots with overlapping lessons', () => {
  const ls = [L('st', '08:00', '10:00'), L('st', '09:00', '09:30'), L('st', '12:00', '13:00')];
  assert.deepStrictEqual(freeSlots(ls, 'st'), [{ start: '10:00', end: '12:00' }, { start: '13:00', end: '16:00' }]);
});
test('unknown day throws', () => {
  assert.throws(() => freeSlots([], 'so'));
});
