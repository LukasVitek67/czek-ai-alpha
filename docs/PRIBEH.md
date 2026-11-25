# Jak těžké bylo czek-ai udělat

Tenhle dokument shrnuje celý vývoj appky od prvního nápadu 6. 11. 2026 do verze 0.15.42 (25. 11. 2026). U každé
věci je popsané, co nefungovalo, proč to byl problém a jak se appka chovala před opravou a po ní. Čísla jsou
z měření, ne odhady. Kde něco změřit nešlo, je to výslovně napsané.

## V číslech

| | |
|---|---|
| doba vývoje | 20 dní (6.–25. 11. 2026), skoro denně, často přes noc |
| verze | od prvního prototypu „Zdarma“ po **czek-ai 0.15.42**, z toho 40+ vydaných verzí 0.14.x–0.15.x |
| commitů v repu | 175+ (repo vzniklo až 13. 11., první týden práce v něm není) |
| zpráv od autora AI asistentům | ~250 jen v zápisu chatu |
| vlastní kód | ~16 000 řádků (`src/`), nad tím OpenCode a OmniRoute, což jsou cizí velké projekty |
| automatické testy | **103** souborů, většina spouští skutečný OpenCode, část celou appku skrytě |
| skills přibalených k agentovi | 49 |
| výzkumných složek s měřeními | 25 (`docs/research/`) |
| kdo na tom pracoval | autor (student) + několik instancí Clauda na 3 počítačích (Windows PC, notebook, Linux PC) + lokální AI „Strata“ ve smyčce 24/7 + krátce Copilot |

## Co appka je a proč to není jednoduché

Cíl zní jednoduše: **jedna appka pro celou třídu, kde je AI agent na programování (jako Claude Code), jenže
zdarma.** Placené AI nám zrušili, takže appka musí jet jen na free modelech.

Dělá to tak, že spojuje dva hotové open-source projekty:
- **OpenCode**: samotný agent (čte a upravuje soubory, spouští příkazy, má okno),
- **OmniRoute**: směrovač, který drží klíče k desítkám free poskytovatelů AI (NVIDIA, OpenRouter, Gemini, Z.ai, Groq,
  Mistral…) a přepíná mezi nimi.

czek-ai obojí sama nainstaluje, nastaví, spustí a hlídá. Vlastní kód píšeme jen tam, kde hotový software něco
nedělá.

Proč je to těžké:
1. **Free modely jsou slabší a nespolehlivé.** Chovají se různě: jeden po pár dotazech dojde na limit, jiný visí
   45 s bez odpovědi, další vrátí odpověď ve formátu, kterému OpenCode nerozumí. Stav se mění po minutách.
2. **Tři cizí systémy, které o sobě skoro nic neví** (OpenCode, plugin OmniRoute, OmniRoute) a mezi nimi náš kód.
   Spousta chyb byla na hranici mezi nimi a nebyla vidět v žádném logu.
3. **Musí to fungovat na cizím, čistém školním PC bez práv správce**, bez Node.js a Gitu, klidně bez internetu
   při prvním startu.
4. **Agent má sám dokončit práci.** Nestačí, že model odpoví. Musí opravdu upravit soubory, spustit testy
   a nezacyklit se.
5. **Měřit se dá jen se skutečnými free kvótami**, a ty měření sama vyčerpává. Jeden den měření = zbytek dne
   limity 429.

---

## Fáze 1: vlastní appka od nuly (6.–8. 11.)

### Prototyp „Zdarma“
- **Zadání:** jedna desktopová appka jako Claude Code, se všemi free modely, které jdou sehnat.
- **Co vzniklo:** vlastní agent a vlastní proxy na free modely, tierlisty modelů (Low/Mid/High/Max + vlastní),
  přepínání po vyčerpání limitu, přehled spotřeby tokenů, výběr složky, skills (impeccable, ui-ux-pro-max…).
- **Problém:** agent byl „úplně k ničemu“. Neuměl dodělat ani jednoduchou appku, kroky se opakovaly, modely se
  každých pár sekund střídaly a pálily tokeny. Autor to popsal jako úroveň modelu z roku 2021.
- **Proč:** psát vlastního agenta od nuly je obrovská práce. Hotové nástroje (OpenCode, OmniRoute) mají za sebou
  roky ladění, které vlastní kód nemá.
- **Rozhodnutí (8. 11.):** zahodit vlastní řešení. **Appka = OpenCode + OmniRoute**, náš kód jen instaluje,
  nastavuje a hlídá. Tohle pravidlo platí dodnes a je první věta v `CLAUDE.md`.

### Grafické rozhraní, ne terminál
- **Problém:** OpenCode je hlavně terminálový nástroj. Pro spolužáky to musí být normální okno.
- **Po:** czek-ai otevírá webové rozhraní OpenCode ve vlastním okně Electronu: klasický dialog Windows pro výběr
  složky, chaty svisle vlevo, panel s limity, menu „czek-ai“ s nastavením.

---

## Fáze 2: OpenCode + OmniRoute a první stabilita (10.–13. 11.)

### Sdílení bez klíčů (10. 11.)
- **Problém:** appku chtěl používat i učitel, ale v sestavené verzi nesměly být autorovy klíče.
- **Po:** sestavená appka i zip pro učitele se před každým buildem kontrolují na klíče (`grep` na všechny známé
  tvary klíčů přes `app.asar`). Výsledek u každého buildu: 0 klíčů.

### Kontrola klíčů (nápad učitele)
- **Zadání od učitele:** služba, která pravidelně ověří platnost klíčů a rozloží zátěž.
- **Po (0.14.3):** každých 30 min se otestuje každý klíč, v Nastavení je stav a využití za 24 h. „Meta klíč“ = jeden
  lokální klíč OmniRoute, přes který jde všechno a OmniRoute zátěž rozkládá.

### Tier „Unlimited“
- **Problém:** když dojdou kredity všem, agent stojí.
- **Po:** Z.ai GLM Flash (free bez kreditů) je jako poslední záchrana na konci každého tierlistu.

### Hlídač smyček czek-guard (0.14.3–0.14.5)
Free modely se hrozně často zacyklí. Úprava OpenCode jde jen přes plugin (neupravujeme jeho binárku), takže vznikl
plugin **czek-guard** (`src/guard/`):
- **Stejné volání se stejným výsledkem 3×** → poznámka modelu, 5× → zablokováno.
- **Nepovedené edity:** OpenCode u nástroje, který skončí chybou, hook pluginu vůbec nespustí. Ověřili jsme to až
  čtením binárky. Guard proto poslouchá události a po 3 nepovedených editech souboru chce, aby si model soubor
  nejdřív přečetl.
  - Před: v jedné relaci **99 nepovedených editů, 68 za sebou** („oldString and newString are identical“).
  - Po: 4. pokus zablokovaný s vysvětlením (`test/oc-guard-fail.js`).
- **Rozbitý `opencode.json`:** dřív appka spadla a okno se neotevřelo. Teď se obnoví ze zálohy.

### Automatická instalace, úvodní okno, plug and play (0.14.6, 0.15.0)
- **Problém:** spolužák by musel ručně instalovat OpenCode, Node.js, Git a OmniRoute.
- **Po:**
  - appka sama stáhne OpenCode (ověří kontrolní součet), Git Bash i přenosný Node.js a nainstaluje OmniRoute, vše
    bez práv správce do vlastní složky;
  - úvodní okno se ukáže do ~0,5 s a ukazuje průběh.
  - Změřeno na simulovaném čistém PC: úvodní okno 0,6 s, OmniRoute nainstalován za 165 s.

### Klíče se ztratily na druhém PC (0.15.1)
- **Problém:** klíče byly jen v nastavení šifrovaném Windows účtem. Na jiném PC byly pryč a domácí PC bylo offline.
- **Po:** klíče se synchronizují přes soubor v soukromém repu. Při tom se našla další chyba: po rychlém ukončení
  appky se nezapsal šifrovací klíč, takže uložené klíče šly příště nečitelné.
- (Ve veřejném alpha repu tohle nikdy není. Od 23. 11. appka sama soubor s klíči v klonu repa nezaloží, aby
  spolužák omylem nenahrál své klíče na GitHub.)

### Dva AI asistenti na dvou PC si přepsali práci (13. 11.)
- **Problém:** Claude na druhém PC nahrál verzi bez kontextu a přepsal tu dobrou.
- **Řešení:** vrácení, kontrola commit po commitu, sloučení jen toho, co prošlo testy. Od té doby **povinný
  `HANDOFF.md`** (stav, co je ověřené a jak), **zápis celého chatu** a pravidlo „před prací vždy `git pull`“.
  Tenhle dokument z nich vychází.

---

## Fáze 3: „proč je to pořád tak špatné“ – měřit, ne hádat (13.–15. 11.)

Autor: *„use TESTS, why are you guessing when you can monitor 100 % of the app“*. Odsud se každá oprava měří před
a po.

### Seznam úkolů, který nikdy nezmizel (0.15.4, 0.15.5, 0.15.9)
- **Problém:** v okně pořád viselo „0 of 6 todos completed“, i když se nic nedělo.
- **Proč (3 příčiny naráz):**
  1. Z.ai vracel 529 (přetížení), tier neměl zálohu a **OpenCode opakuje chyby bez horní hranice**. Relace tak
     nebyla nikdy hotová a seznam se kreslí, dokud hotová není.
  2. Model zavolal `todowrite` jednou za 599 kroků a už nikdy. API OpenCode seznam smazat neumí.
  3. Autor dál spouštěl starou verzi z plochy, takže opravy neviděl.
- **Po:**
  - guard po 3 opakováních relaci zastaví (`test/oc-guard-retry.js`: 3 pokusy, hotovo za ~10 s místo donekonečna);
  - tier Unlimited má zálohu;
  - `todowrite` je vypnutý (ušetří ~750 tokenů na krok) a starý seznam je skrytý;
  - lišta „Na ploše je novější czek-ai → Restartovat do nové verze“.

### Edity po jednom řádku „+1 −1“ (0.15.4, 0.15.5)
- **Problém:** model upravoval soubor po jednom znaku: edit, kontrola, edit, kontrola…
- **Proč:** psal `cargo check 2>&1 | head -30`, takže viděl jen první chybu. Opravil jeden řádek a kontrolu
  spustil znovu. Každý krok přitom posílá celý kontext (~65 000 tokenů) znovu přes pomalý free model.
- **Po:**
  - guard před spuštěním přepíše `| head -5` na `| head -200` (`test/oc-guard-widen.js`: model vidí všech 60
    chyb, ne 5);
  - po každém editu guard sám spustí kontrolu (`cargo check` / `tsc`) a chyby připíše k výsledku editu.
  - Změřeno na živé relaci: krok s jediným nástrojem **97 % → 50 %**, model sám spouštěl `cargo check` **90× → 2×**.
    Autor: „začíná to vypadat dobře“.

### „Prompt exceeds max length“ (0.15.6, 0.15.13)
- **Problém:** dlouhá relace skončila chybou a nepokračovala.
- **Proč:**
  - OpenCode zkracuje kontext podle tokenů *minulého* kroku a přetečení pozná jen podle seznamu hlášek, kde
    hláška Z.ai není;
  - OmniRoute navíc hlásí u auto modelu kontext 1 050 000, takže OpenCode nezkrátil nikdy.
- **Po:**
  - guard přetečení pozná a nechá OpenCode kontext zkrátit a pokračovat;
  - plugin OmniRoute dostane strop 96 000 a OpenCode pak zkracuje sám včas.
  - Test: s guardem zkrátí a pokračuje, bez guardu skončí chybou jako u autora.

### Žádné modely ve výběru – „No model results“ (0.15.7, 0.15.8, 0.15.17)
- **Problém:** autor otevřel appku a výběr modelů byl prázdný. Appka byla nepoužitelná.
- **Proč (každý den jiná příčina):**
  1. OpenCode má instanci na každou složku. Plugin OmniRoute stahuje modely jednou s limitem 10 s, a když OmniRoute
     zrovna startoval, zůstala instance prázdná až do restartu.
  2. czek-ai mazala diskovou cache pluginu při každém zápisu konfigurace.
  3. Na čistém PC plugin potřeboval balíček, který OpenCode doinstaluje až později. Neúspěšný import si OpenCode
     pamatoval, takže žádný poskytovatel nebyl a hlídač instanci zahazoval každých 6,6 s donekonečna.
- **Po:**
  - hlídač instancí: prázdnou instanci zahodí a načte znovu;
  - cache se maže jen při změně;
  - OpenCode startuje, až OmniRoute vrací modely;
  - plugin bez závislosti.
  - Změřeno: zotavení 56 s → 35 s; druhý start bez OmniRoute **0 → 195 modelů** hned (z cache).
- Kvůli tomu vznikl **nový způsob testování**: celá appka se spustí skrytě na kopii stavu autora a skript dělá
  přesně to, co člověk (otevře relaci, každých 5 s otevře výběr modelu a spočítá modely).

### Úplný log všeho (0.15.9)
- **Zadání:** „chci aby appka logovala doslova všechno“.
- **Po:** jeden soubor za den obsahuje všechno, co se děje: zprávy, myšlení modelu, nástroje i s celým vstupem
  a výstupem, OmniRoute, guard, pády oken. Bez ořezávání, jen klíče se maskují. Z tohoto logu vychází většina
  pozdějších oprav.

### Pomalost změřená, ne odhadnutá (0.15.10, 0.15.12)
- **Problém:** „všechno trvá strašně dlouho“.
- **Změřeno:** medián kroku 7,5 s, ale p90 55 s a nejhorší 100–193 s. Jeden model (NVIDIA DeepSeek) **14× zkoušen,
  0× odpověděl, pokaždé 45 s** čekání. Později v DB: 39× visel, 0× odpověděl.
- **Proč:** stav 499 (náš vlastní časový limit) se nepočítal jako „visel“ a mrtvé modely zůstávaly v řadě.
- **Po:** visící a mrtvé modely jdou z řady ven a čím víc visí, tím déle (20 min / 2 h / 12 h / 3 dny / 7 dní,
  pamatuje se i přes restart). Přehráno na skutečných datech: zbytečné čekání **1218 s → 902 s**, u DeepSeeku
  **496 s → 181 s**, bez jediného ztraceného úspěchu.

### Model neuvažoval (0.15.14)
- **Zjištění:** „samotné OpenCode s jedním modelem funguje super, proč naše ne?“ Nahrání požadavků ukázalo, že
  samotné OpenCode posílá GLM `thinking: enabled`, kdežto přes OmniRoute **nic** → **GLM (202 z 286 volání) běžel
  bez uvažování.**
- **Po:** guard ke každému dotazu přidá `reasoning_effort: medium` a OmniRoute ho převede pro každého poskytovatele
  zvlášť (`test/oc-reasoning.js`).

### Model nevěděl, na jakém počítači je (0.15.15)
- **Problém:** model zkoušel linuxové `ls` (ve skutečnosti volal neexistující nástroj `ls`), nevěděl, že je na
  Windows s Git Bashem.
- **Po:** každý dotaz obsahuje krátký oddíl o počítači: OS, Git Bash a cesty `/c/…`, jaké nástroje existují,
  složky Plocha/Dokumenty, nástroje na PATH (~700 znaků).
- **Instalace OmniRoute** ukazuje skutečný průběh v úvodním okně. Rozbalení 174 000 souborů trvá ~5 min a dřív
  byl vidět jen titulek „instaluje se (0 min)“. Autor proto appku 2× zavřel a instalace začala znovu.

### Hledání souborů trvalo 160 s (0.15.16, 0.15.19)
- **Problém:** `glob **/*.ts` vrátil 100 výsledků skoro jen z `node_modules` (91 % souborů ve složce) a skutečné
  soubory se ztratily. `glob` s cestou `/` prohledával celý disk 160 s, `grep` v `~/.cargo` 225 s.
- **Po:** guard má vlastní `glob`/`grep`: vynechá `node_modules`, `target`, `.venv`…, u celého disku nebo domovské
  složky ještě víc a má časový strop 15 s. Dotaz s guardem trval 2,3 s, bez něj 4,9 s.

### Velký audit „proč je to tak špatné“ (0.15.17)
Srovnání na stejném úkolu (opravit projekt, dokud neprojde 8 testů, skutečné modely):

| | čas úkolu | ztraceno na neúspěšných pokusech | start |
|---|---|---|---|
| čisté OpenCode + 1 model | 106–145 s | – | 1,4 s |
| czek-ai **před** (0.15.16) | **482 s** | **331 s** (DeepSeek 6× visel 45 s) | **145 s** |
| czek-ai **po** (0.15.17) | 135–274 s | 8–48 s | 58–80 s |

Příčiny:
1. **Vyřazování mrtvých modelů v ostré appce nikdy neběželo.** OmniRoute s filtrem `excludeTests=1` vracel prázdný
   seznam, takže od 0.15.10 do 0.15.16 statistiky dostávaly 0 řádků. V testech to fungovalo, v ostré appce ne.
   Živě: **64,6 z 97 minut čekání na limit 45 s**, DeepSeek 103 pokusů a 0 odpovědí.
2. **Modely se střídaly uprostřed úkolu:** 6 různých modelů na úkol a model, který převzal cizí konverzaci, napsal
   volání nástroje jako text (`<tool_call>…`). OpenCode to vzal jako konec a agent skončil po 4 krocích.
   - Po: nespolehlivé modely jdou dozadu;
   - guard pozná volání nástroje napsané jako text a pošle výzvu.
3. Výstup 8192 tokenů plus uvažování: model spotřeboval všechno na přemýšlení a skončil bez akce (4 ze 4 případů
   čekaly na ruční „Continue“). Po: 16 000 tokenů a guard pokračuje sám.
4. **Start 145 s:** při každém startu 258 požadavků za 93 s. Po: nezměněné se přeskočí, sync **93 s → 12–15 s**,
   okno **149 s → 53–62 s**.
5. Systémový prompt 42 400 znaků (49 skills) → 33 300 (jen přibalené skills).

**Co konfigurací opravit nejde:** free modely jsou řádově slabší než Claude. Po auditu czek-ai na stejném úkolu
odpovídá čistému OpenCode s jedním free modelem, ne Claude Code.

---

## Fáze 4: agent, který se nezasekne (19.–21. 11.)

### Bash visel na spuštěné appce (0.15.18)
- **Změřeno (audit relace 203 min):** bash zabral 70 min.
  - spouštění appky: 55× a 31 min;
  - `cargo build --release`: 14× a 26 min;
  - dev server: 12× a 7 min.
- **Proč:** známá chyba OpenCode na Windows. Nástroj čeká, dokud proces na pozadí drží jeho výstup, a po 120 s
  zabije i appku.
- **Po:** guard dlouho běžící příkaz pozná (26 skutečných příkazů z relace v testu) a spustí ho celý na pozadí
  s logem. Appka běží dál a před dalším buildem ji guard ukončí (jinak „Access is denied“ na zamčeném .exe).
  Dev server běží za **13–18 s místo 120 s**.

### Nejsilnější modely byly vzadu (0.15.18, 22. 11.)
- **Měření na těžší úloze** (15 testů):
  - GLM 4.5 Flash 13/15 a nedokončil (485 s);
  - tier Max 15/15 za 120 s;
  - Gemini 3.6 Flash 15/15.
- **Po:** pořadí podle měření.
  - 22. 11.: particle-1 a ERNIE 5.5 Flash dopředu, **320 s → 130 s**.
  - Později pořadí určují jen výsledky benchmarků (`src/evidence.js`, staré výsledky po 45 dnech vyprší, každý
    týden se samo přeměří).

### Plné hlášky kompilátoru a pokračování při rozbitém buildu (0.15.21)
- **Problém:** model po 83 editech napsal „stuck fixing 3 errors. Next: fix these errors“ a skončil. Relace stála
  do rána. Řešení bylo v řádku `help:` plné hlášky rustc, který model neviděl.
- **Po:** kontrola po editu dává plné hlášky prvních chyb. Když agent skončí s rozbitým buildem a neptá se
  uživatele, guard pošle „pokračuj“.

### Závod modelů (0.15.21, 0.15.23)
- **Zadání:** „ať s promptem běží několik modelů najednou“.
- **Po:** každý krok jde naráz na víc modelů, vyhraje první, kdo opravdu začne odpovídat. Za vypadlé hned
  nastupují náhradníci.
  - Změřeno: **351 / 208 / 319 s → 211 / 136 s**, vše 15/15; nejdelší krok 58–108 s → 35–59 s.
- **Cena:** víc dotazů na free limity. Proto výchozí 2 modely místo 3.
- **Slepá ulička:** jedna mezi-verze dopadla 4/15, protože vyhrál pomalý slabý model z hloubky tieru. Proto
  závodí jen prvních 6 modelů a silnější má 2,5 s přednost.

### Monitor a úplný záznam volání (0.15.22)
- **Po:** okno Monitor (Ctrl+Shift+D) ukazuje:
  - jaké modely fungují, úspěšnost, časy a tokeny/s;
  - 13 druhů upozornění;
  - celý obsah každého volání (co přesně model dostal a co vrátil).
- **Co hned ukázal:** většina pokusů selhává na denních free limitech a ty z velké části vyčerpalo naše vlastní
  měření.

### Agent nevidí obrázky ani appku, kterou staví (0.15.24)
- **Problém:** autor poslal obrázek („album covers cover the text… why do you not test the app?“). OpenCode ho
  modelu vůbec nedal, poslal jen „ERROR: Cannot read image“ a model to ignoroval.
- **Po:**
  - obrázek se uloží do projektu a model s viděním ho popíše;
  - agent má nový nástroj **`look`**: udělá snímek okna appky (i za jinými okny) a nechá si ho popsat. Pokyn
    agentovi: nikdy neříkat, že GUI funguje, bez podívání.
- Plus: Kimi K3.1 byl v 57 závodech a ani jednou nezačal odpovídat, takže každý krok stál dotaz navíc. Teď závodí
  jen spolehliví.

### Model „vyřazený na 41 dní“ (0.15.25)
- **Problém:** OmniRoute po jedné odpovědi 429 dal modelu pauzu na týdny.
- **Změřeno:** OVH bez klíče má **1 dotaz na model a IP za rok** (hlavička `x-ratelimit-limit-year: 1`), ne
  2 za minutu, jak píše jejich dokumentace. Pauza tedy byla pravdivá. Chyba byla v tom, že czek-ai ji neviděla
  a model zkoušela každých 90 s.
- **Po:** czek-ai pauzy vidí, model nezávodí a po 30 min to zkusí znovu. Pokusy o model v pauze **18 → 0**.

---

## Fáze 5: spolupráce víc AI a lokální AI (21.–23. 11.)

### Lokální AI „Strata“ a smyčka 24/7
- Na Linux PC (RTX 3060 12 GB) běží lokální model Qwen3.8 (125B celkem, 6B aktivních) 38–43 tokenů/s.
- **Smyčka `strata-loop`:** zadá se úkol jednou a lokální AI na něm pracuje dokola 24/7. Každé kolo navrhne
  změnu, soudce ji posoudí a pushnou se jen přijatá kola, do zvláštní větve.
- **Problémy smyčky:**
  - 1. kolo zahltilo kontext 19× a překládalo komentáře, takže dostala rozpočet a pravidla;
  - kontrola klíčů jednou zamítla dobré kolo, protože našla náhodná data písma podobná klíči;
  - větev smyčky se opakovaně vzdálila od main (jednou nesla volání neexistující funkce, které by shodilo start
    appky).
  - Proto do main jde kód ze smyčky **jen po revizi a testech**. Na to vznikl test celé appky
    `test/app-omni-start.js`.
- **Přínos smyčky:**
  - změřila všechny poskytovatele (Gemini 8 z 25 modelů funguje, Groq free nepoužitelný pro agenta: 1000
    výstupních tokenů/min);
  - zvedla strop výstupu (Groq jinak usekl odpověď na 3072);
  - zrychlila kontrolu zdraví modelů po startu.
- PC neusíná, aby smyčka běžela i v noci.

### Kontrola zdraví po startu
- **Problém:** první kroky relace narážely na modely, které zrovna nefungovaly.
- **Po:** po startu se pošle drobný dotaz na první modely každého tieru a nefunkční jdou dozadu dřív, než se na
  ně agent zeptá.
  - Výpadky závodu **4 → 1 → 0**;
  - **9 běhů po sobě 0 výpadků, 9/9 úloh dokončeno**;
  - i při přiškrcených poskytovatelích našla 13 nefunkčních modelů předem.

### Průvodce klíči (22. 11.)
- **Problém:** bez klíčů appka nefunguje: **0/15 testů**. Free modely bez klíče mají limit na IP adresu a celá
  třída sdílí jednu.
- **Po:** průvodce se otevře sám, provede 7 službami (proč tahle, jak získat klíč, odkaz). Každý klíč hned ověří
  skutečným dotazem a na konci je „Vyzkoušet, že appka funguje“.
- **Čištění vloženého klíče:** studenti vkládají klíče s mezerami, uvozovkami, `Bearer`, nebo do špatného kroku.
  Z 17 typických vložení se špatně uložilo **14 před, 0 po** (klíč jiné služby se pozná podle začátku a uloží
  tam, kam patří).
- **Na čistém PC** se průvodce otevře během instalace OmniRoute, tedy **za 49 s místo ~7 min**.

### Instalátor místo přenosného exe
- **Problém:** přenosné exe se při každém startu celé rozbalí, takže první okno se ukázalo až za **23–25 s**
  a student mezitím klikal znovu.
- **Po:**
  - obrázek „Spouštím se… Neklikej znovu“ za 1,9 s;
  - **instalátor bez práv správce: start ~2 s místo ~24 s.**

### První start bez internetu
- **Po:** místo anglického „fetch failed“ a chybového dialogu je v úvodním okně česky „Není připojení“ a appka
  zkouší znovu každých 10 s.

### Odstupňovaný závod (23. 11.)
- **Problém:** souběžný závod posílal každý krok na 2 modely, takže dvojnásobná spotřeba free limitů. Ve třídě
  na jedné IP to je kritické.
- **Po:** krok jde nejdřív jen vedoucímu modelu. Druhý startuje, až když vedoucí neodpoví v obvyklém čase, nebo
  hned, když vypadne.
  - Skutečná cesta: **2,0 → 1,2 dotazu na krok, 175 s → 85 s**, obojí 8/8 testů.

### Veřejné ALPHA repo (23. 11.)
- `github.com/LukasVitek67/czek-ai-alpha` pro spolužáky a učitele: nová historie bez soukromých dat.
- Každá aktualizace prochází skriptem, který kontroluje všechny skutečné klíče doslova, vzory klíčů a osobní údaje.
- Instalátor v Releases (sestavený na Linuxu přes wine).

---

## Fáze 6: první skuteční uživatelé (25. 11.)

### „Jasně, tady to máš“ a nic (0.15.42)
- **Hlášení:** kamarád se nejdřív zeptal na něco zakázaného, model odmítl. Pak napsal „udělej mi webovou stránku“,
  model odpověděl „jasně, tady to máš“ a nic nevytvořil.
- **Změřeno se skutečnými modely** (stejný scénář: odmítnutá zpráva, pak úkol):
  - Max 2/2 a Mid 2/2: web opravdu vznikl;
  - High se nejdřív zeptal, co má na webu být.
  - To, že by odmítnutí „otrávilo“ další zprávu, se nepotvrdilo. Symptom ale existuje: model občas odpoví jako
    by hotovo, bez jediného nástroje.
- **Po:** když zadáš úkol a celé kolo proběhne bez nástroje a odpověď zní jako „hotovo / tady to máš“ (nebo je
  kód jen v chatu), guard jednou pošle výzvu to opravdu udělat. Nespustí se, když se model ptá, odmítá, nebo když
  zpráva úkol není (`test/oc-promised.js`, 5 scénářů na skutečném OpenCode).

### Panel okna OpenCode nefungoval od 0.15.28
- **Nalezeno při hledání jiné chyby:** pomocný skript okna OpenCode běží v sandboxu, kde nejde načíst vlastní
  soubor. Optimalizace z 0.15.28 přidala `require` vlastního souboru, takže **celý skript padal**: nefungoval
  výběr složky přes czek-ai, rozvržení, panel Limity ani přehrávač. Žádný test to nechytil, protože okno OpenCode
  se testovalo bez kontroly konzole.
- **Po:** opraveno a nový test hlídá, že žádný takový skript nenačítá nic jiného než `electron`.

### Průvodce se „neotevírá“
- **Proč:** na čistém PC se průvodce otevřel během instalace, ale pak ho překrylo okno OpenCode.
- **Po:** po otevření OpenCode se průvodce přenese dopředu, dokud není žádný klíč.

### Agent „přemýšlí jako Claude“
- **Po:**
  - do každého dotazu jde postup práce: pochopit, podívat se, malé kroky, ověřit, dokončit;
  - směrovač „jaký úkol → které skills“, takže agent si skills bere sám, bez napsání v promptu;
  - 10 praktických skills (ladění, testy, kontrola kódu, refaktoring, výkon, bezpečnost, git, nový projekt,
    průzkum, vzhled; u vzhledu i impeccable a ui-ux-pro-max).

---

## Opakující se lekce

1. **Hotový software místo vlastního.** Vlastní agent od nuly byl nepoužitelný. OpenCode + OmniRoute fungují,
   náš kód jen lepí a hlídá.
2. **Měřit, ne hádat.** Polovina „oprav“ před zavedením měření nic neopravila. Až testy se skutečným OpenCode,
   celou appkou a skutečnými modely ukázaly, kde je problém. Několikrát byla oprava správná v testu a v ostré
   appce neběžela vůbec (filtr `excludeTests`, sandbox preloadu).
3. **Chyby jsou na hranicích.** OpenCode × plugin × OmniRoute × free poskytovatel. Každý se chová „správně“ podle
   sebe a dohromady to nefunguje (uvažování, kontext 1 050 000, prázdný katalog, pauza na rok).
4. **Free kvóty jsou sdílené a měření je spotřebovává.** Srovnání se dělá ve dvojicích hned po sobě, jinak čísla
   lžou.
5. **Uživatel spouští starou verzi.** Několik oprav „nefungovalo“, protože na ploše běžela starší exe. Proto lišta
   nové verze a instalátor.
6. **Poctivé skóre.** Skóre se zvedá jen s důkazem (`docs/SCORECARD.md`). Co nejde změřit (skutečná třída,
   skutečný čistý školní PC), skóre nedostane.

## Aktuální poctivé hodnocení (`docs/SCORECARD.md`)

| Oblast | Skóre |
|---|---|
| Jádro: agent dokončí úlohu | 9/10 |
| Rychlost | 9/10 |
| Spolehlivost na nové instalaci | 9/10 |
| Odolnost (mrtvé/visící modely) | 9/10 |
| Údržba (aktuálnost modelů) | 8/10 |
| Nasazení pro třídu | 7/10 (chybí ověření na skutečném školním PC) |
| Bez registrace | 7/10 (bez klíčů free modely na sdílené IP nefungují, řeší to průvodce) |

Co se kódem opravit nedá: free modely jsou slabší než placené. czek-ai je dnes na úrovni nejlepšího samostatného
free modelu nebo rychlejší, a navíc se nezasekne, nezacyklí a pozná mrtvé modely. Na Claude Code to ale pořád
není.
