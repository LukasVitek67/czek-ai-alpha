'use strict';
/** ISBN-13 bez pomlček a mezer, nebo null. */
function normalizeIsbn(s) {
  const d = String(s || '').replace(/[-\s]/g, '');
  return /^\d{13}$/.test(d) ? d : null;
}
/** Kontrolní číslice ISBN-13 (váhy 1,3,1,3…). */
function validIsbn13(s) {
  const d = normalizeIsbn(s);
  if (!d) return false;
  const sum = [...d.slice(0, 12)].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(d[12]);
}
module.exports = { normalizeIsbn, validIsbn13 };
