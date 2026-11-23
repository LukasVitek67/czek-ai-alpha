const test = require('node:test');
const assert = require('node:assert');
const { Library } = require('../src/library');

const T = [
  { id: 1, title: 'Žluťoučký kůň', artist: 'Kryštof', album: 'Inzerát', year: 2003, track: 2, duration: 210 },
  { id: 2, title: 'Atlantida', artist: 'Kryštof', album: 'Inzerát', year: 2003, track: 1, duration: 245 },
  { id: 3, title: 'Lullaby', artist: 'The Cure', album: 'Disintegration', year: 1989, track: 3, duration: 252 },
  { id: 4, title: 'Pictures of You', artist: 'The Cure', album: 'Disintegration', year: 1989, track: 1, duration: 448 },
  { id: 5, title: 'Song 2', artist: 'Blur', album: 'Blur', year: 1997, track: 2, duration: 122 },
];
const lib = () => { const l = new Library(); for (const t of T) l.add(t); return l; };

test('add / size / get; duplicate id replaces the track', () => {
  const l = lib();
  assert.strictEqual(l.size, 5);
  assert.strictEqual(l.get(3).title, 'Lullaby');
  l.add({ ...T[2], title: 'Lullaby (remaster)' });
  assert.strictEqual(l.size, 5);
  assert.strictEqual(l.get(3).title, 'Lullaby (remaster)');
  assert.strictEqual(l.get(99), undefined);
});

test('remove returns true only when something was removed', () => {
  const l = lib();
  assert.strictEqual(l.remove(5), true);
  assert.strictEqual(l.remove(5), false);
  assert.strictEqual(l.size, 4);
});

test('search: case- and diacritics-insensitive, title/artist/album, every word must match', () => {
  const l = lib();
  assert.deepStrictEqual(l.search('zlutoucky').map((t) => t.id), [1]);
  assert.deepStrictEqual(l.search('KRYSTOF').map((t) => t.id).sort(), [1, 2]);
  assert.deepStrictEqual(l.search('cure pictures').map((t) => t.id), [4]);
  assert.deepStrictEqual(l.search('').length, 5, 'empty query returns everything');
  assert.deepStrictEqual(l.search('nothing here'), []);
});

test('sort: by one or more keys, desc with "-", stable, does not mutate the library', () => {
  const l = lib();
  assert.deepStrictEqual(l.sort('year').map((t) => t.id), [3, 4, 5, 1, 2]);
  assert.deepStrictEqual(l.sort('-duration').map((t) => t.id), [4, 3, 2, 1, 5]);
  assert.deepStrictEqual(l.sort('artist', 'album', 'track').map((t) => t.id), [5, 2, 1, 4, 3]);
  assert.deepStrictEqual(l.all().map((t) => t.id), [1, 2, 3, 4, 5], 'insertion order kept');
});

test('albums: grouped, tracks in track order, total duration', () => {
  const albums = lib().albums();
  assert.deepStrictEqual(albums.map((a) => a.name), ['Blur', 'Disintegration', 'Inzerát']);
  const inz = albums.find((a) => a.name === 'Inzerát');
  assert.strictEqual(inz.artist, 'Kryštof');
  assert.deepStrictEqual(inz.tracks.map((t) => t.id), [2, 1]);
  assert.strictEqual(inz.duration, 455);
});
