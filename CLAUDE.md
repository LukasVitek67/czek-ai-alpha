# czek-ai: pokyny pro AI asistenty (Claude Code apod.) – ALPHA

Desktopová aplikace (Electron, Windows) = **OpenCode + OmniRoute**. czek-ai obojí nainstaluje, spustí a nastaví (klíče,
tierlisty, skills, pojistky proti smyčkám). Agent je OpenCode, směrování modelů je OmniRoute. Vlastní kód jen tam, kde
hotový software něco nedělá. Projekt je **alpha** a vyvíjí ho třída společně – pracuj po malých krocích s pull requestem.

**Než začneš:** přečti `README.md`, `CONTRIBUTING.md` a `docs/SCORECARD.md` (co je ověřené a co chybí).

## Tvrdá pravidla

- **Klíče nikdy do repozitáře** – ne do zdrojáků, testů, dokumentace, issue, PR ani sestavené appky. Repo je VEŘEJNÉ.
  Před commitem: `grep -rE "(sk-or-v1-|nvapi-|gsk_|hf_|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{16,}" src test docs share site`
  musí být prázdné. Testy se skutečnými klíči čtou `private/keys.json` – ten si vytvoř jen u sebe (je v `.gitignore`).
- **Testy nikdy na skutečném profilu.** Vždy dočasné `ZDARMA_USER_DATA`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_STATE_HOME`, `XDG_CACHE_HOME`, vlastní porty (`ZDARMA_OC_PORT`) a `ZDARMA_HIDDEN=1`. Nikdy junction/symlink do
  skutečných dat.
- **Žádná okna a dialogy**, na které by musel někdo klikat. Testovací Electron jen skrytě.
- Nepoužívat uniklé klíče, nevydávat se za oficiální klienty (OAuth předplatných přes proxy ne).
- Zásahy do OpenCode **pluginem** (`src/guard/`), ne patchováním binárky.
- JS neupravovat přes `node -e "…"` v shellu; použij editor nebo patch soubor.
- **Měř před a po.** Bez čísel netvrď, že změna pomohla (benchmark: `docs/research/2026-11-22-claude-e2e/bench-czek.js`).
  Skóre v `docs/SCORECARD.md` se mění jen s důkazem.
- Po změně `src/main.js` appku opravdu spusť (např. `test/app-omni-start.js`): `node --check` nechytí chybu při startu.
- Komunikace a texty v appce česky (i18n v `src/i18n.js`, angličtina vedle).

## Build a testy

```bash
npm run dist:desktop      # build portable exe + na plochu jako czek-ai.exe
npm run dist:setup        # instalátor bez práv správce dist/czek-ai-<verze>-setup.exe (start 2 s místo ~24 s); test: docs/research/2026-11-23-win2-install/setup-test.ps1
node test/guard.mjs       # jádro hlídače smyček
node test/oc-guard.js     # hlídač na skutečném OpenCode s falešným modelem
node test/oc-guard-fail.js  # nepovedené edity + todowrite smyčka na skutečném OpenCode
node test/oc-guard-retry.js # 529 dokola → guard zastaví opakování po 3 pokusech (seznam úkolů zmizí)
node test/oc-guard-widen.js # `… | head -5` u kontroly → guard příkaz rozšíří, model vidí všechny chyby
node test/oc-autocheck.js   # cargo check sám po editu, todowrite vypnutý, přímí poskytovatelé přes OmniRoute
node test/fullauto.js
node test/oc-overflow.js    # „Prompt exceeds max length“ (Z.ai) → guard zkrátí kontext a OpenCode pokračuje
node test/oc-watch.js       # instance OpenCode bez modelů (OmniRoute startoval) → hlídač ji znovu načte
node test/oc-auto-context.js # auto/coding hlásí 1 050 000 → czek-ai strop 96 000, OpenCode po 90k tokenech sám zkrátí
node test/oc-reasoning.js   # přes OmniRoute reasoning_effort medium (jinak GLM bez uvažování), bez omniroute_sync_models
node test/oc-system.js      # oddíl o počítači a uživateli (OS, Git Bash, žádný nástroj ls, účet, složky) v systémovém promptu
node test/oc-search.js      # glob/grep z czek-guard bez node_modules (rg si najde a zkopíruje sám), časový strop, velký kořen
node test/oc-reviewer.js    # kontrolní subagenti reviewer/reviewer-alt v konfiguraci (vzájemná kontrola přes task)
node test/self-report.js    # sebe-audit: report o výkonu z logů (síť vs mrtvý model, start, maskování klíčů)
node test/oc-recover.js     # matcher auto-zotavení okna OpenCode po pádu markdown workeru
node test/oc-length.js                                # useknutý krok (finish=length) nebo volání nástroje napsané jako text → guard sám pošle výzvu, max 2× za 10 min
node test/omni-sync-skip.js                           # start: sync přeskočí combo, která už v OmniRoute jsou (0 zápisů při 2. startu)
node test/oc-lean.js                                  # čistý profil: plugin OmniRoute bez závislosti na @opencode-ai/plugin, výstup combo 16 000, jen povolené skills v promptu
node test/omni-flaky.js                               # nespolehlivý model (≥ 25 % pokusů bez odpovědi za 30 min) jde za spolehlivé
node test/omni-hang-memo.js                           # řada visení přežije restart (zdarma-sync.json): chronicky visící model venku až 7 dní
node test/guard-launch.mjs                            # které příkazy jsou appka / dev server (26 skutečných z relace) a jak je guard spustí na pozadí
node test/oc-launch.js                                # appka/dev server na pozadí za ~15 s místo 120 s, běží dál, před cp/buildem ukončena; build dostane limit 10 min
node test/omni-pause-persist.js                       # pauzy/odsunutí z kontroly zdraví přežijí restart (zdarma-sync.json)
node test/race-sticky.js                              # věrnost vítězi: vítěz kroku vede další krok téže konverzace, po výpadku přejde (ZDARMA_RACE_STICKY=0 vypne)
node test/race-quota.js                               # combo bez volného limitu (cooling down/429/402) → česká hláška s Průvodcem klíči, status zachován
node test/race.js                                     # závod modelů (src/race.js): krok agenta na 3 modely najednou, vyhraje první odpovídající (silnější do 2,5 s má přednost), náhradníci za vypadlé, paměť selhání, odsunutí mlčících, hlídač zmlklého vítěze, záloha combo; výběr z prvních 6 a různých modelů
node test/oc-race.js                                  # závod na skutečném OpenCode + pluginu OmniRoute: relace se 2 kroky s pomalým modelem v čele ~20 s → ~9 s; zmlklý vítěz → guard pokračuje
node test/guard-autocheck.mjs                         # kontrola po editu: plné hlášky rustc (help/note) pro první chyby, poznámka „změň přístup“ po 4 stejných kontrolách
node test/oc-autocheck.js                             # (rozšířený) plná hláška rustc u editu; agent skončí s rozbitým buildem → guard sám pošle pokračování
node test/call-log.js                                 # úplný záznam volání (src/callLog.js + odbočka v race.js): dotaz i odpověď celé, zprávy jednou za den, klíče zamaskované, čtení zpět
node test/monitor.js                                  # monitor (src/monitor.js): stav modelů (funguje/mrtvý/limit/…, úspěšnost, časy, tokeny/s) a 13 druhů upozornění
node test/omni-cooldowns.js                           # pauzy modelů v OmniRoute (syncCooldowns): mimo závod i vidění, monitor „pauza OmniRoute do …“, smazání po 30 min, reset_seconds v závodě
node test/omni-pause-live.js                          # skutečný OmniRoute (dočasná složka) + OVH: 429 → pauza ~41 dní → czek-ai ji vidí, po reprobeMs znovu závodí (OVH_MODEL = model s vyčerpaným ročním limitem)
APP_EXE=none OVH_PAUSE_MODEL=nemotron3-nano-30b node test/app-monitor.js  # + v celé appce: 429 od OVH → okno Monitor ukáže pauzu OmniRoute do 1. 1.
node test/app-monitor.js                              # CELÁ appka: skutečný dotaz, okno Monitor (součásti, modely, volání), detail volání s dotazem a odpovědí, logs/calls bez klíčů, monitor-now.json (APP_EXE=none = ze zdrojáků)
node test/vision.js                                   # obrázek od uživatele → soubor v projektu (.czek/obrazky) + popis od modelu s viděním; proxy: modely bez obrázků; /czek/vision
node test/guard-look.mjs                              # nástroj look: snímek okna (i mimo obrazovku) přes PrintWindow, popis přes /czek/vision, bez titulků cizích oken
node test/oc-vision.js                                # skutečné OpenCode + plugin: tier combo přijme obrázek (dřív „Cannot read image“), model dostane cestu + popis; agent má look
APP_EXE=none node test/app-vision.js                  # CELÁ appka, skuteční modelové: obrázek s nápisem → model s viděním → tier Max odpoví, co na něm je
# Ladění: <userData>/logs/monitor-now.json (stav každých 15 s), logs/calls/<den>.jsonl + .msgs.jsonl (celé dotazy a odpovědi), logs/<den>.jsonl (úplný log)
BENCH_TASK=feature node docs/research/2026-11-19-audit/scripts/bench-ab.js czek <out> zdarma-max  # těžší úloha (15 testů) v celé appce s daným modelem
# CELÁ APPKA na kopii tvého stavu (jen čte tvůj profil; tvoje appka musí být zavřená):
node test/app-replica.js    # spustí sestavenou appku skrytě s CDP 9341 (APP_EXE=none = ze zdrojáků); ovládání: node test/app-cdp.js 9341 eval|shot …; REPLICA_CDP_PORT=9342, když 9341 drží mrtvá zásuvka
APP_EXE=none node test/app-models.js                  # výběr modelu očima uživatele, časová osa
APP_EXE=none INDUCE=startup node test/app-models.js   # OmniRoute při startu neodpovídá pluginu → prázdný výběr → měří zotavení
APP_EXE=none node test/app-models-restart.js          # 2. start bez OmniRoute → modely z diskové cache pluginu
node test/app-fulllog.js                              # úplný log v celé appce se skutečným dotazem (12 kontrol, 0 klíčů) + skrytý seznam úkolů
node test/fulllog.js                                  # jádro úplného logu
APP_EXE=none node test/app-ui.js                      # přehrávač nad promptem, skrytý seznam úkolů, součty v Kontextu, lišta nové verze
node test/upgrade.js                                  # přechod na novější czek-ai-X.Y.Z.exe z plochy (zamčená exe; i když běží czek-ai-X.Y.Z.exe)
node test/oc-caveman.js                               # skill caveman trvale zapnutý: pravidla v systémovém promptu každého dotazu
node test/omni-dead.js && node test/omni-limited.js && node test/omni-rebalance.js  # mrtvé/visící modely ven z combo (visí dál → 20 min/2 h/12 h)
node test/oc-config-repair.js
node test/installer.js    # automatická instalace OpenCode (ZDARMA_SKIP_NET=1 bez stahování)
node test/app-splash.js   # celá appka skrytě: úvodní okno + stažení OpenCode (APP_EXE=dist/win-unpacked/czek-ai.exe)
PLUG=1 node test/app-splash.js  # čistý PC: i Git, Node.js, OmniRoute na pozadí a přepnutí na něj (~5–15 min)
node test/installer-tools.js    # skutečná instalace Node/Git/OmniRoute do dočasné složky a start OmniRoute
node test/keysync.js      # klíče v private/keys.json (i průchod šifrovaným nastavením appky)
node test/oc-agent-config.js
# Bez globálního OpenCode: npm i --prefix <tmp> opencode-ai@1.19.5 a OPENCODE_BIN=<tmp>/node_modules/opencode-windows-x64/bin/opencode.exe
OPENCODE_BIN=<opencode> ZDARMA_OMNIROUTE_ROOT=<omniroute> node test/app-omni-start.js  # CELÁ appka: start s OmniRoute až po kontrolu zdraví (>0 modelů, 0 chyb z main.js) + „Vyzkoušet, že appka funguje“ z průvodce přes OmniRoute + závod
node test/omni-probe-pause.js && node test/omni-probe-slowpass.js  # pauzy z kontroly zdraví vydrží, pomalé modely na konec (mock)
node test/omni-probe-400.js    # kontrola zdraví: 400 na drobný dotaz (max_tokens 1) → druhý pokus, pauza až po trvalém 400, tělo chyby v logu
node test/evidence.js                                 # ověřené modely z měření (src/evidence.js, src/model-evidence.json): vypršení 45 dní, pořadí, chyby protokolu se nepočítají
node tools/model-evidence.js ingest && node tools/model-evidence.js show  # po každém benchmarku: výsledky → src/model-evidence.json (týdně sám: czek-model-evidence.timer)
node test/wizard.js                                   # průvodce klíči: kroky = poskytovatelé s klíčem, texty cs/en, kdy se otevře sám
node test/wizard-paste.js                             # co student vloží: Bearer/uvozovky/NAZEV= pryč, cizí klíč podle prefixu ke správné službě, odkaz/e-mail odmítnut
node test/class-cache.js                              # složka pro třídu: jen s manifestem, poškozený soubor se nepoužije (CLASS=<složka> + OpenCode bez internetu)
PLUG=1 CLASS=<…/czek-ai-cache> node test/app-splash.js  # čistý PC bez internetu (npm přes mrtvý proxy): vše ze složky pro třídu (czek-ai.exe --priprav-tridu), OmniRoute 355 s
DIACRITIC=1 CLASS=<…/czek-ai-cache> node test/app-splash.js  # profil „účet Šimon Novák“ + systémový Node 24.12 (fs.cpSync padá s diakritikou) → přenosný Node, OmniRoute nainstalován
node test/public-tier.js                              # veřejný tierlist (src/publicTier.js): souhrn volání, „dav jen shazuje“, testy nikdy na produkci, odsunutí v combo
node site/dev-server.js 4870                          # lokální náhled webu tierlistu + API proti Supabase (site/.env.local, není v gitu)
node test/wizard-links.js                             # odkazy „Otevřít stránku“ všech kroků průvodce jdou otevřít (síť)
PLUG=1 WIZ=1 node test/app-splash.js                  # čistý PC bez klíčů: průvodce se otevře během instalace OmniRoute (Windows: 49 s, okno agenta 449 s)
OFFLINE_MS=25000 OMNI_ROOT=<…/node_modules/omniroute> node test/app-splash.js  # první start bez internetu: česká hláška v úvodním okně, opakování, OpenCode se stáhne po návratu sítě
OPENCODE_BIN=<opencode> WIZ_REAL=1 node test/app-wizard.js  # CELÁ appka (Linux i Windows): průvodce se otevře sám, falešný klíč → 403, skutečný NVIDIA → funguje, zkouška appky přes záložní proxy, Hotovo → wizardDone
node test/tiers.js && node test/i18n.js
```

Build selže s EBUSY na `default_app.asar`, když běží Bionic (LM Studio) – uživatel ho musí zavřít.
Sdílení pro učitele: `share/` (`Instalace.cmd`, `PRECTI.txt`), zip na plochu `czek-ai-sdileni.zip`.
