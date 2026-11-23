'use strict';
const { makeLoan } = require('../models/loan');
const { addDays, compare } = require('../utils/dates');

const LOAN_DAYS = 14;

function createLoans(store, { catalog, members }) {
  const loans = () => store.data.loans;
  return {
    borrow(memberId, isbn, date) {
      if (!members.getMember(memberId)) throw new Error(`neznámý čtenář ${memberId}`);
      const book = catalog.getBook(isbn);
      if (!book) throw new Error(`neznámá kniha ${isbn}`);
      if (catalog.available(book.isbn) < 1) throw new Error(`kniha ${book.title} není volná`);
      const loan = makeLoan({ memberId, isbn: book.isbn, date, due: addDays(date, LOAN_DAYS) });
      loans().push(loan); store.save();
      return loan;
    },
    giveBack(loanId, date) {
      const loan = loans().find((l) => l.id === loanId);
      if (!loan) throw new Error(`neznámá výpůjčka ${loanId}`);
      if (loan.returned) throw new Error(`výpůjčka ${loanId} už je vrácená`);
      if (compare(date, loan.date) < 0) throw new Error('vrácení nemůže být před půjčením');
      loan.returned = date;
      store.save();
      return loan;
    },
    active(memberId) { return loans().filter((l) => !l.returned && (!memberId || l.memberId === memberId)); },
    /** Výpůjčky po termínu k datu `today` (pro přehled a upomínky). */
    overdue(today) { return loans().filter((l) => !l.returned && compare(l.due, today) < 0); },
  };
}
module.exports = { createLoans, LOAN_DAYS };
