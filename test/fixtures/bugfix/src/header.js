// "Komponenta" záhlaví: počet zobrazených skladeb a celková délka.
const { totalDuration } = require('./format');

function renderHeader(store) {
  const s = store.get();
  const shown = s.state.filteredTracks;
  return `${shown.length} skladeb · ${totalDuration(shown)}`;
}

module.exports = { renderHeader };
