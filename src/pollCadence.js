'use strict';
// Jak často se preload okna OpenCode ptá hlavního procesu na stav (čistá logika, ať jde testovat bez Electronu).
//  - oc:active = který model právě pracuje (živý odpočet) → 1 s když volá, jinak 2,5 s,
//  - oc:limits = limity poskytovatelů → mění se řádově v minutách, stačí 8 s (dřív 3 s).
// Skryté okno (document.hidden – minimalizované/zakryté) se neptá vůbec; po návratu se stav obnoví hned
// (ve volajícím přes visibilitychange). Sebe-audit 23. 11.: oc:active 22 417 + oc:limits 6 426 opakovaných
// volání za 6 dní – tohle obě škrtí.
const ACTIVE_MS = 1000; // model právě volá: živý odpočet
const IDLE_MS = 2500;   // nic se neděje: start volání se ukáže do 2,5 s
const HIDDEN_MS = 5000; // okno není vidět: jen občas zkusit, jestli se vrátilo
const LIMITS_MS = 8000; // limity se mění pomalu

/** oc:active: {poll, delay}. hidden → neptat se; jinak podle toho, jestli model právě pracuje. */
function activeCadence(hidden, running) {
  if (hidden) return { poll: false, delay: HIDDEN_MS };
  return { poll: true, delay: running ? ACTIVE_MS : IDLE_MS };
}
/** oc:limits: {poll, delay}. hidden → neptat se; jinak 8 s. */
function limitsCadence(hidden) {
  return { poll: !hidden, delay: LIMITS_MS };
}

module.exports = { ACTIVE_MS, IDLE_MS, HIDDEN_MS, LIMITS_MS, activeCadence, limitsCadence };
