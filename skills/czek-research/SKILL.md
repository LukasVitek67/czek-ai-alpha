---
name: czek-research
description: Use when working with a library, API, framework or tool you are not sure about, when versions matter, or when an error mentions an unfamiliar package. Get facts from the installed code, types and official docs instead of guessing function names or options.
---

# Research before you code

- **Check what is installed**: `package.json`/lockfile, `pip show`, `cargo tree` – use the version that is actually there.
- **Read the source of truth**: type definitions (`node_modules/<pkg>/*.d.ts`), the package README, the official docs site, `--help` output of CLIs.
- **Find examples in the project itself** first (`grep` for the import) – copy the working pattern.
- If web search/fetch tools exist, prefer official docs and changelogs over random blog posts; note the version they apply to.
- **Do not invent** methods, flags or config keys. If you cannot verify one, say so and try the smallest experiment that shows whether it exists.
- When an API changed between versions, follow the migration guide for the installed version.
