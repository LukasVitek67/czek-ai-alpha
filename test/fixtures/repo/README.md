# Školní knihovna

Evidence knih, čtenářů a výpůjček pro školní knihovnu. Bez závislostí, Node.js 20+.

## Struktura

- `src/models/` – datové objekty a jejich kontrola (`book.js`, `member.js`, `loan.js`)
- `src/storage/` – úložiště (`memoryStore.js` pro testy, `fileStore.js` = JSON soubor)
- `src/utils/` – data a pracovní dny (`dates.js`), ISBN (`isbn.js`), text (`text.js`), peníze (`money.js`)
- `src/services/` – logika: katalog (`catalog.js`), čtenáři (`members.js`), výpůjčky (`loans.js`)
- `src/cli/` – příkazová řádka: `index.js` rozděluje příkazy do `commands/*.js`
- `src/index.js` – `createLibrary(store)` spojí služby dohromady

## Pravidla projektu

- Data jsou řetězce `YYYY-MM-DD`; počítá se v UTC (`utils/dates.js`).
- Chyby, které má vidět uživatel, jsou `Error` s českou zprávou; CLI je vrací jako `{ code: 1, out: zpráva }`.
- Peníze jsou celé koruny (number), zobrazují se přes `formatCzk` (`utils/money.js`).
- Každý příkaz CLI vrací `{ code, out }` a nic sám nevypisuje.
- Výpůjčka trvá 14 kalendářních dní (`LOAN_DAYS` v `services/loans.js`).

`npm test` spustí testy ve složce `test/`.
