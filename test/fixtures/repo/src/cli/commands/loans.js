'use strict';
module.exports = {
  borrow: {
    usage: 'borrow <čtenář> <isbn> [datum]', min: 2, max: 3,
    run([memberId, isbn, date], { lib, today }) {
      const l = lib.loans.borrow(memberId, isbn, date || today);
      return { code: 0, out: `půjčeno ${l.id}, vrátit do ${l.due}` };
    },
  },
  return: {
    usage: 'return <výpůjčka> [datum]', min: 1, max: 2,
    run([loanId, date], { lib, today }) {
      const loan = lib.loans.giveBack(loanId, date || today);
      return { code: 0, out: `vráceno ${loan.id}` };
    },
  },
};
