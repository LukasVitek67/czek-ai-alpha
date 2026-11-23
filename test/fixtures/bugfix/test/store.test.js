const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../src/store');
const tracks = require('./fixtures');

test('hledání podle interpreta nezávisle na velikosti písmen', () => {
  const s = createStore(tracks());
  s.setQuery('queen');
  assert.deepStrictEqual(s.get().filteredTracks.map((t) => t.id), [1]);
});
test('filtr žánru upozorní odběratele', () => {
  const s = createStore(tracks());
  let last = null;
  s.subscribe((d) => (last = d));
  s.setGenre('Rock');
  assert.deepStrictEqual(last.filteredTracks.map((t) => t.id).sort(), [1, 3]);
});
test('remove odebere jen danou skladbu', () => {
  const s = createStore(tracks());
  s.remove(2);
  assert.deepStrictEqual(s.get().tracks.map((t) => t.id), [1, 3, 4]);
});
test('řazení podle délky vzestupně, podle názvu česky', () => {
  const s = createStore(tracks());
  s.setSort('duration');
  assert.deepStrictEqual(s.get().filteredTracks.map((t) => t.id), [3, 2, 4, 1]);
  s.setSort('title');
  assert.deepStrictEqual(s.get().filteredTracks.map((t) => t.title), ['Áčko', 'Billie Jean', 'Bohemian Rhapsody', 'Clair de Lune']);
});
