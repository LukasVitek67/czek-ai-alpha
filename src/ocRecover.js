'use strict';
// Zotavení okna OpenCode z jednorázových chyb webového rozhraní. Zatím: markdown highlight worker.
// OpenCode si zvýrazňování kódu v chatu dělá přes web worker; když ten jednou spadne (např. při náročném
// startu), bundle si chybu uloží na celou relaci (`om` cache) a zvýrazňování už nenaběhne, dokud se okno
// nereloadne. czek-ai to pozná z konzole a okno jednou tiše reloadne (viz src/main.js, watchWindow 'opencode').

// Hláška z bundlu OpenCode: `Js.onerror=...||"Markdown highlighting worker failed"` a `console.error("Markdown
// highlighting worker failed", i)`. Shoda i s doplňujícím textem/objektem za hláškou.
function markdownWorkerFailed(message) {
  return /Markdown (highlighting )?worker (failed|response failed)/i.test(String(message || ''));
}

// Pád rendereru okna OpenCode (render-process-gone). Při skutečném pádu má smysl okno jednou reloadnout
// (relace žije na serveru OpenCode), při čistém konci / našem zabití (reload, konec appky) ne.
const GONE_RELOAD = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit']);
function shouldReloadOnGone(reason) {
  return GONE_RELOAD.has(String(reason || ''));
}

module.exports = { markdownWorkerFailed, shouldReloadOnGone };
