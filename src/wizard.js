// Průvodce klíči: nováček bez klíčů krok za krokem založí free účty a vloží klíče.
// Jeden soubor pro hlavní proces (kdy průvodce otevřít sám) i pro okno nastavení (<script src="../wizard.js">).
//
// Proč (docs/SCORECARD.md, „Bez registrace“ 3/10): profil úplně bez klíčů měl v bench-czek.js 0/15 testů.
// Poskytovatelé bez klíče (Kilo, Pollinations, OVH, LLM7) mají limit na IP adresu a ve škole sdílí jednu IP celá
// třída. Kilo má i s účtem 200 dotazů/h na IP (docs kilo.ai/docs/gateway/usage-and-billing), proto v průvodci
// není. Pořadí: poskytovatelé s limitem na klíč/účet, nejdřív ti, jejichž modely v měřeních vyhrávaly kroky agenta
// (Nemotron 3 Ultra, Kimi, DeepSeek přes NVIDIA; Nemotron, particle-1, ERNIE přes OpenRouter; Gemini 3 Flash).
(function (root) {
  'use strict';
  /**
   * Kroky průvodce. id = id poskytovatele ze src/providers.js; texty v src/i18n.js pod `wiz.<id>.why` a
   * `wiz.<id>.how` (kroky oddělené „|“). adult = podmínky služby omezují uživatele mladší 18 let.
   */
  const STEPS = [
    { id: 'nvidia' },
    { id: 'openrouter' },
    { id: 'gemini', adult: true },
    { id: 'zai' },
    { id: 'github' },
    { id: 'mistral' },
    { id: 'opencode' },
  ];
  // Od kolika klíčů je appka spolehlivá: jeden poskytovatel s limitem (40/min, 50/den) v půlce úlohy dojde,
  // závod modelů potřebuje aspoň dva různé poskytovatele.
  const ENOUGH = 3;

  const hasKey = (settings, id) => !!settings?.providers?.[id]?.key || !!settings?.providers?.[id]?.hasKey;
  /** Kolik poskytovatelů z průvodce má klíč. */
  function keyed(settings) { return STEPS.filter((s) => hasKey(settings, s.id)).length; }
  /** Otevřít průvodce sám při startu? Jen dokud uživatel nemá žádný klíč z průvodce a průvodce nezavřel. */
  function needsWizard(settings) { return !settings?.wizardDone && keyed(settings) === 0; }
  /** První krok bez klíče (odtud průvodce začne), jinak konec. */
  function firstOpen(settings) {
    const i = STEPS.findIndex((s) => !hasKey(settings, s.id));
    return i < 0 ? STEPS.length : i;
  }

  // Poznávací znamení klíčů (veřejně dokumentované prefixy). Student ve třídě často vloží klíč do špatného kroku
  // (OpenRouter do NVIDIA) a pak vidí jen „401“; podle prefixu se klíč uloží k poskytovateli, kterému patří.
  const PREFIXES = [
    ['nvidia', /^nvapi-/],
    ['openrouter', /^sk-or-/],
    ['gemini', /^AIza[0-9A-Za-z_-]{20,}$/],
    ['github', /^(ghp_|github_pat_)/],
    ['groq', /^gsk_/],
    ['huggingface', /^hf_/],
    ['cerebras', /^csk-/],
  ];
  /**
   * Vyčistí vložený text na samotný klíč: mezery a zalomení řádků z kopírování, uvozovky, `Bearer …`,
   * `Authorization: …`, `export NAZEV_API_KEY="…"` / `NAZEV=…` z ukázek v dokumentaci.
   */
  function cleanKey(v) {
    let s = String(v ?? '').trim();
    s = s.replace(/^export\s+/i, '').replace(/^\$env:/i, '');
    s = s.replace(/^authorization\s*:\s*/i, '');
    s = s.replace(/^[A-Z][A-Z0-9_]*\s*=\s*/, '');
    s = s.replace(/^bearer\s+/i, '');
    s = s.replace(/^["'`]+|["'`;,]+$/g, '');
    return s.replace(/\s+/g, '');
  }
  /** Komu klíč podle prefixu patří (id poskytovatele), nebo null. */
  function ownerOf(key) {
    const k = cleanKey(key);
    const hit = PREFIXES.find(([, re]) => re.test(k));
    return hit ? hit[0] : null;
  }
  /** Zjevně ne klíč: odkaz, e-mail, příliš krátké. Vrací důvod ('url' | 'email' | 'short') nebo null. */
  function notKey(key) {
    const k = cleanKey(key);
    if (/^https?:\/\/|^www\./i.test(k)) return 'url';
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(k)) return 'email';
    if (k.length < 16) return 'short';
    return null;
  }

  const api = { STEPS, ENOUGH, keyed, needsWizard, firstOpen, cleanKey, ownerOf, notKey, PREFIXES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WIZARD = api;
})(typeof window !== 'undefined' ? window : globalThis);
