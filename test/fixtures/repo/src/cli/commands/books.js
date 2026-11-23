'use strict';
module.exports = {
  'add-book': {
    usage: 'add-book <isbn> <název> <autor> [výtisků]', min: 3, max: 4,
    run([isbn, title, author, copies], { lib }) {
      const b = lib.catalog.addBook({ isbn, title, author, copies: copies === undefined ? 1 : Number(copies) });
      return { code: 0, out: `přidána kniha ${b.title} (${b.isbn})` };
    },
  },
  search: {
    usage: 'search <text>', min: 1, max: 9,
    run(words, { lib }) {
      const found = lib.catalog.findBooks(words.join(' '));
      if (!found.length) return { code: 0, out: 'nic nenalezeno' };
      return { code: 0, out: found.map((b) => `${b.title} – ${b.author} (${lib.catalog.available(b.isbn)}/${b.copies} volných)`).join('\n') };
    },
  },
};
