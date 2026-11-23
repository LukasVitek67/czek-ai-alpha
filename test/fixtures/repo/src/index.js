'use strict';
const { createCatalog } = require('./services/catalog');
const { createMembers } = require('./services/members');
const { createLoans } = require('./services/loans');

/** Celá knihovna nad jedním úložištěm. */
function createLibrary(store) {
  const catalog = createCatalog(store);
  const members = createMembers(store);
  const loans = createLoans(store, { catalog, members });
  return { store, catalog, members, loans };
}
module.exports = { createLibrary };
