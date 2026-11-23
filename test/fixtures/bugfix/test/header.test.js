const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const { renderHeader } = require('../src/header');
const tracks = require('./fixtures');

test('záhlaví ukazuje zobrazené skladby', () => {
  const s = createStore(tracks());
  s.setGenre('rock');
  assert.strictEqual(renderHeader(s), '2 skladeb · 8:59');
});
