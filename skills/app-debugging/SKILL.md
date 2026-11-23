---
name: app-debugging
description: Use when a desktop or web app you built "won't start", "shows a blank/black/white window", "crashes on launch", or "does nothing" — Tauri, Electron, WebView2, Vite/Svelte/React frontends. Fixed procedure: build, open the frontend in a headless browser with scripts/cdp-console.cjs to read the real error, fix it. No relaunch loops.
---

# app-debugging

A blank or black window almost always means the **frontend threw a JavaScript error or never loaded**. "The process is running" and "the build succeeded" tell you nothing. Get the actual error first, then fix that one thing.

## Rules (stop the loops)
- Do not relaunch the app to debug a blank window. The frontend error shows up in a headless browser too (step 2) – no window, no debug port, no killing processes.
- For Tauri do not try `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` or other env-var tricks to open a debug port: Tauri sets its own WebView2 arguments, so it does not work reliably.
- Never run a GUI app or dev server in the foreground: the tool call hangs until timeout. Start it in the background (step 4).
- Do not run `npm run build` / `cargo check` again without editing something first.
- Do not install global tools (`cargo install tauri-cli`) to debug; use what the project already has.

## Procedure

1. **Build the frontend**: `npm run build 2>&1 | tail -30` and confirm the output folder (usually `dist`) has `index.html`.
2. **Read the error from the built frontend** (takes ~5 s, starts its own server and a headless Chrome/Edge):
   ```bash
   node "<skill folder>/scripts/cdp-console.cjs" --dist ./dist
   ```
   If the dev server is already running, use it instead: `node "<skill folder>/scripts/cdp-console.cjs" --url http://localhost:1420` (Vite/Tauri default port; check `vite.config` / `tauri.conf.json` → `build.devUrl`).
   It prints the page title, how much visible text and how many elements the page has, failed requests, and every console error / uncaught exception with its stack. `PAGE IS EMPTY` + an `EXCEPTION` = that exception is why the window is blank.
   Errors about Tauri APIs (`invoke`, `__TAURI_INTERNALS__`) are expected in a plain browser; any other startup error is the real bug.
3. **Fix the reported error** in the source (e.g. `ReferenceError: addFolder is not defined` → the component uses a name it never declared or imported). Rebuild, run step 2 again. Repeat until it shows `NO CONSOLE ERRORS` (or only the expected Tauri ones) and `visibleText` > 0.
4. **Only then start the real app once**, in the background with a log, and tell the user it is running:
   - Tauri: `(npm run tauri dev > tauri-dev.log 2>&1 &)` then, in a separate command, `sleep 20; tail -20 tauri-dev.log`.
   - Electron: `(npx electron . --remote-debugging-port=9222 > electron.log 2>&1 &)`; a running Electron app can also be checked with `node "<skill folder>/scripts/cdp-console.cjs" 9222`.
   - If the port is busy ("Port 1420 is already in use"), find the PID with `netstat -ano | grep :1420` and kill only that PID.
5. **Config checklist** when nothing loads at all (step 2 shows no page / 404s under FAILED REQUESTS):
   - Tauri v2: `tauri.conf.json` → `build.frontendDist` points to the real build output (e.g. `../dist`), `build.devUrl` matches the dev server, `build.beforeBuildCommand` builds the frontend.
   - Tauri v1: `build.distDir`, `build.devPath`.
   - Electron: `loadFile` / `loadURL` path exists relative to `__dirname` / `app.getAppPath()`; `preload` path exists; with `contextIsolation: true` the renderer must not use `require`.
   - CSP blocking scripts: "Refused to load/execute" in the output.
   - Svelte 5: runes (`$state`, `$derived`) only work in `.svelte` and `.svelte.js/.svelte.ts` files compiled by `@sveltejs/vite-plugin-svelte` ≥ 4; "`$state is not defined`" means a runes file is imported as plain JS/TS or the plugin/svelte versions are mismatched.
   - Vite `base`: for apps loaded from disk use `base: './'`, otherwise assets 404 and the page is empty.
6. **Native crash** (process exits immediately, no window): run the exe once with a short tool timeout to see stderr: `timeout 20 ./src-tauri/target/debug/<app>.exe 2>&1 | head -50`.

## Report
Say what the console error was, what you changed, and the script output after the fix (no errors, page has content). If you could not get the error, say exactly which step failed and what it printed.
