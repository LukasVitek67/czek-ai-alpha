'use strict';
// Rozvrh: hodina = { day: 'po'|'út'|'st'|'čt'|'pá', start: 'HH:MM', end: 'HH:MM', subject, room }.
const DAYS = ['po', 'út', 'st', 'čt', 'pá'];

const toMin = (t) => {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) throw new Error(`bad time ${t}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Překrývají se dvě hodiny? */
function overlaps(a, b) {
  if (a.day !== b.day) return false;
  return toMin(a.start) <= toMin(b.end) && toMin(b.start) <= toMin(a.end);
}

/** Všechny dvojice hodin, které se překrývají, jako [i, j] indexy, i < j. */
function conflicts(lessons) {
  const out = [];
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) if (overlaps(lessons[i], lessons[j])) out.push([i, j]);
  }
  return out;
}

module.exports = { DAYS, overlaps, conflicts, toMin };
