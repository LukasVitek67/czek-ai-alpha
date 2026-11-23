# Issue #42: Pokuty za pozdní vrácení + vyhledávání bez diakritiky

**Od:** paní knihovnice

1. **Pokuty.** Když čtenář vrátí knihu po termínu, má zaplatit pokutu:
   - 2 Kč za každý **pracovní den** po termínu vrácení (víkendy a státní svátky z `utils/dates.js` se nepočítají),
     počítá se od dne po termínu až do dne vrácení včetně; vrácení v den termínu nebo dřív = bez pokuty;
   - nejvýš 100 Kč za jednu výpůjčku;
   - pokuta se při vrácení zapíše k výpůjčce (`loan.fine`, celé koruny, i 0) a vrácení ji vrátí: `giveBack(...)` →
     `{ loan, fine }`.
2. **Dluhy.** Nová služba `src/services/fines.js` (napojit v `src/index.js` jako `lib.fines`):
   - `outstanding(memberId)` → `{ items: [{ loanId, isbn, title, fine }], total }` – nezaplacené pokuty čtenáře
     (jen vrácené výpůjčky s pokutou > 0), seřazené podle data vrácení;
   - `pay(memberId)` → zaplatí všechny jeho pokuty (výpůjčky dostanou `finePaid: true`) a vrátí zaplacenou částku.
3. **Blokace.** Čtenář, který dluží **víc než 50 Kč**, si nesmí půjčit další knihu: `borrow` hodí chybu
   `čtenář <id> dluží <částka> – nejdřív zaplatit` (částka přes `formatCzk`). Přesně 50 Kč ještě nevadí.
4. **CLI.** Příkazy `fines <id>` (řádky `<název knihy>: <částka>`, poslední řádek `Celkem: <částka>`; bez dluhů jen
   `Bez dluhů`) a `pay <id>` (`Zaplaceno <částka>`). Neznámý čtenář → code 1 `neznámý čtenář <id>`.
5. **Chyba ve vyhledávání.** `search capek` nenajde „Karel Čapek“ a `search ČAPEK` nenajde „Capek“ – vyhledávání má
   ignorovat diakritiku i velikost písmen (oběma směry).

Testy pro pokuty jsou v `test/fines.test.js`. Stávající testy se nesmí rozbít.
