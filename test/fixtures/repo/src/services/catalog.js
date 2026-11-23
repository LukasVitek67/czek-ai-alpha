'use strict';
const { makeBook } = require('../models/book');
const { normalizeIsbn } = require('../utils/isbn');
const { includesText } = require('../utils/text');

function createCatalog(store) {
  const books = () => store.data.books;
  return {
    addBook(b) {
      const book = makeBook(b);
      if (books().some((x) => x.isbn === book.isbn)) throw new Error(`kniha ${book.isbn} už v katalogu je`);
      books().push(book); store.save();
      return book;
    },
    getBook(isbn) { const i = normalizeIsbn(isbn); return books().find((b) => b.isbn === i) || null; },
    /** Hledání v názvu a autorovi. */
    findBooks(query) {
      const q = String(query || '').trim();
      if (!q) return [];
      return books().filter((b) => includesText(b.title, q) || includesText(b.author, q))
        .sort((a, b) => a.title.localeCompare(b.title, 'cs'));
    },
    /** Kolik výtisků je teď volných. */
    available(isbn) {
      const b = this.getBook(isbn);
      if (!b) return 0;
      return b.copies - store.data.loans.filter((l) => l.isbn === b.isbn && !l.returned).length;
    },
  };
}
module.exports = { createCatalog };
