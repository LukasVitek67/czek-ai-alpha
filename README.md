# czek-ai · ALPHA

> [!WARNING]
> **Tohle je ALPHA verze. Není hotová, není stabilní a bude se dál měnit.**
> - Může padat, chovat se nečekaně nebo přestat fungovat po aktualizaci poskytovatelů modelů.
> - Rozhraní, nastavení i formát dat se mohou změnit bez upozornění a bez převodu starých dat.
> - Nepoužívej ji na nic důležitého bez zálohy. Agent upravuje soubory ve složce, kterou mu dáš.
> - Free modely mají limity, které se mění ze dne na den; občas prostě nic neodpoví.
> - Chyby a nápady hlas v [Issues](../../issues) – přesně kvůli tomu je repo veřejné.

**czek-ai** je desktopový kódovací agent (podobně jako Claude Code nebo Codex) nad **free modely** z mnoha
poskytovatelů. Vznikl pro naši třídu, když jsme přišli o placené AI nástroje. Cílem je, aby měl každý spolužák zdarma
agenta, který umí opravdu pracovat na kódu – a aby ho celá třída mohla společně vylepšovat.

## Jak to funguje

- **Agent** je [OpenCode](https://opencode.ai), **směrování mezi modely** dělá [OmniRoute](https://github.com/diegosouzapw/OmniRoute).
  czek-ai oboje sama nainstaluje, nastaví a spustí (Windows).
- **Tierlisty** (Max, High, …) skládají free modely podle síly. Pořadí se řídí **měřením na skutečných úlohách**
  (`src/evidence.js`, `src/model-evidence.json`), ne názvem modelu.
- **Závod modelů** (`src/race.js`): krok agenta jde nejdřív vedoucímu modelu; když mlčí nebo vypadne, hned nastoupí další.
- **Kontrola zdraví**: modely, které zrovna nefungují (vyčerpaný limit, výpadek), jdou z čela pořadí pryč dřív, než na
  ně agent narazí.
- **Průvodce klíči**: provede tě založením free účtů (NVIDIA, OpenRouter, Gemini, Z.ai, GitHub, Mistral, OpenCode Zen),
  každý klíč hned ověří a na konci vyzkouší, že appka opravdu odpovídá.
- **Pojistky proti smyčkám** v OpenCode jsou plugin `src/guard/`.

## Klíče – přečti si, než začneš

- **Každý si zakládá vlastní free klíče.** Služby bez klíče mají limit na IP adresu a ve škole ho sdílí celá třída,
  takže bez vlastních klíčů appka skoro nefunguje.
- **Klíče nikdy nesdílej a nikdy je nedávej do repozitáře, issue, screenshotu ani chatu.** Appka je ukládá šifrovaně
  u tebe v počítači.
- Když klíč omylem unikne: **hned ho u poskytovatele zruš a vytvoř nový.** Smazání z gitu nestačí.

## Stažení (Windows)

**[⬇ Stáhnout instalátor z Releases](https://github.com/LukasVitek67/czek-ai-alpha/releases/latest)** – `czek-ai-…-setup.exe`
(doporučeno, bez práv správce) nebo přenosné `…-portable.exe`. Je to ALPHA a exe není podepsané, takže SmartScreen:
*Další informace → Přesto spustit*.

## Stažení (Linux x64, od 0.15.42)

Z [Releases](https://github.com/LukasVitek67/czek-ai-alpha/releases) (nejnovější linuxové balíčky: [v0.15.44-alpha](https://github.com/LukasVitek67/czek-ai-alpha/releases/tag/v0.15.44-alpha)):

- **Ubuntu / Debian:** `czek-ai-…-linux-amd64.deb` → `sudo apt install ./czek-ai-…-linux-amd64.deb`, pak czek-ai v menu aplikací.
- **Jakékoli distro bez instalace:** `czek-ai-…-linux-x64.tar.gz` → rozbal a spusť `./czek-ai`.
- **AppImage:** `czek-ai-…-linux-x86_64.AppImage` → `chmod +x` a spusť. Od 0.15.44 nepotřebuje `libfuse2` (starší AppImage na
  Ubuntu 24.04+ bez něj nenaběhly).

První start si sám stáhne Node.js, OpenCode a OmniRoute do tvého profilu (bez sudo, ~2–3 min). Bash a git bere ze systému.

## Ze zdrojáků (Windows)

Potřebuješ [Node.js](https://nodejs.org) 22+ a [Git](https://git-scm.com).

```bash
git clone https://github.com/LukasVitek67/czek-ai-alpha.git
cd czek-ai-alpha
npm ci
npm start              # spustí appku ze zdrojáků
npm run dist           # sestaví přenosné czek-ai.exe do dist/
npm run dist:setup     # instalátor bez práv správce
```

Při prvním spuštění si appka stáhne OpenCode, Git Bash a OmniRoute (několik minut, OmniRoute má ~2,6 GB). Pro celou
třídu jde připravit jedno stažení: `czek-ai.exe --priprav-tridu` (viz `share/PRECTI.txt`).

## Jak se zapojit

Vylepšovat appku můžeš ty, já i učitel – klidně s pomocí AI asistenta. Jak na to, je v
**[CONTRIBUTING.md](CONTRIBUTING.md)**; pravidla pro AI asistenty (Claude Code apod.) v [CLAUDE.md](CLAUDE.md).

## Stav projektu

- Poctivé hodnocení po oblastech s čísly z měření: [docs/SCORECARD.md](docs/SCORECARD.md).
- Technický přehled všech funkcí: [docs/TECHNICKY-PREHLED.md](docs/TECHNICKY-PREHLED.md).
- Ověřeno hlavně na Windows (cílová platforma). Linux: sestavené balíčky ověřené na čistém Ubuntu 26.04 (první start, instalace, okno agenta), skutečné používání zatím málo. Mac neověřen.

### Známé problémy alpha verze

- První start na čistém PC trvá minuty (instalace OmniRoute); další starty jsou rychlé.
- Nabídka free modelů u poskytovatelů se mění; měření se proto pravidelně opakují.
- Některé texty a hlášky jsou zatím jen česky.
- Console často hlásí error, ale není to vždy pravda

## Licence

MIT (viz [LICENSE](LICENSE)). Skills ve složce `skills/` mají vlastní licence. OpenCode a OmniRoute se stahují z jejich
oficiálních zdrojů a mají svoje licence.
