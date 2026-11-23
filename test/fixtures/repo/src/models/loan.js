'use strict';
const { parseDate } = require('../utils/dates');

let seq = 0;
/** Výpůjčka: kdo, co, kdy, do kdy. returned = datum vrácení (null = půjčeno). */
function makeLoan({ id, memberId, isbn, date, due }) {
  parseDate(date); parseDate(due);
  return { id: id || `L${Date.now().toString(36)}${(seq++).toString(36)}`, memberId, isbn, date, due, returned: null };
}
module.exports = { makeLoan };
