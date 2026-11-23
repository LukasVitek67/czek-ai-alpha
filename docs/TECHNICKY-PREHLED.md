# czek-ai

Desktopový kódovací agent (**Czech AI · čekaj**, jako Claude Code / Codex / Qwen Code) nad free modely z mnoha poskytovatelů v jedné appce (OpenCode + OmniRoute).

## Poskytovatelé

| | klíč | poznámka |
|---|---|---|
| OVHcloud AI Endpoints | ne | gpt-oss-120b, Qwen3.5 397B, Llama 3.3 70B; anonymně 2 req/min na model a IP (s klíčem placené) |
| LLM7.io | ne (volitelně free token) | modely tieru turbo: gpt-oss 20B, Codestral, Nemotron 3 Nano |
| Kilo Gateway | ne | free modely brány Kilo Code (Nemotron 3 Ultra 550B, Beam, openrouter/free), ~200 req/hod na IP |
| Pollinations | ne | funguje hned, pomalé |
| AI Horde | ne | komunitní GPU dobrovolníků, hlavně necenzurované modely; free klíč z registrace = přednost ve frontě |
| Ollama / LM Studio / OmniRoute | ne | lokálně (`localhost:11434`, `:1234`, `:20128`) |
| OpenCode Zen | ano | free modely (Big Pickle, GLM Flash, DeepSeek Flash…) |
| OpenRouter | ano | modely `:free` |
| Groq, Cerebras, Gemini, Mistral, GitHub Models, NVIDIA NIM, Hugging Face, SambaNova | ano | free tiery |
| Z.ai (GLM) | ano | zdarma GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash; 1 souběžný požadavek |
| Cloudflare Workers AI | ano (`Account ID:API token`) | 10 000 neuronů/den; Kimi, DeepSeek V4 a GLM 5 jen placené |
| Cohere | ano (trial) | 1000 volání/měsíc, nekomerčně |
| UnoRouter | ano (GitHub/Discord) | router třetí strany, 160+ modelů `:free` (DeepSeek V4 Flash, GLM 5.3 Flash…), ~1 req/min na model |
| Requesty | ano | Nemotron 3 Ultra 550B a Super 120B, Gemma 4 31B, Leanstral…; 200 req/den dohromady |
| OrcaRouter | ano (účet GitHub s historií) | DeepSeek V4.1/V4 Flash, GLM 5.3 Flash, Hy3 (10 req/min, 50/den), Hy4 Preview (50/min, 250/den) |
| RouteWay | ano | DeepSeek V4.1 Flash, MiniMax M3.1 Flash, Gemma 4 (`:free`); ~5 req/min, 200/den. Bez klíče API vrací stránku ochrany proti botům, s klíčem neověřeno |
| BazaarLink | ano | DeepSeek V4 Flash, Qwen 3.7 Flash, Nemotron 3.5 Lightning, `auto:free`; 10 req/min, 60 jednotek/den |
| Api.Airforce | ano | Kimi K2.7 Code, GLM-4.7-Flash, Mistral Large 4; jen 1 req/min, 1000/den (záloha), neoficiální brána |
| xKiro | ano | Mistral Large / Medium 3.5, Devstral Medium, Codestral, Command A; 5M tokenů/den |
| TokenHarbor | ano | DeepSeek V4.1 Flash, MiMo V2.6 Flash (`:free`); 60 req/min, týdenní limit; free trasy se musí zapnout a mohou ukládat dotazy |
| NaraRouter | ano (+ propojení s Telegramem) | 7M tokenů/den, 15 req/min: MiniMax M3, Mistral Large, Qwen 3.8 27B… |
| Agnes AI | ano | vlastní modely Agnes 2.0–3.0 Flash, trvale zdarma |
| Arcee AI | ano | Trinity Large Thinking (262k), seznam modelů až s klíčem |
| Vercel AI Gateway | ano (+ platební karta) | free modely za $0 + $5 měsíčně na vybrané placené |
| vlastní endpoint | volitelně | cokoliv OpenAI-kompatibilního |

Prověřeno 7. 11. 2026 a nepřidáno: **Ollama Cloud** (API jen za kredity, bez free kvóty), **ModelScope**, **SiliconFlow**, **iFlow** (čínská registrace a ověření identity, mimo Čínu prakticky nedostupné), **Together**, **Nebius**, **Hyperbolic** (jen jednorázové trial kredity). Živý test bezklíčových poskytovatelů: `node test/providers-live.js`.

Prověřeno 8. 11. 2026. Free modely se berou z veřejných `/models` poskytovatelů (nulová cena, `:free`, free tier), u NaraRouter, Agnes, TokenHarbor a Arcee až s klíčem. Seznam vznikl z katalogu free tierů OmniRoute (`open-sse/config/freeModelCatalog.data.ts`, auditováno proti stránkám poskytovatelů), z [free-ai-apis](https://github.com/OuterSpacee/free-ai-apis) a ze stránek, které poslal uživatel. S klíčem žádný z nich otestovaný není, endpointy bez klíče správně hlásí chybějící klíč (401). Nepřidáno:
- **Puter**: API chce token účtu Puter a útratu platí uživatel z vlastního zůstatku, není to free tier.
- **AINative**: free nárok (10M tokenů/měsíc) jen deklarovaný, model list nerozlišuje free modely.
- **api.navy** (150k tokenů/den pro všechny modely), **Aion** (20k tokenů/den), **Onomeo** (30 volání za 5 h): na agenta moc málo.
- **SEA-LION**: modely pro jihovýchodní Asii, ne na programování.
- **Scaleway**: jen jednorázový kredit. (Together, Fireworks, DeepInfra, Novita, Hyperbolic a AI/ML API mají taky jen kredit po registraci, přidala je zvlášť verze 0.10.10, viz níže.)
- **freeaiapikey.com**: přeprodává přístup přes sdílené klíče poskytovatelů neznámého původu a nabízí instalaci přes `curl … | bash`.
- **github.com/dan1471/FREE-openai-api-keys**: uniklé cizí klíče, jejich použití je zneužití cizích účtů.
- **OpenAI**: API nemá free tier.

Klíče se zadávají v Nastavení (šifrují se přes Windows), případně v proměnné `<ID>_API_KEY` (např. `OPENROUTER_API_KEY`).

## Režim Auto

Seřadí free modely, které umí nástroje (oblíbené ★ první, pak podle odhadu síly), střídá poskytovatele a při limitu / chybě / vyčerpané kvótě dá modelu pauzu a pokračuje ve stejném tahu dalším. Modely bez nativního volání funkcí dostanou textový protokol `<tool_call>…</tool_call>`.

## Režim Unfiltered

Tlačítko **Unfiltered** v horní liště. Auto i seznam modelů pak používají jen necenzurované modely:

- **AI Horde** (aihorde.net), bez klíče. Šablona promptu se volí podle modelu, Auto bere modely s nejkratší frontou a když se fronta minutu nehýbe, přepne na jiný.
- modely, které mají v názvu `uncensored`, `abliterated`, `heretic`, `dolphin`, `venice`… u kteréhokoliv poskytovatele (lokální Ollama / LM Studio, OpenRouter, Hugging Face…)
- modely, které v seznamu ručně označíš tlačítkem **necenz.** (třeba vlastní alias v Ollamě)

Ověřeno 6. 11. 2026: OpenRouter teď žádný free necenzurovaný model nemá (Dolphin Venice :free skončil), Venice API je jen placené, necenzurovaný model na Pollinations je placený. Kdyby se nějaký free vrátil, appka ho pozná podle názvu sama.

## Proxy pro OpenCode

Zdarma zároveň běží jako lokální OpenAI-kompatibilní server na `http://127.0.0.1:4545/v1` (port jde změnit v Nastavení). [OpenCode](https://opencode.ai) ho pak používá jako jednoho poskytovatele. OpenCode přidává agenta, který pracuje, dokud úkol nedokončí, a skills (`SKILL.md`). Zdarma přidává střídání free modelů.

- `zdarma/auto`: stejné pořadí a střídání jako režim Auto. Při 429 / kvótě / chybě dostane model pauzu a požadavek jde na další, ještě než klient dostane první znak odpovědi.
- `zdarma/auto-unfiltered`: jen necenzurované modely (AI Horde apod.).
- `zdarma/<poskytovatel>/<model>`: konkrétní model, při chybě (se zapnutým fallbackem) pokračuje Auto.
- Modely bez nativních nástrojů dostanou nástroje klienta textovým protokolem a proxy z odpovědi složí normální `tool_calls`.
- Požadavky z prohlížeče (hlavička `Origin`) a bez `Content-Type: application/json` se odmítají, ať cizí web nemůže spotřebovat tvoje limity.

Nastavení → **Nastavit OpenCode** zapíše poskytovatele `zdarma` do `~/.config/opencode/opencode.json` (stávající obsah zachová, zálohu uloží jako `.bak`). Do OpenCode se zapíše i každý model, který Zdarma vidí (`zdarma/groq/…`, `zdarma/openrouter/…`), takže jde vybrat i konkrétní. API klíče se nekopírují: zůstávají šifrované ve Zdarmě a doplní je proxy.

**Zdarma se otevírá rovnou v OpenCode** (od 0.5.0). Spustí na pozadí `opencode serve` bez konzole a jeho grafické rozhraní (projekty, relace, úpravy souborů, výběr modelu) ukáže ve svém okně. Začíná v poslední pracovní složce. Je to nezměněné OpenCode, takže jeho aktualizace fungují dál. Potřebuje nainstalovaný OpenCode (`npm i -g opencode-ai`). Když chybí, otevře se původní chat Zdarmy.

**Otevírání složek** (od 0.6.0): **Přidat projekt** v OpenCode otevře okno Zdarmy s rychlým přístupem. Nahoře jsou **připnuté** složky, pod nimi **nedávno otevřené** (vlastní historie + projekty OpenCode), s hledáním a ovládáním z klávesnice. **Procházet…** otevře klasický dialog Windows. Složku jde připnout, odepnout nebo odebrat ze seznamu nedávných a přidat do rychlého přístupu i bez otevření. Webové OpenCode má napevno vlastní výběr procházející server, proto Zdarma při načtení jeho hlavního skriptu přesměruje tuto jednu podmínku na `window.__ZDARMA__.pickFolder` ([src/ocPatch.js](src/ocPatch.js)). Soubory OpenCode na disku se nemění. Když se vzor v nové verzi OpenCode nenajde, zůstane původní výběr. Test: `node test/ocpatch.js`.

**Tierlisty** (od 0.7.0) nahrazují v OpenCode nabídku modelů. K dispozici jsou **Max, High, Mid, Low**, **Unfiltered** (necenzurované) a vlastní tierlisty ([src/tiers.js](src/tiers.js)).
- Tierlist je seřazený seznam modelů. Při limitu nebo chybě proxy vezme další model v pořadí. Když dojde celý tierlist, pokračuje záložním (výchozí řetěz Max → High → Mid → Low, Low → Mid). Vlastní tierlisty mají záložní tierlist nastavitelný.
- Vestavěné tierlisty se plní automaticky podle síly modelu (rodina a velikost, např. `235b`, `gpt-oss-120b`, `flash-lite`), dokud je uživatel neupraví.
- Editor je v Nastavení → **Tierlisty modelů**. Modely jde přidat hledáním, přesouvat šipkami nebo tažením a odebrat. Vestavěný tierlist jde vrátit na automatický, vlastní smazat.
- **Kontextový limit** tierlistu (podle něj OpenCode zkracuje konverzaci) je ve výchozím stavu automatický. Je to medián kontextu prvních modelů, které se opravdu použijí, včetně záložního tierlistu, v mezích 16k–1M. Kontext bere od poskytovatele, a kde ho poskytovatel neposílá (Gemini, NVIDIA, Cerebras, Pollinations), použije známou hodnotu rodiny modelu (Gemini 1M, gpt-oss/Llama 3/Qwen3 128k…). V editoru jde u každého tierlistu nastavit vlastní hodnotu, prázdné pole znamená automaticky. Proxy model, kterému by konverzace nevešla, přeskočí.
- **Výchozí model v OpenCode je Max** (od 0.9.2; dřívější výchozí High se jednorázově přepne). Nejsilnější modely jdou první, po vyčerpání pokračuje High → Mid → Low.
- Volba „jen tierlisty“ zapíše do OpenCode `enabled_providers: ["zdarma"]`, takže v nabídce nejsou jednotlivé modely ani vestavěné modely OpenCode.

**Vzhled OpenCode v okně Zdarmy** (od 0.7.0):
- *Chaty svisle vlevo:* OpenCode 14. 9. 2026 vypnulo klasické rozvržení datem v kódu a vynucuje taby. Úprava skriptu toto datum posune a [src/ocPreload.js](src/ocPreload.js) nastaví `newLayoutDesigns: false`. Přepíná se v menu Zobrazení.
- *Rozdělení kontextu:* segmenty pruhu mají mezery a odlišné barvy (uživatel zelená, asistent modrá, nástroje oranžová, jiné šedá). Je to jen vložené CSS ([src/ocPatch.js](src/ocPatch.js)).
- *Limity v panelu Kontext:* pod rozdělením kontextu je sekce „Limity (Zdarma)“. Pro každé API a model ukazuje dnešní požadavky a tokeny a co poskytovatel hlásí v hlavičkách `x-ratelimit-*` (zbývá / limit / obnova, s pruhem). Ukazuje i pauzy po limitu a poslední chybu, naposledy použité jsou nahoře. Data sbírá proxy ([src/usage.js](src/usage.js)) a ukládá je po dnech do `usage.json`.

Testy bez zásahu do dat uživatele: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` na dočasné složky (OpenCode tam má konfiguraci, projekty a relace), `ZDARMA_OC_PORT` (jiný port serveru OpenCode), dočasný `ZDARMA_USER_DATA` s vlastním `proxyPort`. `OPENCODE_CONFIG_DIR` nestačí, OpenCode ho jen přidává ke globální konfiguraci.

**Od 0.8.0:**
- *Který model právě pracuje:* vedle výběru modelu v OpenCode je štítek se skutečným modelem za tierlistem (zelená pulzující tečka a sekundy, když zrovna odpovídá, jinak „naposledy …“). Totéž je v titulku okna. Data dává proxy (`server.activity`).
- *Tokeny v projektu:* v panelu Kontext je součet tokenů aktuálního projektu od začátku, přes všechny modely, s rozpisem podle modelů a součtem za všechny projekty. Proxy pozná projekt z promptu OpenCode („Working directory: …“) a ukládá to do `usage-projects.json`. Požadavek na název relace pracovní složku nemá, proto se do projektu nepočítá.
- *Preferované rodiny modelů:* Nastavení → Tierlisty → „Preferované rodiny modelů“. Výchozí hodnota je `kimi, deepseek-v4, glm`. Modely s těmito názvy jdou v Auto i v automatických tierlistech nahoru, v uvedeném pořadí.
- *Skills:* 34 skills (impeccable, ui-ux-pro-max, unslop-ui, 23 design skills z claudedesignskills, 7× caveman, memory-bank) jsou přibalené ve složce [skills/](skills/) i s licencemi. Při každém spuštění je Zdarma doinstaluje do složky skills v konfiguraci OpenCode ([src/skills.js](src/skills.js)).
  - Kopie spravované Zdarmou mají značku `.zdarma-skill.json`, cizích složek se Zdarma nedotkne.
  - Skill, který už je v `~/.claude/skills`, se neinstaluje podruhé (OpenCode tu složku čte taky).
  - memory-bank (původně nastavení pro Claude Code, ne skill) je zabalený jako skill. Původní příkazy a workflow má v `reference/`.
- *Skills a návody* (menu Zdarma, Ctrl+Shift+K, nebo tlačítko v postranním panelu): přehled podle dopadu. U každého skillu je návod (k čemu, kdy, příklady zadání ke zkopírování, požadavky, zdroj a licence), hledání a stav instalace. Data jsou v [skills/catalog.json](skills/catalog.json). Test: `node test/skills.js`.

**Když žádný model neodpoví** (od 0.9.1): proxy nejdřív sama počká, jestli se do 20 s neuvolní některý model z pořadí (vyprší pauza po limitu). Teprve potom vrátí chybu **400**, kterou OpenCode neopakuje. Dřív vracela 429 a OpenCode pak opakoval donekonečna: chat zůstal ve stavu „pracuje“, visel v něm nehybný seznam úkolů a nic se nedělo.

**OmniRoute jako směrovací jádro** (od 0.10.0): tierlisty a `zdarma/auto` neroutuje vlastní kód Zdarmy, ale [OmniRoute](https://github.com/diegosouzapw/OmniRoute) (MIT), pokud je nainstalovaný (`npm i -g omniroute`, potřebuje Node 22.22+ nebo 24+). Zdarma ho neforkuje ani nepřepisuje, používá ho přímo ([src/omniroute.js](src/omniroute.js)):
- spustí `omniroute serve --headless` na volném portu, jen na `127.0.0.1`, s vlastní datovou složkou `<userData>/omniroute` (ne `~/.omniroute`). Při ukončení zabije celý strom procesů.
- přes jeho management API (lokální token počítá kód OmniRoute, `bin/cli/utils/cliToken.mjs`, drží se jen v paměti) zapíše každého poskytovatele Zdarmy jako OpenAI-kompatibilní uzel `z-<id>` se stejnou adresou a klíčem, jaký používá Zdarma. Bezklíčoví poskytovatelé (Kilo, Pollinations, OVH, LLM7) dostanou prázdný klíč, takže jdou bez hlavičky `Authorization`. Vestavěné definice OmniRoute pro ně klíč vyžadují.
- z každého tierlistu udělá combo `zdarma-<tier>` ve stejném pořadí se strategií **lkgp**: drží se modelu, který naposledy fungoval, a na další přejde až při chybě. Model tak během úkolu zbytečně neskáče. Střídání, pauzy po limitu a jističe obstará OmniRoute.
- vypne cizí proxy (`proxyEnabled: false`). Synchronizace proběhne po každé změně klíčů nebo tierlistů a je idempotentní: uzly a combo Zdarmy se aktualizují, nic jiného v OmniRoute se nemění.
- proxy Zdarmy zůstává vpředu: OpenCode mluví dál se Zdarmou, ta požadavek přepošle na combo a stream vrací beze změny. Aktivní model, tokeny za projekt i limity se počítají dál. Skutečný model pozná z hlaviček `x-omniroute-provider/-model`, a protože streamy s nástroji tyto hlavičky nemají, i z pole `model` v odpovědi.
- Když OmniRoute chybí, nenaběhne nebo neodpovídá, směruje Zdarma sama jako dřív. Vypíná se v Nastavení → Proxy → „Tierlisty směruje OmniRoute“.

Testy: `node test/omniroute-live.js` (živě: start v dočasné složce, synchronizace dvakrát, požadavek s nástrojem přes proxy, vypnutí). Benchmark kvality: `node test/bench-agent.js max ovh,llm7,kilo,pollinations 15` staví skutečným OpenCode malou aplikaci a výsledek ověří. `BENCH_TASK=web` je webová aplikace kontrolovaná ve skrytém okně (prázdná stránka, chyby v konzoli, klikání, localStorage, [tools/verify-web.js](tools/verify-web.js)). `BENCH_OMNI=1` směruje přes OmniRoute. Výsledek 7. 11. 2026 (tierlist Max, jen bezklíčoví poskytovatelé): webová aplikace prošla všemi 7 kontrolami přes OmniRoute (1,0 min) i přes vlastní směrování (0,6 min), obě s modelem `kilo/nvidia/nemotron-3-ultra-550b-a55b:free`, bez rozbitých nástrojů a bez useknutých odpovědí. Konzolová todo aplikace (výchozí úkol) prošla taky. `BENCH_TASK=electron`: desktopová aplikace Poznámky (main + preload s `contextBridge` + renderer + IPC + `notes.json` v userData), kterou [tools/verify-electron.js](tools/verify-electron.js) spustí se skrytými okny a projde 12 kontrol (okno se otevře a není prázdné, preload, bezpečnost, ukládání, prázdný titulek, soubor, znovunačtení, mazání, chyby v konzoli / main / pád rendereru). Ověřovač na správné referenční aplikaci dá 12/12. Výsledek 7. 11. 2026: 4 běhy (2× OmniRoute, 2× vlastní směrování), všechny 12/12 za 0,7–1,2 min. Agent aplikaci sám nespouští, má `ELECTRON_RUN_AS_NODE=1`, takže ani omylem neotevře okno.

**Opravy podle skutečného využití** (0.10.1–0.10.2, z `usage.json`: jen názvy modelů a počty, žádné chaty):
- *Kimi K3.1 Pro na NVIDIA:* model je na build.nvidia.com od 4. 11. 2026 (`moonshotai/kimi-k3.1-pro`, kontext 1M), ale ve veřejném seznamu `/v1/models` chybí, takže ho Zdarma dřív nevěděla. Teď ho přidává sama (`extraModels`) a v Max je první.
- *Slabé modely v High:* nejvíc skutečné práce nesly Llama 3.3 70B (OVH, 39 požadavků, 9 prázdných odpovědí) a Codestral (23 požadavků, 10× limit). OVH model píše `Meta-Llama-3_3-70B`, proto propadl do High podle velikosti. Starší generace (Llama 3.x, Llama 4 Scout/Maverick, Qwen2.5, Mixtral, Codestral, Hermes) patří teď do Mid. High jsou GLM Flash, Nemotron Super, Gemini Flash, Devstral, Qwen3 32B, MiniMax M3.
- *Gemini 3 selhávalo vždy* („Function call is missing a thought_signature“): Gemini chce u volání nástrojů zpět podpis, který OpenCode zahodí. Vlastní směrování si podpisy pamatuje podle id volání a vrací je, u historie bez podpisu použije zástupnou hodnotu dokumentovanou Googlem. V OmniRoute jde Gemini přes jeho nativního poskytovatele, který podpisy vrací sám. Test: `node test/gemini-sig.js`.

**Tokeny a „hloupnutí“** (0.10.4, změřeno z metadat `call_logs` OmniRoute: čas, model, trvání, tokeny, bez obsahu):
- Agent posílal **163–177 tisíc tokenů v každém kroku** a dostával zpět ~100 (konverzace o 253 zprávách). Za 10 minut to dělalo 3,6 milionu tokenů. Free modely s takhle dlouhým kontextem znatelně hloupnou. Příčina: tierlist hlásil OpenCode kontext 262k, takže OpenCode konverzaci zkracoval až kolem 250k. Navíc měl vypnuté zahazování starých výstupů nástrojů.
  - Automatický kontext tierlistu má teď strop **96k**. Ruční hodnota v editoru strop nemá.
  - Do konfigurace OpenCode se zapíše `compaction: { auto: true, prune: true }`, pokud ji uživatel nemá nastavenou sám.
- Modely se nestřídaly po pár sekundách. Každý krok agenta je jeden krátký požadavek (2–10 s), mezi kroky OpenCode spouští nástroj. Strategie `lkgp` se ale přilepila k prvnímu modelu, který prošel (Kilo Nemotron), a k lepším modelům výš v tierlistu se už nevrátila. Combo teď používají **`priority`**: každý požadavek jde v pořadí tierlistu a vezme se první, který odpoví. Vyčerpané modely OmniRoute přeskočí lokálně.
- Klíče se do OmniRoute zapisují jen při změně. Dřív každá synchronizace spustila test všech připojení.

**Zamrzlý seznam úkolů znovu** (0.10.5): OmniRoute má výchozí časy pro pomalé cloudy. Na první odpověď každého modelu čeká 80–180 s, uprostřed odpovědi toleruje 600 s ticha. Free poskytovatel, který požadavek přijal a mlčel (NVIDIA GLM 5.3 Flash), tak držel relaci minuty ve stavu „pracuje“.
- Zdarma spouští OmniRoute s kratšími časy: 30 s na první odpověď (u velkých požadavků až 45 s, od 0.10.6), 90 s ticha, 5 min celkem, bez adaptivního okna až 10 min. Nemotron 3 Ultra odpověděl i na 177k tokenů do 10 s. Free model, který potřebuje přes 45 s jen na začátek odpovědi, je pro agenta k ničemu.
- Combo mají `maxRetries: 0`, takže při chybě jde požadavek rovnou na další model a nečeká 2 s na opakování stejného.
- Pojistka ve Zdarmě: když žádný model nezačne odpovídat do 2 min, nebo uprostřed odpovědi nastane 2 min ticha, požadavek skončí chybou 400 / chybou ve streamu. OpenCode ji neopakuje, takže tah skončí a nezamrzne. Test: `node test/omni-timeout.js`.

**Pomalé modely na konec** (0.10.6). Měřeno na účtu uživatele 8. 11. 2026:
- NVIDIA GLM 5.3 Flash a MiniMax M3.1 Flash potřebovaly 45–180 s na krok a polovina kroků skončila časovým limitem.
- DeepSeek V4.1 Flash na NVIDIA neodpověděl do 150 s.
- Nemotron 3 Ultra odpověděl za 1–2 s (NVIDIA i Kilo).
- Kimi K3.1 Pro vrací přes API NVIDIA 404, jde zatím jen v playgroundu na webu.

Combo jdou v pořadí tierlistu (`priority`), takže každý krok čekal, až pomalému modelu vyprší limit. Teď [src/omniroute.js](src/omniroute.js) `rebalance()` měří rychlost:
- Data bere z metadat OmniRoute (`GET /api/usage/call-logs`), jen model, poskytovatel, trvání, stav a čas. Obsah požadavků se nečte.
- Pomalý je model, jehož úspěšné pokusy za posledních 30 min trvají v mediánu přes 40 s. Nebo model, kterému aspoň 2 pokusy skončily časovým limitem / 5xx / přerušením a je to aspoň polovina jeho pokusů.
- Pomalé modely jdou na konec combo, ostatní zůstávají v pořadí tierlistu. Do OmniRoute se zapisuje jen při změně pořadí a synchronizace odsunutí nevrací.
- Když model z okna 30 min vypadne, vrátí se na své místo a zkusí se znovu.
- Spouští se každé 2 min a hned (za 5 s) po požadavku přes OmniRoute delším než 40 s.
- Odsunuté modely jsou v Nastavení → Proxy v řádku OmniRoute („Pomalé, odsunuté na konec: …“).
- Testy: `node test/omni-rebalance.js` (falešné API). `node test/omniroute-live.js` čte skutečné `call_logs` a spustí `rebalance()`.

**Plný automatický režim** (od 0.10.7, ve výchozím stavu vypnutý): Nastavení → „Plný automatický režim“. Zapíná se jen přes červené varování a tlačítko „Rozumím, zapnout“. Agent OpenCode se pak na nic neptá: spouští libovolné příkazy, mění a maže soubory i mimo složku projektu, čte `.env` a chodí na internet. **Používej ho jen ve složce projektu se zálohou nebo v gitu.** Free modely dělají chyby a změny nemusí jít vrátit.
- Zdarma zapíše do konfigurace OpenCode `permission` s `allow` pro `external_directory`, `read` (včetně `*.env`), `bash`, `doom_loop`, `webfetch`, `websearch`, `task`, `skill`, `lsp`, `todowrite`, `glob`, `grep`, `list` ([src/opencode.js](src/opencode.js) `FULL_AUTO`). Bez ní se OpenCode ptá na soubory mimo projekt, čtení `.env` a opakované stejné volání.
- Úmyslně se nenastavuje `edit` ani `"*"`. Pravidla z konfigurace se v OpenCode slučují až po pravidlech agenta, takže by přebila zákaz úprav v režimu Plan.
- Původní `permission` uživatele se při zapnutí odloží do `opencode.zdarma-permission.json` vedle konfigurace. Po vypnutí se vrátí, a když žádné nebylo, klíč zmizí.
- Dokud je režim zapnutý, okno OpenCode má v titulku „⚠ PLNÝ AUTOMAT“ a vedle výběru modelu červený štítek PLNÝ AUTOMAT. Po přepnutí se server OpenCode restartuje, až nic nepracuje.
- Test: `node test/fullauto.js`. Ověří zápis, zálohu a vrácení. Pak spustí skutečné `opencode serve` v dočasných složkách a kontroluje výsledná pravidla agentů: build má `allow`, Plan dál `edit: deny`.

**Průvodce API klíči** (0.10.11):
- Nastavení (v okně OpenCode menu Zdarma → Klíče a poskytovatelé, Ctrl+,) začíná sekcí **Poskytovatelé a API klíče** se všemi 40 poskytovateli včetně Z.ai (GLM). U každého je pole na klíč, tlačítka Otestovat a Získat klíč ↗ a krátký postup. Počítadlo ukazuje, u kolika poskytovatelů je klíč vyplněný, a ti s klíčem jsou nahoře.
- OpenCode zase ukazuje svůj dialog **Připojit poskytovatele** (236 webů, mj. Z.AI / Z.AI Coding Plan). Zdarma kvůli tomu už nepíše `enabled_providers: ["zdarma"]`. V nabídce modelů jsou dál jen tierlisty Zdarmy, plus to, co si uživatel připojí přímo v OpenCode. Takové modely ale jdou mimo tierlisty a střídání Zdarmy.
- Vypíná se v Nastavení → Tierlisty → „V OpenCode nechat jeho Připojit poskytovatele“ (setting `ocProviders`). Vlastní `enabled_providers` uživatele se nemaže. Test: `node test/oc-providers.js`.

**Celý seznam [OuterSpacee/free-ai-apis](https://github.com/OuterSpacee/free-ai-apis)** (0.10.10): přibyli Together AI, Fireworks, DeepInfra, Novita, Hyperbolic a AI/ML API. Mají jednorázový kredit po registraci (0,50–5 $), pak jsou placené. Novita a AI/ML mají i Kimi K3.1 Pro. Přibyl i DeepSeek (vlastní účet), ten je **placený** a free tier nemá. Ostatní služby ze seznamu Zdarma už měla. Puter není přidaný, protože funguje jen přes svou knihovnu v prohlížeči s účtem Puter a nemá API klíč. LiteLLM je vlastní server, přidá se jako vlastní poskytovatel.

**Proč model „běží jen pár sekund“ a jestli za to může** (0.10.9, změřeno nahrávací proxy [test/capture-opencode.js](test/capture-opencode.js): co OpenCode posílá a co se vrací, na vlastním testovacím úkolu):
- OpenCode posílá `max_tokens 8192`, 10 nástrojů, **žádnou teplotu ani nastavení uvažování**, takže platí výchozí hodnoty poskytovatele. Každý krok agenta je jeden požadavek: přečíst soubor, jedna úprava, spustit test. Kroky trvají 1,5–11 s a jen občas model přemýšlí déle (3 000+ znaků uvažování). To je normální práce agenta, ne porucha.
- Úkol `bugfix` ([test/fixtures/bugfix](test/fixtures/bugfix)): 6 nasazených chyb v 5 souborech (mj. `s.state.filteredTracks` místo `s.filteredTracks`, jako v projektu uživatele), 8 testů, testy se nesmí měnit. Nemotron 3 Ultra (Kilo) prošel **8/8** ve všech třech nastaveních: výchozí, `reasoning_effort: high` (11 kroků místo 15, o 30 % méně tokenů) i `temperature 1.0, top_p 0.95` (doporučení NVIDIA).
- Další free modely na Kilo: `stealth/glyph-cluster` **8/8 za 6 kroků a 63k tokenů** (nejlepší), `reflection/beam-free` 8/8 za 13 kroků, `cohere/north-mini-code` 2/8 (vzdal to), `stealth/crouton-alpha` 403 (chce účet). Glyph-cluster a beam-free dřív padaly do Mid, teď jsou v Max a ověřené modely mají v pořadí přednost (`PROVEN` v providers.js).
- **Kilo má free limit zhruba 200 požadavků za hodinu na IP adresu.** Agent udělá jeden požadavek za krok, takže v delší práci limit dojde (429) a OmniRoute pak sjede na pomalé nebo slabé modely níž v tierlistu. Opakované běhy benchmarku tenhle limit samy vyčerpaly.
- Co dělalo práci uživatele špatnou, podle měření: chat byl na High (NVIDIA GLM/MiniMax Flash, 45–180 s na krok, půlka timeoutů), 165k tokenů v každém kroku, dřív střídání slabých modelů, rozbité kusy tool calls (0.10.0–0.10.2) a `lkgp` přilepené k jednomu modelu. Všechno je opravené v 0.10.3–0.10.9.

Menu **Zdarma** v okně:
- **Klíče a poskytovatelé…** (Ctrl+,): okno nastavení Zdarmy. Po jeho zavření se do OpenCode zapíšou nové modely. OpenCode čte konfiguraci jen při startu, proto se jeho server restartuje, ale až ve chvíli, kdy neběží žádná relace ani požadavek na model, aby se nepřerušila rozdělaná práce.
- **Načíst nové modely**: totéž ručně.
- **Původní chat Zdarma**: vlastní agent Zdarmy (také `Zdarma.exe --classic`).

Zdarma běží jen jednou: druhé spuštění jen přepne do otevřeného okna.

Bez okna: `Zdarma.exe --proxy [--port=4545]`. Když už proxy běží v otevřené Zdarmě, druhá instance se jen ukončí. `tools/OpenCode (Zdarma).cmd` spustí proxy a OpenCode v terminálu (TUI).

Test: `node test/proxy.js` (falešný upstream: střídání po 429, textový protokol nástrojů, SSE, zabezpečení).

## Nastavení, jazyk a profesionální vzhled (0.11)

Pro celou třídu a vyučujícího, zatím bez distribuce (instalace zůstává stejná).
- **Nastavení** má vlevo seznam stránek místo jedné dlouhé stránky: Poskytovatelé a klíče, Tierlisty modelů, OpenCode a proxy, Obecné, Pokročilé, O aplikaci. Menu Zdarma v OpenCode má i položku O aplikaci.
- **Poskytovatelé**: hledání, filtr (s klíčem / fungují bez klíče / chybí klíč) a „Otestovat všechny použitelné“, který vyzkouší postupně každého s klíčem nebo bez klíče a výsledek napíše k řádku.
- **Pokročilé**: teplota, port proxy, OmniRoute, režim Unfiltered a plný automatický režim. Přepínač Unfiltered se v chatu ukáže až po zapnutí v Pokročilých. Skrytý přepínač zároveň znamená vypnutý režim. Kdo měl Unfiltered zapnutý dřív, má přepínač vidět dál.
- **O aplikaci**: verze Zdarmy, OpenCode, OmniRoute, Node.js a Electronu, složka s daty (tlačítko ji otevře) a licence použitých projektů.
- **Čeština a angličtina** (Obecné → Jazyk, výchozí čeština). Všechny texty jsou v jednom slovníku [src/i18n.js](src/i18n.js), který používají okna i hlavní proces.
  - V HTML mají statické texty `data-i18n` / `data-i18n-html` / `data-i18n-ph` / `data-i18n-title`, v kódu se volá `t('klíč', {proměnné})`.
  - Panel v OpenCode běží v sandboxu a soubor si načíst nemůže. Přeložené texty `oc.*` mu proto posílá hlavní proces přes `oc:prefs`.
  - Popisy poskytovatelů jsou anglicky v `providers.js` (`EN`). Návody ke skills jsou v [skills/catalog.en.json](skills/catalog.en.json) a přes české je přelije hlavní proces.
  - Překládají se i názvy tierlistů v nabídce modelů OpenCode („Max · 5 models · strongest free models“) a samotné rozhraní OpenCode. Zdarma nastaví jeho jazyk (`opencode.global.dat:language`), ale jen když si uživatel v OpenCode nevybral jiný sám. Jazyk prohlížeče oken (data, „před 3 minutami“) se nastaví při startu přepínačem `--lang`.
  - Po přepnutí jazyka se okno Zdarmy načte znovu, menu a panel v OpenCode taky a konfigurace OpenCode se přepíše, až OpenCode nic nedělá.
  - Test: `node test/i18n.js` ověřuje, že každý klíč má obě řeči se stejnými proměnnými, že každý klíč použitý v kódu existuje a že anglicky je každý poskytovatel i skill.

## Diagnostika (0.12)

**Nastavení → Diagnostika** ukáže všechno, co Zdarma ví, a obnovuje se každé 3 s, dokud je otevřená:
- **Co je špatně**: upozornění odvozená z dat. Model selhává nebo je pomalý, proxy opravila argumenty, konverzace má miliony tokenů, běží ve složce s víc projekty, agent opakuje stejná volání, proxy nebo OmniRoute neběží.
- **Stav**: proxy, server OpenCode, OmniRoute (verze, port, synchronizace, pomalé modely), co právě pracuje, pauzy po limitu, verze.
- **Modely (24 h)**: požadavky, úspěšné, medián trvání, tokeny, volání nástrojů, opravené argumenty, chyby.
- **Poslední požadavky**: každý požadavek proxy (čas, tierlist, model, trvání, tokeny, nástroje, výsledek). Záznam je v `<userData>/diagnostics/requests.jsonl` (při 8 MB se odsune do `.1`).
- **Pokusy v OmniRoute**: každý pokus o model uvnitř combo, včetně těch, které selhaly (stav, trvání, TTFT, chyba).
- **Konverzace OpenCode a jejich rozbor**: čte přímo `opencode.db` (jen čtení, `node:sqlite`). U konverzace ukáže počty kroků, tokeny a medián kroku, modely, nástroje a jejich chyby, opakovaná stejná volání (smyčky) a časovou osu kroků (co agent dělal, s chybami nástrojů).
- **Poskytovatelé, logy** (`zdarma.log`, chyby a varování OmniRoute) a **velikost dat**.
- **Uložit diagnostiku na plochu**: všechno výše do jednoho JSON souboru, bez API klíčů.

Modul je [src/diagnostics.js](src/diagnostics.js), test `node test/diagnostics.js`.

**Opravy z rozboru skutečného chatu** (projekt lossless-player, 372 zpráv, 11,3 M tokenů, 10 kompakcí):
- *Typy argumentů nástrojů*: free modely posílaly čísla jako text (`"offset":"0"`, `"limit":"1000"`, `"timeout":"10000"`) a OpenCode volání odmítal (SchemaError). Proxy teď podle schématu nástroje z požadavku převede text na číslo nebo boolean a JSON v textu na pole nebo objekt, na obou cestách (OmniRoute i vlastní směrování). Kolik oprav udělala, je vidět v diagnostice. Test `node test/coerce.js`.
- *Trvale nedostupné modely*: NVIDIA Kimi K3.1 Pro a K2.6 vracely tomuhle účtu vždy 404, HF 402. Měření v OmniRoute je teď počítá jako selhání a odsune je na konec, místo aby se zkoušely na začátku každého požadavku.
- *Smyčky při ladění aplikace*: agent 13× spustil exe, 11× zabil proces a 13× pustil `cargo check`, aniž zjistil, proč je okno černé. Přibalený skill **app-debugging** dává pevný postup: spustit odpojeně s ladicím portem, přečíst chybu z konzole okna skriptem `scripts/cdp-console.cjs` (vypíše chyby a jestli je stránka prázdná), opravit příčinu. Má i kontrolní seznam pro Tauri, Electron, Svelte 5 a Vite. Skript na ukázkové aplikaci našel `ReferenceError: $state is not defined`, stejnou chybu jako v lossless-player.
- *Složka s víc projekty*: chat běžel v `Documents\Claude code` (8 projektů), ne v `lossless-player`. Výběr složky teď u takové složky upozorní a nabídne rovnou jednotlivé projekty.

**Živá diagnostika (0.12.1–0.12.3)**: `<userData>/diagnostics/live.jsonl` zapisuje průběžně každý požadavek proxy, výsledek modelu, události OpenCode (kroky, nástroje, kompakce) a řetěz pokusů v OmniRoute (přes `x-correlation-id`). `full.jsonl` obsahuje celé zprávy a odpovědi. Proxy je vrací i na `GET /zdarma/live?n=`, `/zdarma/full?n=`, `/zdarma/requests?n=` a `/zdarma/diag`. Co se díky tomu našlo a opravilo:
- *12–13 s mrtvého času na každý krok agenta*: domovská složka je git repozitář, takže OpenCode bral za projekt celý domov a před i po každém kroku z něj dělal snímek (`git add` + `write-tree` přes AppData, Stažené, Videa…, asi 4 s na snímek). Model přitom pracoval jen 7–14 s. Když je domov (nebo složka nad ním) v gitu, Zdarma zapíše do konfigurace OpenCode `snapshot: false`. Vrátí to, až repozitář zmizí, a vlastní nastavení uživatele nemění. Bez snímků nejde v OpenCode vracet změny souborů tlačítkem Zpět. Test `node test/oc-snapshot.js`.
- *PowerShell místo bashe*: bez proměnné `SHELL` (Zdarma spuštěná z plochy) dal OpenCode nástroji „bash“ PowerShell a modely v něm zápasily s uvozovkami („PowerShell is mangling the quotes“). Zdarma teď OpenCode spouští s `SHELL` = Git Bash, pokud je nainstalovaný.
- *Pokusy navíc ve vlastním směrování*: modely s pauzou po limitu spotřebovávaly pokusy, takže na fungující model nedošlo. Test `node test/proxy-skip.js`.
- *Plný disk (0.12.4)*: přenosné exe se při každém spuštění rozbalí do `%TEMP%\ns????.tmp` (asi 0,7 GB). Po násilném ukončení tam kopie zůstane. 8. 11. jich tam leželo 9 (5,1 GB) a disk C: měl 0 MB volných. Zdarma teď 30 s po startu smaže staré kopie, ve kterých je `app\Zdarma.exe` i `app.asar`. Vynechá svoji vlastní, kopie mladší než 10 min a kopie, ze kterých běží jiná Zdarma. Spuštěné exe nejde otevřít pro zápis, podle toho to pozná. Přejmenování složky jako zkouška nestačí, protože Windows dovolí přejmenovat i složku se spuštěným exe. Test `node test/cleanup.js`.
- *Kvalita agenta (0.12.5)*, rozbor živého chatu na Mid (441 zpráv, chat ve složce s 8 projekty):
  - Kompakci (shrnutí historie, ze kterého agent pak pokračuje) psal model chatu, na Mid Codestral za 4,8 s. Zdarma teď nastaví `agent.compaction.model = zdarma/max`, pokud si uživatel nevybral jinak. Shrnutí tak píše nejsilnější tierlist.
  - Pokyny pro agenta (`zdarma-agent.md` vedle konfigurace OpenCode, cesta v `instructions`) vznikly z chyb v záznamu. Dlouho běžící příkazy (`tauri dev`, dev servery) spouštět na pozadí s logem, protože nástroj je po 2 min utne a proces zůstane viset. Před úpravou soubor přečíst. Pracovat ve složce projektu. Při opakované chybě hledat příčinu, nemazat soubory.
  - Popisy přibalených skills se v nainstalované kopii zkrátí na ~220 znaků. Celý seznam skills byl 75 % systémového promptu (27,7k znaků). Prompt teď má 31,6k znaků místo 36,7k, i s novými pokyny.
  - Modely, které v posledních 30 min vracejí hlavně 429 (aspoň 4 pokusy, aspoň 75 %), jdou v combo za fungující. Codestral (45/53 × 429) a Gemma (35/35) se zkoušely první v každém kroku. Když Codestral výjimečně prošel, model se uprostřed úkolu měnil.
  - Testy: `node test/oc-agent-config.js` (skutečný OpenCode s falešným modelem: pokyny v promptu, kompakce na max, krátké popisy) a `node test/omni-limited.js`.
- *Zabitý OmniRoute (0.12.6)*: agent spustil `taskkill //F //IM node.exe` a zabil všechny procesy node, mezi nimi i OmniRoute. Zdarma ho teď za 3 s spustí znovu, nejvýš 5× za 10 min. Pokyny pro agenta zabíjení procesů podle jména zakazují. Test `node test/omni-restart.js` (skutečný OmniRoute v dočasné složce).
- *150 s čekání na jeden model (0.12.7)*: vlastní směrování čekalo na první data od modelu až 150 s, živě NVIDIA DeepSeek V4.1 Flash. Teď nejvýš 45 s (`ZDARMA_FIRST_BYTE_MS`), udržovací komentáře `: PROCESSING` limit neprodlužují. Model, který nezačne odpovídat, dostane pauzu 15 min (dřív 2 min) a další krok agenta na něj nečeká. Test `node test/first-byte.js`.
- *Ladění černého okna naslepo (0.12.11)*: agent načetl skill app-debugging a 10 minut zkoušel otevřít ladicí port WebView2 přes `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`. Tauri (wry) ale WebView2 nastavuje vlastní parametry a navíc byl obsazený port 1420, takže se okno s portem nikdy nespustilo. Agent 7× zabil a znovu spustil aplikaci a k chybě se nedostal. Skript skillu teď umí `--dist ./dist` (vlastní server + neviditelný Chrome/Edge) a `--url http://localhost:1420`, takže aplikaci není potřeba restartovat. Na lossless-playeru našel za 5 s `ReferenceError: addFolder is not defined` (`Sidebar.svelte:88`). Postup ve skillu i pokyny pro agenta na to odkazují. Pokyny navíc vysvětlují spouštění na pozadí jen se závorkami a logem a zakazují PowerShell syntaxi `$env:` v bashi. Test `node test/cdp-console.js`.
- *První požadavek po startu (0.12.13)*: kontrola mrtvých, pomalých a vyčerpaných modelů běžela až 2 min po startu. První krok agenta proto prošel HF 402, 2× NVIDIA 404 a 110 s čekal na NVIDIA DeepSeek (504). Teď běží hned po synchronizaci z historie OmniRoute, která restart přežije, a okno rychlosti je 2 h místo 30 min. Zdarma navíc zapisuje do `zdarma.log`, kdy a proč skončila, a když první start OmniRoute selže na jednorázové chybě, zkusí ho znovu (nejvýš 3×).
- *Měření místo dohadů (0.12.15)*: `node test/capture-opencode.js blankapp` je úloha podle skutečného případu z 8. 11. Jde o Svelte 5 + Vite aplikaci, která se nesestaví a pak ukazuje prázdné okno: špatná cesta importu, `$state` v obyčejném `.js`, nedeklarovaný handler a `undefined.toUpperCase`. Výsledek ověří neviditelný prohlížeč. Na NVIDIA Nemotron 3 Ultra přes OmniRoute: bez pokynů a skillu (stav před 8. 11.) neopraveno, pořád `$state is not defined`; s pokyny a skillem opraveno za 4,4 min / 46 požadavků; navíc s `reasoning_effort: high` opraveno za 3,2 min / 34 požadavků. Proxy proto krokům agenta na Max/High/Mid/auto doplňuje `reasoning_effort: high` (OmniRoute ho přijme i u modelů bez přemýšlení; ve vlastním směrování jen u poskytovatelů ze seznamu) a vlastní směrování už `reasoning_effort` od klienta nezahazuje. Systémový prompt OpenCode (záložní „odpovídej do 4 řádků“) jsem měřil na úloze bugfix: s plným promptem 8/8 i bez něj 8/8, s plným o 40 % víc tokenů, proto zůstává. Test `node test/proxy-effort.js`.
- *Max neodpověděl vůbec (0.12.16)*: OmniRoute čekal na začátek odpovědi až 300 s (`FETCH_TIMEOUT_MS`). NVIDIA DeepSeek V4.1 Flash tak držel každý požadavek 110 s, než vrátil 504, a celý tierlist narazil na 120 s limit Zdarmy dřív, než se zkusil další model. Teď se na začátek odpovědi čeká 45 s, tělo odpovědi má dál 300 s. Model, který dvakrát po sobě do 30+ s nezačne odpovídat (504/408/0), je 6 h brán jako mrtvý a jde na konec, úspěšná odpověď ho vrátí. Test `node test/omni-dead.js`.
- *Další pokyny z živého sledování (0.12.17–0.12.19)*: agent hádal adresy dokumentace Tauri (4× 404 za 10 s), takže pokyny teď ukazují na dokumentaci v projektu (`node_modules/<balíček>`, `@tauri-apps/cli/config.schema.json`, registr cargo). `npx tauri build` mu nástroj utnul po 2 min, proto pokyny říkají, že dlouhým buildům má nastavit parametr `timeout` (až 600000), nebo je pustit na pozadí a kontrolovat přes `sleep 60; tail` (jeho `sleep 120` taky narazil na limit).
- *Mrtvé modely na začátku tierlistů*: v OmniRoute se odpovědi 401/402/403 počítají jako mrtvý poskytovatel a 404 jako mrtvý model, na 6 h. Takové modely jdou na konec combo, až za pomalé. Úspěšná odpověď je vrátí zpátky. Test `node test/omni-dead.js`.
- *Přímé napojení OpenCode + OmniRoute (0.13.0)*: Zdarma spouští OmniRoute s jeho vlastní nástěnkou (`--no-open --no-tray`, dokončené bezheslové `omniroute setup --non-interactive` a `OMNIROUTE_CLI_SKIP_REPO_ENV=1`), vytvoří lokální API klíč a do OpenCode nainstaluje oficiální `@omniroute/opencode-plugin` s výchozím směrováním `opencode-omniroute/auto/coding` (`small_model`: `opencode-omniroute/auto/fast`). Klíče ze Zdarmy se zapisují přímo do nativních poskytovatelů OmniRoute (s `importFreeModelsOnly: true`) a bezklíčové free modely do jeho katalogu, takže celá cesta požadavku jde přímo mezi OpenCode a OmniRoute bez mezivrstvy proxy Zdarmy. Nástěnka OmniRoute jde otevřít přímo z menu Zdarma (`Ctrl+Shift+O`) nebo z Nastavení → Poskytovatelé a klíče.
- *Sjednocené modely napříč poskytovateli (0.13.1)*: stejný model z různých poskytovatelů (např. `Kimi K3 / K3.1 Pro`, `DeepSeek V4.1 Flash`, `Nemotron 3 Ultra 550B`, `GLM 5.3 Flash`, `GPT-OSS 120B`) se sjednotí do jedné položky (`opencode-omniroute/<slug>`). V OmniRoute má každý sjednocený model vlastní combo se strategií `lkgp` (Last Known Good Provider): po výběru běží výhradně na jednom poskytovateli bez přepínání, dokud nedojdou kredity nebo limit, a teprve pak přepne na dalšího poskytovatele téhož modelu (a připne se na něj). Přehled sjednocených modelů s aktivními i odemykatelnými poskytovateli je v Nastavení → **Sjednocené modely** (`Ctrl+Shift+M`).
- *Rebranding na czek-ai (0.14.0)*: přejmenování z *Zdarma* na **czek-ai** (slovní hříčka *Czech AI* a *čekaj*). Sestavuje se jako `Desktop\czek-ai.exe` a při prvním spuštění automaticky přenese uložené nastavení, šifrované API klíče a relace z dřívější složky `%APPDATA%\Zdarma`.

## Nástroje agenta

`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `run_command` (PowerShell), `fetch_url`. Povolení: ptát se / úpravy bez ptaní / vše bez ptaní. Načítá instrukce projektu z `AGENTS.md`, `CLAUDE.md`, `QWEN.md`, `GEMINI.md`.

## Vývoj

Build na plochu: `npm run dist:desktop`. Na ploše je vždy jen jeden soubor `czek-ai.exe` s nejnovější verzí, starší kopie (včetně dřívějšího `Zdarma.exe`) se smažou ([tools/to-desktop.js](tools/to-desktop.js)). Když stará instance zrovna běží, nejde přepsat (spouštěč drží soubor zamčený). Nejnovější se pak dá vedle jako `czek-ai-<verze>.exe` a po zavření staré ji `npm run desktop` přejmenuje na `czek-ai.exe`.

```bash
npm install
npm start          # spustit
npm test           # unit testy + živý test (Pollinations); `node test/run.js unit` jen unit
npm run dist       # dist/czek-ai-<verze>-portable.exe
```

UI test bez okna na obrazovce: `ZDARMA_HIDDEN=1 ZDARMA_USER_DATA=<dočasná složka> electron . --remote-debugging-port=9333` a `node tools/cdp.js 9333 eval|shot …`.
