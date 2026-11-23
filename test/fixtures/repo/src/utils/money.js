'use strict';
/** Celé koruny → '1 250 Kč' (nezlomitelná mezera mezi tisíci se tu nepoužívá kvůli testům a CLI). */
function formatCzk(n) {
  if (!Number.isInteger(n)) throw new Error(`částka musí být v celých korunách: ${n}`);
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Kč`;
}
module.exports = { formatCzk };
