'use strict';
const { createLibrary } = require('../src');
const { createMemoryStore } = require('../src/storage/memoryStore');
const { run } = require('../src/cli');

const ISBN = { mloci: '9788020403223', rur: '9788072033065', babicka: '9788020420114', saturnin: '9788071081234' };
/** Knihovna se 4 knihami a 2 čtenáři. */
function sample() {
  const lib = createLibrary(createMemoryStore());
  lib.catalog.addBook({ isbn: ISBN.mloci, title: 'Válka s mloky', author: 'Karel Čapek', year: 1936, copies: 2 });
  lib.catalog.addBook({ isbn: ISBN.rur, title: 'R.U.R.', author: 'Karel Capek', year: 1920 });
  lib.catalog.addBook({ isbn: ISBN.babicka, title: 'Babička', author: 'Božena Němcová', year: 1855 });
  lib.catalog.addBook({ isbn: ISBN.saturnin, title: 'Saturnin', author: 'Zdeněk Jirotka', year: 1942 });
  lib.members.addMember({ id: 'jn', name: 'Jan Novák', grade: '7.A' });
  lib.members.addMember({ id: 'ak', name: 'Anna Kovářová', grade: '8.B' });
  return lib;
}
const cli = (lib, argv, today = '2026-01-05') => run(argv, { lib, today });
module.exports = { sample, cli, ISBN };
