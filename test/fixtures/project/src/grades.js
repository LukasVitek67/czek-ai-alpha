'use strict';
// Známky 1–5 (1 nejlepší), váha 1–10. Hodnota 'N' = nehodnocen (absence), do průměru se nepočítá.
// Zatím jen prostý průměr; vážený průměr, výsledná známka a průměry po předmětech chybí (viz README.md).

function average(grades) {
  const vals = grades.map((g) => g.value);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

module.exports = { average };
