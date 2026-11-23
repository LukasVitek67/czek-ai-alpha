'use strict';
// Data jako 'YYYY-MM-DD', počítá se v UTC (žádné časové zóny ani letní čas).

// Státní svátky ČR s pevným datem (MM-DD) + Velký pátek a Velikonoční pondělí pro roky, které knihovna používá.
const FIXED_HOLIDAYS = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26'];
const EASTER = { 2025: ['04-18', '04-21'], 2026: ['04-03', '04-06'], 2027: ['03-26', '03-29'] };

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new Error(`neplatné datum ${s}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1) throw new Error(`neplatné datum ${s}`);
  return d;
}
const formatDate = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return formatDate(d); };
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isWeekend = (s) => { const w = parseDate(s).getUTCDay(); return w === 0 || w === 6; };
function isHoliday(s) {
  const md = s.slice(5);
  return FIXED_HOLIDAYS.includes(md) || (EASTER[s.slice(0, 4)] || []).includes(md);
}
const isBusinessDay = (s) => !isWeekend(s) && !isHoliday(s);
/** Počet pracovních dní v intervalu (from, to] – tedy bez prvního dne, s posledním. */
function businessDaysBetween(from, to) {
  let n = 0;
  for (let d = addDays(from, 1); compare(d, to) <= 0; d = addDays(d, 1)) if (isBusinessDay(d)) n++;
  return n;
}

module.exports = { parseDate, formatDate, addDays, compare, isWeekend, isHoliday, isBusinessDay, businessDaysBetween, FIXED_HOLIDAYS };
