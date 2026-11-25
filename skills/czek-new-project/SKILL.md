---
name: czek-new-project
description: Use when starting a new project or app from scratch - website, web app, game, CLI, API, bot. Choose a simple proven stack, scaffold it with official tools, get a running skeleton first, then build features in small verified steps.
---

# New project

1. **Clarify the core**: what is the one thing it must do first (MVP)? Target platform (browser, desktop, phone, terminal)?
2. **Pick a boring, popular stack** the user can maintain: static site → plain HTML/CSS/JS or Vite; web app → Vite + React/Svelte or Next.js; API → Node (Express/Fastify) or Python (FastAPI); CLI → Node or Python; 2D game → Phaser/PixiJS. Prefer what is already installed.
3. **Scaffold with the official generator** (`npm create vite@latest`, `npx create-next-app`, …) instead of hand-writing configs. Use the latest stable versions, not guessed version numbers.
4. **Run the empty skeleton** and confirm it works before adding features.
5. **Add features one by one**, running the app after each. Keep a short README: what it is, how to install, how to run, how to test.
6. Add `.gitignore` (node_modules, dist, .env), `.env.example`, a `test` script, and initialize git with a first commit.
7. For any UI also load `czek-frontend` (and the design skills it lists).
