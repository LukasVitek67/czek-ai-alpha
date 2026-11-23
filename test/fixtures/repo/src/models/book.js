'use strict';
const { normalizeIsbn, validIsbn13 } = require('../utils/isbn');

/** Kniha v katalogu. copies = kolik výtisků knihovna má. */
function makeBook({ isbn, title, author, year, copies = 1 }) {
  const i = normalizeIsbn(isbn);
  if (!i || !validIsbn13(i)) throw new Error(`neplatné ISBN ${isbn}`);
  if (!String(title || '').trim()) throw new Error('kniha musí mít název');
  if (!Number.isInteger(copies) || copies < 1) throw new Error(`neplatný počet výtisků ${copies}`);
  return { isbn: i, title: String(title).trim(), author: String(author || '').trim(), year: year ?? null, copies };
}
module.exports = { makeBook };
