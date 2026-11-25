# czek-ai: poctivé hodnocení (scorecard)

Pravidla:
- Skóre se mění **jen s důkazem** (měření, test, řádek v kódu). Co nejde změřit, je označené ❓ a skóre nedostane.
- Cíl je 10/10 všude. Hodnocení se přepisuje po každém updatu a historie je dole.
- Hlavní měření: `docs/research/2026-11-22-claude-e2e/bench-czek.js` = skutečná cesta appky (OmniRoute + tier + závod
  + OpenCode s konfigurací czek-ai) na úloze s 15 skrytými testy, Linux. Pozor: výsledek ovlivňuje stav sdílených
  free kvót, srovnání proto dělat ve dvojicích hned po sobě.

## Aktuální stav (update 18, 23. 11. 00:40)

| Oblast | Skóre | Důkaz | Co chybí do 10 |
|---|---|---|---|
| Jádro: agent dokončí úlohu | 9/10 | feature 15/15 (6×), bugfix 8/8 (2×), project 30/30 (3×); **dlouhá relace** (3 zadání po sobě v jedné konverzaci, 3. zadání jen slovy se skrytými testy): **38/38 za 105 s, 37/38 za 115 s, 38/38 za 235 s, 38/38 za 135 s** (3 ze 4 bez chyby); 25. 11. (0.15.42): **skutečné repo** (27 souborů ve vrstvách, issue jako na GitHubu, část testů skrytá) **29/29 za 315 s a 29/29 za 40 s** – poprvé; dlouhá relace **38/38 za 796 s** (po vyčerpání rychlých modelů odpovídal jen GLM 4.5 Flash) → dlouhá relace 4/5 bez chyby | Windows (běh úlohy na skutečném Windows PC); dlouhá relace bez chyby 4/5 → víc běhů |
| Rychlost | 9/10 | úlohy agenta na úrovni nejlepšího samostatného modelu nebo rychleji: **bugfix 20–25 s** (dřív 75 s; ERNIE sama 25 s), **project 30 s** (sama 95 s), feature 45–55 s (sama 50–55 s); pořadí z měření (očekávaný čas) + **věrnost vítězi** v závodě (`src/race.js`, test `race-sticky`) | start appky: Linux ~35–40 s do připravenosti, **Windows 1. start 238 s** do naplněného výběru (měřil Claude na notebooku; 2. start se měří) |
| Spolehlivost na nové instalaci | **9/10** | každý bench = čistá instalace (nový OmniRoute, nový profil). Výpadky závodu: U0 4 → U2 1 → po kontrole zdraví s náhradníky (22. 11. 20:20–00:00): **9 běhů po sobě 0 výpadků, 9/9 úloh dokončeno** (bugfix, feature, project, dlouhá relace), i když kontrola v části běhů našla až 13 nefunkčních modelů v čele tierů | ověřit ve skutečné třídě (30 studentů na jedné IP současně) a v jinou denní dobu |
| Odolnost (mrtvé/visící modely) | **9/10** | **skutečná cesta při přiškrcených poskytovatelích (22. 11. večer):** kontrola zdraví našla 13 nefunkčních modelů v čele tierů (Kilo i OpenRouter neodpovídaly), vyřadila je předem → **0 výpadků závodu**, úloha dokončena přes NVIDIA (bugfix 8/8, 2 běhy). Od rozšíření kontroly na náhradníky 3 běhy po sobě 0 výpadků; všech 12 večerních běhů dokončilo úlohu. Mechanismy: dead/hang/flaky okna, kontrola po startu a každých 30 min, pauzy přežijí synchronizaci i restart, pomalé modely na konec. Testy `omni-probe-pause`, `omni-probe-slowpass`, `omni-pause-persist`, `app-omni-start` | pozorovat na skutečné cestě i návrat: když se kvóty obnoví, rychlé modely se samy vrátí do čela (zítra ráno) |
| Údržba (aktuálnost modelů) | **8/10** | ověřené modely z měření (`src/evidence.js`, vyprší po 45 dnech) určují **pořadí i tier Max** (`src/tiers.js`: ruční pravidla pro změřené modely smazána; neměřený gemini-3.8-flash Max → High); týdenní přeměření samo najde nové modely Max/High a **přeměří ověřené, jejichž měření je starší než 30 dní**. Řetězec ověřen (`WEEKLY_QUICK=1`); bugfix po změně 8/8, 0 výpadků | první plný běh bez dozoru 29. 11.; neměřené modely se dál řadí heuristikou podle názvu |
| Nasazení pro třídu | **7/10** | simulovaný čistý Windows PC (`PLUG=1 WIZ=1 node test/app-splash.js`: bez Node/Git/OpenCode/OmniRoute, prázdné APPDATA): úvodní okno za **1,7–2,1 s**, vše se stáhne samo (bez práv správce), OmniRoute ~7 min (407 s, ~2,6 GB), okno agenta za **449–475 s**, **průvodce klíči už za 49 s** (dřív až po instalaci). Průvodce na Windows v celé appce OK (`app-wizard`), vložený klíč se vyčistí a cizí klíč uloží ke správné službě (`wizard-paste`: 14 → 0 chyb). Instalátor bez práv správce (`npm run dist:setup`): instalace 22 s, pak start **1,8–2,0 s** místo ~24 s u přenosné při každém spuštění. **Složka pro třídu** (`--priprav-tridu`, 2,9 GB s hotovým OmniRoute v archivu): studenti instalují bez internetu, OmniRoute se jen rozbalí (231 s místo 355–383 s, okno agenta 317 s místo 460 s) místo ~1,38 GB stahování na každého (30 studentů ~41 GB) | skutečný čistý PC (SmartScreen, antivir, školní síť/proxy); instalace OmniRoute 7 min je moc (místo na disku 2,85 → 1,79 GB od 25. 11., Linux měření, Windows neověřeno) (předinstalace na sdílený disk / menší balík); `Instalace.cmd` neověřen |
| Bez registrace | **7/10** | bez klíčů 0/15 (limit na IP, třída sdílí jednu) → **průvodce klíči** se otevře sám, provede 7 službami s limitem na účet, každý klíč hned ověří a na konci **„Vyzkoušet, že appka funguje“** pošle skutečný dotaz cestou agenta (ověřeno v celé appce: přes OmniRoute + závod ERNIE za 1,4 s, přes záložní proxy za 1,2 s; `app-omni-start`, `app-wizard`). Když free limity dojdou, česká hláška s odkazem na průvodce (`race-quota`) | vyzkoušet se skutečným spolužákem (kolik minut, kde se zasekne); na Windows ověřeno (`app-wizard`); Gemini jen 18+, Mistral chce telefon |

## Historie

- **Update 0 (22. 11.):** particle-1 a ERNIE 5.5 Flash do Max a PROVEN, PROVEN před preferFamilies, prokládání
  poskytovatelů. Měřeno: 320 s → 130 s (stejné kvóty), 15/15.
- **Update 1 (22. 11.):** HuggingFace (malý kredit → 402) a Groq (free 1 000 výstupních tokenů/min) na konec pořadí
  (`TAIL_PROVIDERS` v `src/agent.js`). Měřeno: 15/15 za 90 s, z výpadků závodu zmizelo 402.
- **Update 2 (22. 11.):** kontrola zdraví po startu (`OmniRoute.probeHeads`, volá `src/main.js` po startu OmniRoute):
  drobný dotaz na čelo tierů Max/High/Unlimited, 402/404/429 jde z čela pryč dřív než první krok. Měřeno: 15/15 za
  95 s, výpadky závodu 4 → 1. Kontrola našla 2× 429 a 4× bez odpovědi do 20 s.
- **Měření 22. 11. 03:20 (bez změny kódu):** profil bez klíčů 0/15 → „Bez registrace“ 7 → 3. Dřívější 7/10 stálo na
  běhu, kde Kilo bez klíče fungovalo; po desítkách dotazů z téže IP Kilo chce registraci.
- **Update 3 (22. 11. noc, smyčka Strata, sloučeno 13:30):**
  - Souběžnost zápisu combo (`ZDARMA_SYNC_POOL`, `src/omniroute.js`) změřena na skutečném OmniRoute 3.8.53:
    pool 6 → 10,0 s / 200 zápisů, 16 → 12,4 s, 32 → 21,3 s (OmniRoute zápisy serializuje). Výchozí 6 zůstává.
  - Strop výstupu na combo v záložní cestě (`src/proxy.js` viaOmni): OmniRoute neposílá modelu jeho strop, takže
    model se stropem 8 192 na požadavek 16 000 vrátil 0 tokenů. Teď proxy pošle min(požadavek, naučený strop)
    a po 400 to zkusí znovu menší. Na mocku 0 → 8 192 tokenů. **Skóre beze změny:** hlavní cesta (`src/race.js`)
    tuhle chybu v dnešních bězích neukázala (0× „max_tokens must be…“ ve výsledcích bench-czek).
  - **Nesloučeno:** start OpenCode souběžně s OmniRoute sync (ready 48,9 → 30,2 s). Plugin pak dostane neúplný
    katalog (133–141 z 201 modelů) a `probeHeads` by běžel nad prázdnými seznamy tierů (prověří 0 modelů).
    Vrátí se, až bude katalog po startu úplný a kontrola zdraví poběží po syncu.
- **Měření 22. 11. 13:40 (bugfix, bez změny kódu):** skutečná cesta appky, tier Max: 8/8 testů za 55 s, 8 kroků, všechny
  vyhrál Nemotron 3 Ultra přes Kilo. Kontrola zdraví: 6 z 8 čelních modelů bez odpovědi do 20 s, 1× 429, 1× 529
  (`results/czek-bugfix-zdarma-max-bugfix-u3.json`). Jádro zůstává 8: obě úlohy jsou malé.
- **Update 4 (22. 11. 14:40, Claude): průvodce klíči** (`src/wizard.js`, stránka „★ Průvodce klíči“ v nastavení, menu
  czek-ai → Průvodce klíči, sám při startu bez klíčů). Pořadí NVIDIA, OpenRouter, Gemini, Z.ai, GitHub, Mistral,
  OpenCode Zen. Kilo vynecháno: i s účtem 200 dotazů/h na IP. Při testu se skutečným klíčem nalezena chyba tlačítka
  „Otestovat“ (`provider:test` v `src/main.js`): bralo první model ze seznamu (NVIDIA `starcoder2-15b` → 404), takže
  i dobrý klíč hlásilo jako nefunkční. Teď zkusí až 3 modely a u 401/403 skončí hned. „Bez registrace“ 3 → 6.
- **Update 5 (22. 11. 15:30, Claude): větší úloha `project`** (`test/fixtures/project`: aplikace známky + rozvrh,
  5 modulů, 30 testů; vážené průměry, oprava kolize navazujících hodin, volná okna, report, CSV s escapováním,
  CLI s kódy chyb; referenční řešení ověřeno 30/30). Skutečná cesta appky, tier Max: 30/30 za 110 s a znovu
  30/30 za 75 s, 9 kroků, vše Nemotron 3 Ultra (`results/czek-project-zdarma-max-project-u4*.json`). Jádro 8 → 9.
- **Update 6 (22. 11. 16:00, Claude): ověřené modely z měření** (`src/evidence.js`, `tools/model-evidence.js`,
  `tools/model-evidence-weekly.sh` + systemd timer). Regex PROVEN nahrazen; běhy s chybou protokolu (≤ 2 kroky)
  a profil bez klíčů se nepočítají. Benchmark po změně: feature 15/15 za 110 s. Údržba 4 → 6.
- **Update 7 (22. 11. 17:10, Claude): ERNIE před Nemotronem z měření.** bench-e2e přes Kilo: ERNIE bugfix 8/8 za 25 s,
  project 30/30 za 95 s (→ 3 úlohy); particle-1 project 30/30 za 116 s, bugfix spadl na chybě poskytovatele (nepočítá
  se). Pravidlo pořadí: šíře důkazů nejvýš 3 úlohy, pak úspěšnost a rychlost (`src/evidence.js`, BROAD). Celá appka:
  project 40 s, feature 65 s, bugfix 95 s (ERNIE nedostupná) – vše úspěšně. Rychlost 7 → 8.
- **Update 8 (22. 11. 18:30, Claude): automatičtí kandidáti** v týdenním přeměření (`tools/model-candidates-auto.js`) a
  ověřený celý řetězec (`WEEKLY_QUICK=1 tools/model-evidence-weekly.sh`). Smyčka Strata ukazuje průběh kola v připnutém
  shrnutí každé 2 min. Údržba 6 → 7.
- **Update 9 (22. 11. 19:10, Claude): dlouhá relace** (`bench-czek.js … session`, `test/fixtures/session`): projekt → nová
  funkce s novými testy → požadavek učitelky popsaný slovy (testy skryté do vyhodnocení), vše v jedné konverzaci.
  38/38 (55 + 30 + 20 s) a 37/38 (60 + 20 + 35 s); kroky hlavně ERNIE. Bench nově zapisuje názvy neúspěšných testů.
  Jádro zůstává 9: 1 ze 2 běhů s chybou.
- **Update 10 (22. 11. 19:50, Claude + smyčka): kontrola zdraví z kol 14–15 sloučena** (lokální pauzy z kontroly, které
  `syncCooldowns()` nepřepíše; opakování každých 30 min; strop 10 s + druhé kolo 25 s na pozadí, pomalé modely jen na
  konec pořadí). Opravena chyba větve smyčky (`src/main.js` volal neexistující `omniSyncPromise` → start OmniRoute by
  spadl) a překlep v jejím testu. Nový test celé appky `test/app-omni-start.js`: start s OmniRoute, kontrola 12 modelů,
  0 chyb. Mock testy: mrtvé modely v první dvojici závodu 3 → 0. **Skóre beze změny:** benchmarky v 19:30 zkreslily
  vyčerpané free kvóty po celém dni měření (feature 255 s, 6× „cooling down“), A/B je potřeba udělat s čerstvými kvótami.
- **Update 11 (22. 11. 20:20, Claude):** česká hláška při vyčerpaných free limitech s odkazem na Průvodce klíči (bez klíčů
  vysvětlí, že limit sdílí celá třída); pauzy z kontroly zdraví přežijí restart appky. Odolnost 7 → 8 (deterministické
  testy; skutečná cesta až s čerstvými kvótami).
- **Update 12 (22. 11. 21:30, Claude):** pořadí ověřených modelů podle očekávaného času do úspěchu (medián ÷ úspěšnost):
  jeden neúspěch (dlouhá relace 37/38) odsunul ERNIE za 2× pomalejší Nemotron, teď zase vede. Kontrola zdraví i pro
  náhradníky závodu (10 modelů na tier). Bench: feature 45 s (0 výpadků), bugfix 75 s (1), project 75 s (1) a po
  rozšíření kontroly 45 s (0). Rychlost 8 → 9, Spolehlivost 6 → 7.
- **Update 13 (22. 11. 21:05, Claude):** tier Max pro změřené modely z měření místo ručních pravidel; přeměření ověřených
  před vypršením. Experiment s delším náskokem v závodě (6 s) neprůkazný: Kilo i OpenRouter v tu chvíli neodpovídaly
  (limit 200/h na IP vyčerpán dnešním měřením), ERNIE v závodě nebyla. Náskok zůstává 2,5 s. Údržba 7 → 8.
- **Update 14 (22. 11. 21:30, Claude):** měření selhaná kvůli vyčerpanému limitu (429, „cooling down“) se už nepočítají
  jako neúspěch modelu (týdenní přeměření běží na sdílených kvótách). Odolnost 8 → 9 z večerních běhů: 13 mrtvých modelů
  v čele tierů, 0 výpadků závodu, úloha dokončena.
- **Update 15 (22. 11. 21:50, Claude):** průvodce klíči končí tlačítkem „Vyzkoušet, že appka funguje“ (IPC `wizard:smoke`:
  OmniRoute běží → závodní proxy → combo tieru Max, jinak záložní proxy). Ověřeno v celé appce oběma cestami.
  Bez registrace 6 → 7.
- **Update 16 (23. 11. ~00:30, 2. Windows Claude):** Windows strana nasazení. Průvodce klíči ověřen v celé appce na Windows; čištění
  a rozpoznání vloženého klíče (`src/wizard.js` cleanKey/ownerOf/notKey, 17 vložení: špatně 14 → 0); na čistém PC se průvodce
  otevře během instalace OmniRoute (49 s místo ~475 s), `share/PRECTI.txt` opraven. Nasazení pro třídu ❓ → 6.
- **Update 17 (23. 11. 00:30, Linux Claude): věrnost vítězi v závodě** (`src/race.js`: vítěz předchozího kroku téže konverzace jde
  na první místo, `ZDARMA_RACE_STICKY=0` vypne). Bugfix A/B hned po sobě: s věrností 25 s / 20 s, bez 35 s (ve všech
  třech vyhrála ERNIE všechny kroky, takže samotný přínos věrnosti je tu malý; hlavní rozdíl proti 75 s je dostupnost
  ERNIE). S věrností dál: project 30 s, feature 55 s, dlouhá relace 38/38 za 135 s. Skóre beze změny (Rychlost 9:
  zbývá start, Jádro 9: dlouhá relace 3/4).
- **Update 18 (23. 11. 00:40, Linux Claude):** Spolehlivost 7 → 9: od rozšíření kontroly zdraví na náhradníky závodu 9 běhů
  po sobě bez jediného výpadku závodu, všech 9 úloh dokončeno (`results/czek-*-probe10-u13 … sticky-on`).
- **Update 19 (23. 11. ~07:40, 2. Windows Claude):** instalátor bez práv správce vedle přenosného exe (uživatel: „Ano, přidej
  instalátor“). Ověřeno: tichá instalace 22 s, start 1,8–2,0 s (přenosné ~24 s), přeinstalace 30 s, odinstalace 8 s beze zbytků.
  Nasazení pro třídu zůstává 6 (skutečný čistý PC a 7 min OmniRoute dál neověřené/nevyřešené).
- **Update 20 (23. 11. ~09:10, 2. Windows Claude):** složka pro třídu (`czek-ai.exe --priprav-tridu`, `share/Pripravit-tridu.cmd`):
  jedno stažení pro celou třídu místo ~1,38 GB na studenta; čistý PC bez internetu nainstaloval vše ze složky (OmniRoute 355 s).
  Nasazení pro třídu 6 → 7 (zbývá skutečný čistý PC ve škole a 7 min rozbalování OmniRoute).
- **Update 21 (23. 11. ~11:00, 2. Windows Claude):** student s diakritikou v účtu (C:\Users\Šimon Novák) se systémovým Node 24.12
  OmniRoute nenainstaloval vůbec (Node 24.12 `fs.cpSync` padá na ne-ASCII cestě, postinstall OmniRoute ho volá) → czek-ai to
  pozná a vezme přenosný Node; ověřeno celou appkou. Instalátor najde složku pro třídu vedle setupu; `--priprav-tridu` ověřeno
  ze sestaveného exe (3 pokusy na stažení, dočasná instalace v %TEMP%). Nasazení pro třídu zůstává 7 (skutečný školní PC).
- **Měření 23. 11. ~11:20 (živě, Windows, PC uživatele, tier Max, bez změny skóre):** uživatel pustil appku online a poslal
  3 reálné úkoly (validace RČ, CLI slovník, parser částek) — agent všechny dokončil, 22 kroků, hlavní model
  nvidia/nemotron-3-ultra (22/32 OK, zbytek poražení v závodě), 0 mrtvých modelů, pár deepseeků na denním limitu.
  Potvrzuje Jádro i Spolehlivost 9 na Windows v malém; skóre neměním (3 ad-hoc úlohy, ne rigorózní bench). Při tom
  opraven sebe-report (0.15.38): poražený v závodě (status 0/„aborted") se už nepočítá jako výpadek sítě, „offline" jen
  při málu úspěšných volání — jinak zdravý online běh vypadal jako offline relace a modely se schovaly.
- **Update 22 (23. 11. ~12:50, 2. Windows Claude):** složka pro třídu nese hotový OmniRoute jako archiv (tar): u studenta
  OmniRoute za 231 s místo 355–383 s, okno agenta 317 s místo 460 s (čistý PC bez internetu). Nasazení pro třídu zůstává 7.
- **Update 23 (23. 11. ~14:30, 2. Windows Claude):** veřejný tierlist https://czek-ai-tierlist.vercel.app: appka posílá
  anonymní souhrn volání (zapnuté bez ptaní, vypínač v menu) a model, který u ≥ 5 instalací nefunguje, odsune (nahoru nikdy).
  Ověřeno celou appkou (14 modelů odesláno) a živým API. Údržba zůstává 8, dokud nepřijdou data od více instalací.
- **Měření 23. 11. ~13:16 (živě, Windows, aktuální build 0.15.40, tier Max, bez změny skóre):** po sestavení 0.15.40 na
  plochu uživatel pustil **dlouhou relaci** = 3 úkoly v jedné konverzaci (rozvrh: modul kolize/volná okna → CSV/CLI →
  návrh nejbližšího volného času). Agent vše dokončil, **29 nových kroků** (celkem 51), vítěz nvidia/nemotron-3-ultra
  (55 volání, 31 OK, 0 chyb, 24 přeruš), 0 mrtvých modelů; guard správně zablokoval sérii nepovedených editů a poslal
  „načti soubor". Hlavní tlak = **free rate-limity (429)** po dni na jedné IP (particle-1 16/22, ernie 9/20, deepseeky,
  Qwen) — tasky i tak dojely díky závodu + kontrole zdraví. Skóre neměním (1 běh, ne rigorózní bench), ale je to první
  živá **dlouhá relace na Windows na aktuální appce** a potvrzuje Jádro/Spolehlivost 9. Report v
  `docs/research/2026-11-23-self-report/report-2026-11-23d-live-0.15.40.md`.
- **Oprava 23. 11. ~14:30 (Freebuff/Buffy, hlavní PC, 0.15.41): kontrola zdraví už nevyhazuje zdravé modely na 400.**
  Ze stejného živého auditu: `nefunkční 10 (nvidia/nvidia/nemotron-3-ultra-550b-a55b 400, …)` – a ten model vyhrál
  31 kroků. Kontrola posílala `max_tokens: 1`, 400 znamenalo 5min pauzu (model ven z čela tieru i ze závodu).
  Teď druhý pokus s `max_tokens: 64` (pauza až po trvalém 400) a tělo chyby v logu; report nepočítá souhrn
  kontroly zdraví jako „timeout“ (`test/omni-probe-400.js`, `test/self-report.js`). **Skóre beze změny** (Rychlost
  a Spolehlivost se zvednou až měřením; tady je opravená falešná pauza nejsilnějšího modelu, ne změřené zrychlení).
- **Update (23. 11. ~17:40, Linux Claude): spojená oprava notebook + smyčka.** Odstupňovaný závod (krok nejdřív jen
  vedoucímu modelu): skutečná cesta hned po sobě – bugfix 1,2 vs 2,0 dotazu na krok (85 s vs 175 s, obojí 8/8),
  project 1,11 vs 2,0 (80 s vs 100 s, obojí 30/30), 0 výpadků závodu → ~40–45 % méně dotazů na free limity bez
  zpomalení (pro třídu na jedné IP: Spolehlivost „30 studentů“). Gating kontroly zdraví ze smyčky (−54 % dotazů
  kontroly v mocku), kontrola modelů po průvodci z `win2/bench`. Skóre beze změny – třída a Windows dál neověřené.
- **Update (25. 11. večer, Linux Claude, 0.15.42):** guard „prázdný slib bez nástroje“, oprava preloadu okna OpenCode,
  czek-method + skills. Měřeno na skutečné cestě: úloha **repo** (27 souborů, issue, skryté testy) 29/29 2× (315 s, 40 s),
  dlouhá relace 38/38 (796 s, odpovídal GLM 4.5 Flash – rychlé modely po 2 bězích vyčerpané), scénář odmítnutí → úkol
  2/2 na Max (2×) a Mid. **Skóre beze změny:** Jádru do 10 chybí Windows; Rychlost dlouhé relace závisí na kvótách.
  Port kol 29–54 smyčky do main **nejde**: tytéž testy smyčky (failtimeout, evidence, arrange-speed) padají i na její
  vlastní větvi (`docs/research/loop-czek-perf/results/port-vs-loop-2026-11-25.txt`), zlepšení nejsou doložená.
