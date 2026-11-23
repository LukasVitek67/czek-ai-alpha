'use strict';
// Úprava webového rozhraní OpenCode při načítání do okna Zdarmy (soubory OpenCode na disku zůstávají beze změny).
//
// Webové OpenCode má `platform: "web"` napevno a pro výběr složky ukazuje vlastní dialog procházející server.
// Desktopová verze OpenCode na stejném místě volá `openDirectoryPickerDialog()` (nativní dialog).
// Tady se ta podmínka rozšíří: když okno nabízí `window.__ZDARMA__`, výběr složky jde přes Zdarmu
// (okno s rychlým přístupem + klasický dialog Windows). Když se vzor v nové verzi OpenCode nenajde,
// nic se nemění a funguje původní výběr OpenCode.

const ID = '[\\w$]+';
const PICKER_RE = new RegExp(
  `if\\((${ID})\\((${ID})\\.platform,(${ID})\\.server\\)==="native"&&\\2\\.platform==="desktop"\\)\\{\\2\\.openDirectoryPickerDialog\\(`,
  'g',
);

// Klasické rozvržení (chaty svisle vlevo): OpenCode ho 14. 9. 2026 vypnulo datem, po kterém vynucuje nové
// rozvržení s taby (`kS=!1,nbe=!0,rbe=new Date(2026,8,14),jP="1.17.19"`). Kód starého rozvržení v rozhraní
// zůstal; posunutím data ho jde znovu zapnout nastavením general.newLayoutDesigns=false (dělá ocPreload.js).
const LAYOUT_CUTOFF_RE = new RegExp(`(${ID}=!1,${ID}=!0,${ID}=)new Date\\(\\d{4},\\d{1,2},\\d{1,2}\\)(,${ID}="\\d+\\.\\d+\\.\\d+")`, 'g');

/** @returns {{code: string, patched: number, layout: number}} */
function patchBundle(code) {
  let patched = 0;
  let layout = 0;
  let out = code.replace(PICKER_RE, (_all, fn, ctx, opts) => {
    patched++;
    return `if(window.__ZDARMA__||${fn}(${ctx}.platform,${opts}.server)==="native"&&${ctx}.platform==="desktop"){(window.__ZDARMA__?window.__ZDARMA__.pickFolder:${ctx}.openDirectoryPickerDialog)(`;
  });
  const cutoffs = out.match(LAYOUT_CUTOFF_RE) || [];
  if (cutoffs.length === 1) out = out.replace(LAYOUT_CUTOFF_RE, (_a, pre, post) => { layout++; return `${pre}new Date(9999,0,1)${post}`; });
  return { code: out, patched, layout };
}

// Vzhled vkládaný do okna OpenCode (insertCSS). „Rozdělení kontextu“ je pruh segmentů s barvami
// z proměnných tématu; asistent (--syntax-property) a nástroje (--syntax-warning) mají skoro stejný odstín
// a segmenty na sebe navazují bez mezery. Inline styl má přednost, proto !important.
const BAR = 'div.h-2.w-full.rounded-full.overflow-hidden.flex';
const OC_CSS = `
:root {
  --czek-model-w: 640px;
  --czek-model-h: 560px;
}
${BAR} { gap: 2px; height: 10px; }
${BAR} > div.h-full { min-width: 3px; }
${BAR} > div[style*="--syntax-success"], div.size-2.rounded-sm[style*="--syntax-success"] { background-color: #3fb86b !important; }
${BAR} > div[style*="--syntax-property"], div.size-2.rounded-sm[style*="--syntax-property"] { background-color: #5b8def !important; }
${BAR} > div[style*="--syntax-warning"], div.size-2.rounded-sm[style*="--syntax-warning"] { background-color: #e8a33d !important; }
${BAR} > div[style*="--syntax-comment"], div.size-2.rounded-sm[style*="--syntax-comment"] { background-color: #8a8a8a !important; }

/* Větší a nastavitelná vyskakovací nabídka výběru modelu v OpenCode (V1 i V2) */
div.w-72.h-80:has([data-slot="list-scroll"]) {
  width: min(var(--czek-model-w, 640px), 92vw) !important;
  height: min(var(--czek-model-h, 560px), 84vh) !important;
  max-width: 92vw !important;
  max-height: 84vh !important;
}
[data-component="dropdown-menu-content"]:has([data-slot="model-selector-scroll"]),
div.w-\\[284px\\]:has([data-slot="model-selector-scroll"]) {
  width: min(var(--czek-model-w, 640px), 92vw) !important;
  max-width: 92vw !important;
}
[data-slot="model-selector-scroll"] {
  max-height: min(calc(var(--czek-model-h, 560px) - 105px), 74vh) !important;
}
[data-component="dialog-content"]:has([data-slot="list-scroll"]) {
  width: min(var(--czek-model-w, 680px), 92vw) !important;
  max-width: 92vw !important;
  min-height: min(var(--czek-model-h, 560px), 82vh) !important;
}
`;

// Seznam úkolů pod promptem („0 of 6 todos completed“). Nástroj todowrite je od 0.15.5 vypnutý, ale relace,
// kde ho model kdysi zavolal, mají starý seznam navždy (API OpenCode ho smazat neumí) a OpenCode ho kreslí,
// kdykoli relace pracuje (živě 13.–14. 11.). Prvek podle bundlu webu OpenCode 1.19.5: data-component.
// Skryje se, pokud seznam úkolů není zapnutý (nastavení ocTodo).
const TODO_HIDE_CSS = `
[data-component="session-todo-dock"] { display: none !important; }
`;

/** Hlavní skript rozhraní: /assets/index-<hash>.js */
const isMainBundle = (url) => /\/assets\/index-[\w-]+\.js(\?|$)/.test(url);

module.exports = { patchBundle, isMainBundle, PICKER_RE, LAYOUT_CUTOFF_RE, OC_CSS, TODO_HIDE_CSS };
