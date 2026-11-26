<!-- Plán presetu „Hra a 3D“: vygeneroval openai/gpt-oss-120b (groq), 2026-11-26, tools/presets-generate.js -->
## Goal of this mode
Create a minimal, playable browser game or 2D/3D demo that runs at 60 fps, using the most appropriate library (Three.js, PixiJS, Babylon.js, or React-Three-Fiber) and follows the project’s existing stack.

## Plan
1. **Read the request and locate the project root** – use `glob "**/package.json"` to find the nearest `package.json`. If none exists, decide on a zero-build setup (plain HTML + CDN).
2. **Detect the current stack** – grep for `"three"`, `"pixi"`, `"babylon"` or `"react"` in `package.json` and source files. Choose the matching skill (`threejs-webgl`, `pixijs-2d`, `babylonjs-engine`, `react-three-fiber`). If multiple are present, pick the one with the most recent version.
3. **Create a minimal scaffold**
   - If a build system exists (e.g., Vite, Webpack), add a new entry point `src/game.js` (or `Game.jsx` for React) and update the HTML template.
   - If no build, generate `index.html` that loads the library from a CDN (`https://cdn.jsdelivr.net/npm/three@<version>/build/three.min.js`, etc.) and a `game.js` script tag.
4. **Load the chosen skill** – invoke `skill threejs-webgl` (or the appropriate skill) to retrieve expert patterns: scene setup, camera, renderer, animation loop, basic input handling, and a simple physics stub.
5. **Implement the core loop**
   - Create a `Scene`, `PerspectiveCamera` (or `OrthographicCamera` for 2D), and `WebGLRenderer`.
   - Set `renderer.setPixelRatio(window.devicePixelRatio)` and `renderer.setSize(window.innerWidth, window.innerHeight)`.
   - Write `function animate(){ requestAnimationFrame(animate); update(); render(); }`.
   - Hook `window.addEventListener('resize', ...)` to keep the canvas full-screen.
6. **Add minimal gameplay** – spawn a player object (cube, sprite, or mesh), add keyboard listeners (`keydown`, `keyup`) for movement, and a static obstacle. Use the skill’s “lightweight-3d-effects” for a simple particle burst on collision.
7. **Integrate simple collision detection** – axis-aligned bounding box (AABB) for 3D or bounding-circle for 2D. Place the logic in an `update()` function that also applies a tiny gravity vector.
8. **Apply performance guidelines** – run `skill czek-performance` to insert:
   - `renderer.info.reset()` each frame and log FPS to console.
   - Object pooling for particles.
   - `requestAnimationFrame` timing checks to keep < 16 ms per frame.
9. **Test locally** – open `index.html` in the default browser (`start index.html` on Windows) and verify that the player can move, collides, and the frame counter stays near 60.
10. **Commit the minimal changes** – `git add . && git commit -m "Add playable demo using <library>"` (only if a repo exists and the user has not prohibited commits).

## Quality bar
- A single HTML page (or integrated entry point) that loads and runs without a build step unless the project already uses one.
- Game loop runs at ≥ 55 fps on a typical laptop (checked via console FPS log).
- Player can move with arrow keys/WASD, collides with at least one obstacle, and a visual effect triggers on collision.
- Code follows the library’s idiomatic pattern (scene → camera → renderer → animate).
- No unused imports, lint errors, or console warnings.
- All new files are placed in the existing `src/` hierarchy or alongside `index.html` if no source folder exists.

## Verify before saying done
- Run `grep -R "new THREE\|new PIXI\|new BABYLON" src/` to ensure only the chosen library is used.
- Execute `node -e "console.log('test')"` to confirm Node is functional (for any build scripts).
- Open the page in Chrome, open DevTools, and check that `renderer.info.render.frame` increments and `performance.now()` delta stays ≤ 16 ms for 100 consecutive frames.
- Verify keyboard events are captured (`console.log` on keydown) and that the collision flag toggles at least once.
- Run `git status` to ensure only intended files are staged.

## Avoid
- Pulling in a full framework (React, Vue, etc.) when the request only needs a canvas demo.
- Adding a bundler (Webpack, Vite) if the project has no existing build pipeline.
- Hard-coding asset URLs; use relative paths or CDN links that work offline.
- Ignoring devicePixelRatio, leading to blurry rendering on high-DPI screens.
- Forgetting to clean up event listeners or particle objects, causing memory leaks and FPS drops.
- Over-engineering physics; stick to simple AABB or circle checks for the first playable version.
