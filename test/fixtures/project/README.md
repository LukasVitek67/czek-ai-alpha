# znamky – známky a rozvrh třídy

Malá knihovna + příkazová řádka pro třídní učitelku. Data jsou v jednom JSON souboru (`src/store.js`, hotové).

## Co chybí / co je špatně

1. **`src/grades.js`** – místo prostého `average` exportuj:
   - `weightedAverage(grades)` – vážený průměr známek 1–5. Váha `weight` je celé číslo 1–10 (chybí = 1),
     jiná váha → `RangeError`. Hodnota `'N'` (nehodnocen) se nepočítá. Výsledek zaokrouhlený na 2 desetinná
     místa, bez platné známky `null`.
   - `finalGrade(avg)` – do 1,5 → 1, do 2,5 → 2, do 3,5 → 3, do 4,5 → 4, jinak 5; `null` → `null`.
   - `bySubject(grades)` – objekt `{ předmět: průměr }`, předměty seřazené česky (`localeCompare(…, 'cs')`).
2. **`src/timetable.js`** – hodiny, které na sebe jen navazují (konec jedné = začátek druhé), se hlásí jako kolize.
   To je chyba. Přidej `freeSlots(lessons, day)`: volná okna dne mezi 08:00 a 16:00 jako `[{ start, end }]`
   (časy `HH:MM`), seřazená, bez prázdných oken; překrývající se hodiny se sloučí; neznámý den → chyba.
3. **`src/report.js`** – exportuj:
   - `studentReport(store, id)` – pole řádků: `Žák: <jméno> (<id>)`, pak pro každý předmět (česky seřazeno)
     `<předmět>: <průměr na 2 místa> → <výsledná známka>` nebo `<předmět>: nehodnocen`, nakonec
     `Celkem: <průměr ze všech známek na 2 místa>` nebo `Celkem: nehodnocen`. Neznámý žák → chyba
     `unknown student <id>`.
   - `csv(store)` – hlavička `student,name,subject,value,weight`, řádky seřazené podle id žáka a pak předmětu,
     váha chybí = 1, buňky s `"`, `,` nebo novým řádkem v uvozovkách (`"` zdvojené), na konci nový řádek.
4. **`src/cli.js`** – `run(argv, { store })` vrací `{ code, out }`:
   - `add-student <id> <jméno…>` (jméno může mít víc slov), duplicitní id → code 1 a text chyby.
   - `add-grade <id> <předmět> <známka|N> [váha]` – známka 1–5 nebo `N`, váha 1–10 (výchozí 1), uloží čísla.
     Chyby (code 1, nic se neuloží): `neznámý žák <id>`, `neplatná známka <x>`, `neplatná váha <x>`.
   - `report <id>` (neznámý žák → code 1 `neznámý žák <id>`), `export` (CSV), `free <den>` (okna jako
     `HH:MM–HH:MM` po řádcích), `conflicts` (`<den> <předmět> × <předmět>` po řádcích a code 1, jinak
     `bez kolizí` a code 0).
   - Neznámý příkaz nebo špatný počet argumentů → code 2 a text začínající `použití:` (konstanta `USAGE`).
   - Jiné chyby (výjimky) → code 1 a text chyby.

`npm test` spustí testy ve složce `test/`.
