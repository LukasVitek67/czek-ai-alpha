# Jak přispět do czek-ai (ALPHA)

Díky, že pomáháš! Appku vylepšujeme společně celá třída i s učitelem. Nemusíš být expert – opravit text, nahlásit
chybu nebo zkusit appku na svém PC pomáhá úplně stejně.

## Nahlášení chyby nebo nápadu

Založ [Issue](../../issues): co jsi dělal, co se stalo, co jsi čekal, verze appky (menu czek-ai → O aplikaci) a
Windows/Linux. **Nikdy nevkládej klíče** – ani do screenshotu nebo logu (logy appky klíče maskují, ale zkontroluj to).

## Změna kódu

1. Udělej si fork (nebo si nech přidat jako spolupracovník) a novou větev: `git checkout -b oprava-neco`.
2. `npm ci`, změň kód, pusť testy, které se změny týkají (seznam je v `CLAUDE.md`, rychlé jádro:
   `node test/tiers.js && node test/i18n.js && node test/race.js && node test/guard.mjs && node test/wizard.js`).
3. **Zkontroluj, že necommituješ klíče:** `git diff --cached | grep -E "(sk-or-v1-|nvapi-|gsk_|hf_|ghp_|AIza)"` musí být prázdné.
4. Commit s jasnou zprávou (`fix: …`, `feat: …`, česky i anglicky), push a otevři Pull Request s popisem, co a proč.
5. Když změna má zrychlit nebo zlepšit appku, přidej čísla před/po (`docs/research/2026-11-22-claude-e2e/bench-czek.js`).

## S AI asistentem

Klidně – pravidla pro AI asistenty jsou v [CLAUDE.md](CLAUDE.md) a asistent je načte sám. Co asistent napíše, si
před commitem přečti; zodpovídáš za to ty.

## Co se hodí udělat

Otevřené mezery jsou ve sloupci „Co chybí do 10“ v [docs/SCORECARD.md](docs/SCORECARD.md) – hlavně vyzkoušet appku
ve škole na více PC najednou a s průvodcem klíči úplně od nuly.
