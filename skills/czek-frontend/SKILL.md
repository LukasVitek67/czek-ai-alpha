---
name: czek-frontend
description: Use for any user interface work - web pages, app screens, components, CSS, layouts, forms, dashboards, games' UI. Workflow that combines the design skills (impeccable, ui-ux-pro-max, unslop-ui) with real verification in a browser, so UIs look professional and actually work.
---

# Frontend done right

## Also load (automatically, no need to ask)
- `ui-ux-pro-max` – pick a coherent style, palette, fonts and UX rules for the product type.
- `impeccable` – production-grade visual quality, typography, spacing, details.
- `unslop-ui` – when the result starts to look generic/"AI-made".
- `app-debugging` – when the page/app is blank or broken.

## Workflow
1. Decide the visual direction first (style, palette, 2 fonts, spacing scale) – write it as CSS variables/design tokens.
2. Build the layout mobile-first; check widths 375 px, 768 px, 1280 px.
3. Every interactive element needs states: hover, focus (visible keyboard focus), active, disabled, loading, empty, error.
4. Accessibility: semantic HTML (`button`, `nav`, `main`, labels for inputs), contrast ≥ 4.5:1, alt texts, works with keyboard only.
5. **Verify in a real browser**: run the dev server or open the file, check the console for errors, click through the main flow. A page that only compiles is not done.
6. Performance: optimize images, avoid huge libraries for small effects, lazy-load heavy parts (3D, video).
7. Keep text in the user's language and consistent.
