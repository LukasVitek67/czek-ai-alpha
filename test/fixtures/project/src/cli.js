'use strict';
// Příkazová řádka: run(argv, { store }) → { code, out }. Nic nevypisuje sama.
const { studentReport } = require('./report');

const USAGE = 'použití: add-student <id> <jméno> | add-grade <id> <předmět> <známka|N> [váha] | report <id> | export | free <den> | conflicts';

function run(argv, { store }) {
  const [cmd, ...a] = argv;
  switch (cmd) {
    case 'add-student':
      store.addStudent(a[0], a[1]);
      return { code: 0, out: `přidán ${a[0]}` };
    case 'add-grade':
      store.addGrade({ student: a[0], subject: a[1], value: a[2], weight: a[3] });
      return { code: 0, out: `známka ${a[2]} z ${a[1]} pro ${a[0]}` };
    case 'report':
      return { code: 0, out: studentReport(store, a[0]).join('\n') };
    default:
      return { code: 1, out: USAGE };
  }
}

module.exports = { run, USAGE };
