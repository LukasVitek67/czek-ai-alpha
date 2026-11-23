'use strict';
/** Text pro porovnávání a hledání: malá písmena, bez diakritiky, jedna mezera. */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
const includesText = (hay, needle) => normalize(hay).includes(normalize(needle));
module.exports = { normalize, includesText };
