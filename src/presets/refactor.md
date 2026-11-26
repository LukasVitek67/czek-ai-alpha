<!-- Plán presetu „Úklid a zrychlení“: vygeneroval openai/gpt-oss-120b (groq), 2026-11-26, tools/presets-generate.js -->
## Goal of this mode
Improve the existing codebase by refactoring and optimizing performance while keeping the public API unchanged and ensuring full test coverage.

## Plan
1. **Read the request and locate the target code** – use `read` to open the files the user mentioned or that `glob` finds (e.g., `src/**/*.js`).
2. **Run the existing test suite** – execute `npm test` (or the project's test command) and capture the baseline pass/fail count and timing.
3. **Identify missing coverage** – invoke the **czek-testing** skill to list techniques (e.g., `nyc`, `jest --coverage`). Run the coverage tool, parse the report, and note uncovered functions or branches that will be touched by the upcoming changes.
4. **Add minimal tests** – for each uncovered area, create a test file using the project's test framework. Keep tests focused on behavior, not implementation details. Run the suite again to confirm the new tests pass.
5. **Load the refactor guide** – call the **czek-refactor** skill. Follow its checklist: extract pure functions, replace duplicated logic with helpers, apply consistent naming, and enforce lint rules.
6. **Apply the first small refactor** – edit one file at a time, commit the change locally (no push), and run the test suite to ensure no regression.
7. **Measure performance baseline** – use the **czek-performance** skill to select an appropriate benchmark (e.g., `benchmark.js`, `node --prof`, or `hyperfine` for CLI). Record the metric (ms, ops/sec).
8. **Optimize the hot path** – profile with `node --inspect` or `grep` for CPU-intensive loops, replace inefficient constructs (e.g., `for...in` on arrays, unnecessary `await` in tight loops) with proven patterns (memoization, streaming, native methods).
9. **Re-run benchmarks** – compare the new metric against the baseline; aim for ≥10 % improvement or a concrete target the user gave.
10. **Run the full test suite again** – ensure 100 % pass and that coverage has not dropped.
11. **Run the code review skill** – invoke **czek-review** to check for style violations, dead code, and API stability. Apply any suggested fixes.
12. **Document the changes** – update inline comments and, if the project has a CHANGELOG, add a short entry describing the refactor and performance gain.
13. **Summarize** – prepare a concise reply that lists: tests added, refactors performed, before/after performance numbers, and confirmation that the public interface is unchanged.

## Quality bar
- All original tests pass and new tests cover every modified line (≥90 % branch coverage).
- No change to exported functions, classes, or CLI signatures; `npm pack` (or equivalent) produces identical type definitions.
- Performance benchmark shows the promised improvement (e.g., runtime reduced by ≥10 % or ops/sec increased accordingly).
- Code follows the project's linting/formatting rules; `npm run lint` reports zero errors.
- No new warnings appear in the console when running the app in typical mode.

## Verify before saying done
- `npm test` runs cleanly with zero failures.
- Coverage report (`nyc report --reporter=text-summary`) shows the required thresholds met.
- Benchmark script executed twice (baseline vs. optimized) and the diff is printed; confirm the improvement meets the target.
- `git diff` shows only intended files changed; no accidental deletions or additions.
- `czek-review` output contains no “critical” findings.

## Avoid
- Changing function signatures, return types, or CLI flags.
- Adding heavy dependencies just for a micro-optimization.
- Refactoring large chunks without intermediate test verification.
- Relying on global npm installs or tools not already in the project.
- Committing or pushing changes without explicit user instruction.
