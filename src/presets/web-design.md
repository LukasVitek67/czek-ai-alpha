<!-- Plán presetu „Web design“: 26. 11. 2026 přepsal Claude Opus 5.5 podle zpětné vazby uživatele (první verze od openai/gpt-oss-120b měla neexistující příkazy a žádné ověření pohledem). tools/presets-generate.js ho bez --force nepřepíše. -->
## Goal of this mode
Build a website (landing page, portfolio, company site) that looks designed by a person with taste: a clear visual identity, deliberate typography and spacing, real content, and a result you have actually looked at on a phone and a desktop.

## Plan
1. Understand the brief: who the site is for, what the visitor should do, what content exists (text, logo, photos in the project). If details are missing, decide sensibly, state your assumptions in one line and continue - do not interrogate the user. Write texts in the user's language.
2. Inspect the project with glob/read. Keep an existing stack and structure. For a new site use plain `index.html` + `styles.css` + a small `main.js`; no framework or build step unless the request needs it.
3. Set the design direction before writing code, following impeccable (brand register) and unslop-ui: one sentence describing the scene (who, where, what light, what mood), then derive theme (light or dark), a colour strategy (restrained: tinted neutrals + one accent; or committed: one strong colour carries 30-60% of the surface), a type pairing on a contrast axis (serif + sans, or one family in several weights) and a layout idea. Put this as a 4-6 line comment at the top of the CSS.
4. Write the content structure as semantic HTML (header, main with purposeful sections, footer) with real, specific copy - no lorem ipsum, no filler like "Welcome to our website". Every section has one job.
5. Define tokens in `:root`: colours in OKLCH (neutrals tinted toward the brand hue), a spacing scale, a fluid type scale with `clamp()` (display max <= 6rem, letter-spacing >= -0.04em), body line length 65-75ch, one border radius scale used everywhere.
6. Lay out with varied rhythm: an asymmetric or typographic hero, Grid for 2D, Flexbox for 1D, `text-wrap: balance` on headings. Images get `width`/`height` and `loading="lazy"` below the fold; without supplied photos use typography, shapes or inline SVG instead of hotlinked stock.
7. Add motion as part of the design: one signature moment (hero entrance or a scroll-linked sequence via gsap-scrolltrigger) and small staggered reveals (scroll-reveal-libraries or IntersectionObserver). When the brief calls for a real GPU effect (shader hero background, holographic card, liquid glass, particles), build that one signature effect with vgpu: read its docs and the matching example through the vgpu CLI as the vgpu skill says, keep it to one canvas, cap the device pixel ratio, pause it when off screen, and show a static image or CSS fallback when `navigator.gpu` is missing or reduced motion is on. Content must be visible without JavaScript; ease-out curves, no bounce; a `prefers-reduced-motion: reduce` alternative for every animation.
8. Make interaction states real: `:hover`, `:focus-visible` (visible outline), `:active`, a responsive navigation that works by keyboard.
9. Look at the result with a headless browser (Git Bash, verified on Windows): find one with `for b in "/c/Program Files/Google/Chrome/Application/chrome.exe" "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Microsoft/Edge/Application/msedge.exe" "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"; do [ -f "$b" ] && B="$b" && break; done`, then desktop: `"$B" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(cygpath -w "$TEMP")\czek-shot" --window-size=1440,900 --virtual-time-budget=5000 --screenshot="$(cygpath -w "$PWD")\shot-desktop.png" "file:///$(cygpath -m "$PWD")/index.html"`. Phone: headless Chrome never goes below 500 px wide (a 390 window silently renders 500 px and crops), so wrap the page in an iframe of exactly 390 px: write `_phone.html` containing `<body style="margin:0"><iframe src="index.html" width="390" height="844" style="border:0"></iframe>` and screenshot it the same way with `--allow-file-access-from-files --window-size=500,844` into `shot-phone.png` (the page is the left 390 px). Open both PNGs with the read tool and fix what looks off; delete `_phone.html` afterwards.
10. Run hallmark's sloplint on the page (`node "<hallmark skill directory>/scripts/sloplint.mjs" index.html --render`; the directory is shown when you load the hallmark skill; its render tier needs puppeteer-core – if it reports that, the static checks still ran and your screenshots cover the rest, do not install anything): fix every FAIL, fix or waive every REFLEX with a real reason. Where hallmark and impeccable disagree on a detail, keep the stricter rule.
11. Run the checks below, fix, and screenshot again until nothing in them fails. Then delete the screenshots and report.

## Quality bar
- Someone could not tell at a glance that AI made it: distinct palette and type, no template look.
- Body text contrast >= 4.5:1, large text >= 3:1 (compute it from the OKLCH/hex values, do not guess).
- No horizontal scroll and no overflowing headings at 375 px; layout holds from 375 to 1440 px.
- One consistent radius, spacing from the scale, at most two font families.
- Motion respects reduced motion; the page is fully usable with JavaScript off.
- Every link and button has a visible focus state and a meaningful label; images have alt text.

## Verify before saying done
- Screenshots at 390x844 and 1440x900 were taken and inspected with the read tool after the last change.
- Contrast pairs for body text, muted text and buttons were calculated.
- The HTML opens without console errors: check referenced files exist (glob) and paths are relative.
- sloplint (hallmark) reports no FAIL; `grep` the CSS for the banned patterns below.
- Keyboard pass in your head over the markup: tab order follows the visual order, nothing focusable is hidden.

## Avoid
- Gradients as decoration, gradient text, glassmorphism, neon glow.
- Emoji as icons, icons inside rounded squares, identical card grids, the big-number "hero metric" block.
- Tiny uppercase eyebrow labels or 01/02/03 numbers above every section.
- Coloured side-stripe borders on cards or callouts.
- Cream/beige near-white page backgrounds by default; grey text on coloured backgrounds.
- Placeholder copy, broken image paths, external images you cannot verify.
- Committing, pushing or deploying unless the user asks.
