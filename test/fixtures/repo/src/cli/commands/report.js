'use strict';
module.exports = {
  overdue: {
    usage: 'overdue [datum]', min: 0, max: 1,
    run([date], { lib, today }) {
      const d = date || today;
      const list = lib.loans.overdue(d);
      if (!list.length) return { code: 0, out: 'nic po termínu' };
      return { code: 0, out: list.map((l) => `${l.memberId}: ${lib.catalog.getBook(l.isbn)?.title || l.isbn} (termín ${l.due})`).join('\n') };
    },
  },
};
