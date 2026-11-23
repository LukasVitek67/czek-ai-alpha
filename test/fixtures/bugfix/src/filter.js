const { compareBy } = require('./sort');

function matchesQuery(track, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return track.title.toLowerCase().includes(q) || track.artist.includes(q);
}

function applyFilters(tracks, { query, genre, sortBy }) {
  return tracks
    .filter((t) => matchesQuery(t, query))
    .filter((t) => !genre || t.genre == genre.toLowerCase())
    .sort(compareBy(sortBy));
}

module.exports = { applyFilters, matchesQuery };
