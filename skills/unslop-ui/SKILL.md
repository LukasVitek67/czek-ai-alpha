---
name: unslop-ui
description: Guardrail against generic AI-looking UI. Use whenever you create or restyle any user interface (web, desktop, app screens, landing pages, dashboards, settings) so it reads as deliberately designed software, not template output. Pairs with impeccable and ui-ux-pro-max.
---

# unslop-ui

Generated UI has recognizable tells. Remove them; keep the product's own voice.

## Never produce
- Dark background with neon glow, glassmorphism blur, or purple→blue / pink→orange gradients as decoration.
- Everything-in-a-card grids with large radius + heavy drop shadow.
- Icon tiles: a colored rounded square with an icon in front of every heading or list item.
- Eyebrow labels: tiny uppercase tag above every heading ("FEATURES", "WHY US").
- Emoji as icons or in headings.
- Hero + three feature cards + testimonial strip + CTA, when the product is not a marketing page.
- Filler copy: "Welcome to…", "Unlock the power of…", "Seamless", "Effortless", "Elevate".
- Gradient text, floating blobs, random sparkle/particle effects.
- Centered layouts with huge padding that waste the screen on a desktop tool.

## Do instead
- Start from the content and the task: what does the user look at most? Make that dense and scannable.
- One restrained palette: neutrals + a single accent, defined as CSS variables/tokens, used consistently. Both light and dark themes must look intentional.
- One type scale (3–5 sizes), real hierarchy through weight and spacing, tabular figures for numbers.
- Borders and whitespace for structure before shadows; shadows only for things that float (menus, dialogs).
- Use the existing icon set of the project, sparingly, only where an icon carries meaning.
- Keep the author's own wording, naming and visual direction. Refine it; do not replace it with template copy.
- Reference real, well-regarded software in the same category and match its restraint.

## Before finishing
Look at the result and list any tell from "Never produce" that is still present. Fix each one, then finish.
