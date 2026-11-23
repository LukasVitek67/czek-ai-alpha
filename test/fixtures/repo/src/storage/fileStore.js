'use strict';
const fs = require('fs');
/** Úložiště v JSON souboru; save() zapisuje přes dočasný soubor (atomicky). */
function createFileStore(file) {
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { books: [], members: [], loans: [] };
  for (const k of ['books', 'members', 'loans']) data[k] ||= [];
  return {
    data,
    save() { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); },
  };
}
module.exports = { createFileStore };
