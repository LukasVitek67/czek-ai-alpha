// Jednoduchý store knihovny skladeb (jako Svelte store: subscribe + update).
const { applyFilters } = require('./filter');

function createStore(initial = []) {
  let state = { tracks: initial, query: '', genre: null, sortBy: 'title' };
  const subs = new Set();
  const derived = () => ({ ...state, filteredTracks: applyFilters(state.tracks, state) });
  const notify = () => { const d = derived(); subs.forEach((fn) => fn(d)); };
  return {
    subscribe(fn) { subs.add(fn); fn(derived()); return () => subs.delete(fn); },
    get() { return derived(); },
    setQuery(q) { state = { ...state, query: q }; notify(); },
    setGenre(g) { state = { ...state, genre: g }; },
    setSort(key) { state = { ...state, sortBy: key }; notify(); },
    add(track) { state = { ...state, tracks: [...state.tracks, track] }; notify(); },
    remove(id) { state = { ...state, tracks: state.tracks.filter((t) => t.id === id) }; notify(); },
  };
}

module.exports = { createStore };
