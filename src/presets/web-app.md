<!-- Plán presetu „Webová aplikace“: vygeneroval openai/gpt-oss-120b (groq), 2026-11-26, tools/presets-generate.js -->
## Goal of this mode
Build a functional, well-structured interactive web application (React, Vue, Svelte or plain JS) that meets the user’s request, follows the existing project’s conventions, and includes solid state handling, validation, data fetching, auth flows, UI states, and automated tests.

## Plan
1. **Read the request and locate files** – Use `read` to fetch the user’s description and any named files. Run `glob`/`grep` to discover the current project root, `package.json`, and framework entry points.
2. **Identify the stack** – Parse `package.json` for dependencies (`react`, `vue`, `svelte`, `vite`, etc.). If none exist, default to the minimal stack the user mentions; otherwise, adopt the existing stack.
3. **Load relevant skills** – Invoke `skill czek-frontend` for component conventions, `skill czek-new-project` for scaffolding, `skill ui-ux-pro-max` for UI patterns, `skill czek-testing` for test setup, `skill czek-security` for auth & data safety, and `skill czek-review` for final code review.
4. **Create or update project structure** –
   - For React: `src/components/`, `src/pages/`, `src/hooks/`, `src/store/`.
   - For Vue: `src/components/`, `src/views/`, `src/composables/`, `src/store/`.
   - For Svelte: `src/lib/`, `src/routes/`, `src/stores/`.
   - For plain JS: `public/`, `src/`, `assets/`.
   Use `czek-new-project` guidelines for naming (kebab-case) and file placement.
5. **Implement core UI** – Follow `czek-frontend` patterns: functional components, prop typing, CSS modules or Tailwind (if present). Add responsive layout per `ui-ux-pro-max`.
6. **Add state management** – Use Context API/Redux for React, Pinia for Vue, Svelte stores for Svelte, or a simple custom store for plain JS. Keep state immutable and typed where possible.
7. **Build forms with validation** – Leverage `react-hook-form` + Yup, `vee-validate` for Vue, or `svelte-forms-lib`. Ensure client-side validation mirrors any server rules described.
8. **Integrate data fetching** – Use `fetch` wrapped in a reusable service module; apply `async/await`, error handling, and abort controllers. Cache results in the store when appropriate.
9. **Implement authentication flow** – Follow `czek-security` for token storage (httpOnly cookies or secure localStorage), route guards, and refresh logic.
10. **Add UI states** – Insert loading spinners, error banners, and empty placeholders in every async component.
11. **Write tests** – With `czek-testing`, create unit tests for pure functions, component snapshot tests, and integration tests for form submission and auth flow using Jest + React Testing Library / Vue Test Utils / Svelte Testing Library.
12. **Run lint, type-check, and tests** – Execute `npm run lint`, `npm run typecheck` (if TypeScript), and `npm test`. Fix any failures.
13. **Perform self-review** – Call `skill czek-review` to verify coding standards, accessibility (ARIA), and security best practices.
14. **Commit changes locally** – Stage modified files with `git add .`, create a concise commit (`git commit -m "feat: implement X with validation and tests"`). Do not push unless asked.

## Quality bar
- Project builds with `npm run dev` (or `vite`) without errors.
- All components are isolated, reusable, and follow the chosen framework’s style guide.
- Forms reject invalid input and display user-friendly messages.
- Data fetching shows loading, error, and empty states correctly.
- Auth flow protects private routes and refreshes tokens automatically.
- Test coverage ≥ 80 % for new logic; all tests pass.
- Linting and type-checking report zero issues.
- Accessibility checks (ARIA roles, contrast) pass basic audit.

## Verify before saying done
- Run `npm run build` and confirm no compilation warnings.
- Execute `npm test` and ensure 0 failing tests and coverage thresholds met.
- Open the app in a headless browser (`npx playwright test`) to verify UI states.
- Use `grep -R "TODO"` to ensure no placeholder comments remain.
- Run `git diff --cached` to confirm only intended files are staged.

## Avoid
- Introducing a framework or bundler not referenced in the request or existing `package.json`.
- Adding global npm installs or modifying system-wide configs.
- Hard-coding API URLs or secrets; always read from `.env` or config files.
- Over-engineering: avoid state libraries if the feature is simple.
- Leaving console logs, commented-out code, or unused imports.
- Skipping accessibility attributes or security headers in auth flows.
