<!-- Plán presetu „Web design“: vygeneroval openai/gpt-oss-120b (groq), 2026-11-26, tools/presets-generate.js -->
## Goal of this mode
Design and deliver a single-page marketing website that feels handcrafted, follows the **impeccable** and **unslop-ui** visual language, and works flawlessly on every device.

## Plan
1. **Read the request and locate the project root** – use `read .` to list files, `glob "**/*"` to find a `package.json`, `index.html`, or a `src/` folder.
2. **Identify the existing stack** – if a `package.json` lists `react`, `vite`, `next`, or similar, adopt that; otherwise default to plain HTML + CSS + vanilla JS.
3. **Load design guidance** – `skill modern-web-design`, `skill ui-ux-pro-max`, `skill impeccable`, `skill unslop-ui`. Keep the notes in a temporary buffer for reference.
4. **Create a minimal project scaffold** (if none exists):
   - `mkdir -p src/assets/img src/styles`
   - `echo "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>…</title><link rel=\"stylesheet\" href=\"styles/main.css\"></head><body></body></html>" > src/index.html`
   - `touch src/styles/main.css`
5. **Define the visual hierarchy** – write a short style guide in `src/styles/_variables.css` (type scale, spacing scale, colour palette from **unslop-ui**). Import it at the top of `main.css`.
6. **Structure the markup** – use semantic sections (`<header>`, `<section id="hero">`, `<section id="features">`, `<footer>`). Apply BEM-like class names (`hero__title`, `features__item`).
7. **Apply typography and spacing** – set `font-family` to the recommended system stack, use `clamp()` for fluid type, and `var(--space-*)` for consistent gutters.
8. **Implement responsive layout** – use CSS Grid for the main layout, `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))` for feature cards, and media queries only for major breakpoints (320-480, 768-1024, 1440).
9. **Add tasteful motion** – load `gsap-scrolltrigger` via CDN, then follow the **gsap-scrolltrigger** skill to animate hero fade-in and staggered feature reveals. Keep animation duration ≤ 0.6 s and respect `prefers-reduced-motion`.
10. **Ensure accessibility** – run `npx axe-cli src/index.html` (no global install) and fix any violations: proper heading order, alt text for images, focusable interactive elements, sufficient colour contrast using the palette from **unslop-ui**.
11. **Optimize assets** – compress images with `bash -c "for f in src/assets/img/*.{png,jpg}; do npx imagemin-cli $f --out-dir=src/assets/img; done"`; lazy-load non-critical images via `loading="lazy"`.
12. **Test performance** – run `npx lighthouse src/index.html --quiet --chrome-flags="--headless"` and verify First Contentful Paint < 1.5 s, total blocking time < 150 ms. Adjust CSS (critical above-the-fold) if needed.
13. **Run final visual regression** – capture a screenshot with `npx puppeteer-screenshot src/index.html` and compare to a manually saved reference (if any).
14. **Commit locally** – `git add . && git commit -m "feat: polished marketing page"` (no push).
15. **Report** – summarize files created, key design decisions, and the pass/fail status of each verification step.

## Quality bar
- Fully semantic HTML with no empty `div`s.
- Consistent typographic scale and spacing using CSS custom properties.
- Responsive grid that never overflows or causes horizontal scroll.
- Motion respects `prefers-reduced-motion` and is limited to subtle fades or slides.
- WCAG 2.1 AA compliance (no contrast errors, all interactive elements keyboard-accessible).
- Lighthouse score ≥ 90 / 100, FCP ≤ 1.5 s, no unused CSS.
- No gradients, glassmorphism, or emoji icons; icons come from an approved SVG set.

## Verify before saying done
- Run `grep -R "<div>" src/index.html` to ensure no generic containers remain.
- Execute `npx axe-cli src/index.html` and confirm zero violations.
- Check `npx lighthouse` output for required performance thresholds.
- Open the page in Chrome devtools at three viewport widths (mobile, tablet, desktop) and verify layout integrity.
- Confirm that `gsap` animations only trigger when `prefers-reduced-motion` is off.

## Avoid
- Pulling in a heavy framework (React, Vue) when a static page suffices.
- Using global npm installs or adding unnecessary build tools.
- Relying on generic template classes like `.container` without customisation.
- Over-animating; keep motion purposeful and brief.
- Ignoring the loaded design skills – no gradients, glass, or emoji icons.
- Forgetting to commit locally before finishing.
