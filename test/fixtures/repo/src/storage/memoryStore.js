'use strict';
/** Úložiště v paměti (testy). Stejné rozhraní jako fileStore. */
function createMemoryStore(initial) {
  const data = initial || { books: [], members: [], loans: [] };
  return { data, save() {} };
}
module.exports = { createMemoryStore };
