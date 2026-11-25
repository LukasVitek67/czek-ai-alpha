---
name: czek-debugging
description: Use for any bug, error message, crash, wrong output, failing test or "it doesn't work". Systematic procedure - reproduce, read the full error, isolate, find the root cause, fix, prove the fix with a test - instead of guessing and retrying.
---

# Debugging like a senior engineer

1. **Reproduce first.** Get the exact command/steps that fail and run them yourself. No reproduction = no fix, only guesses.
2. **Read the whole error.** First line of a stack trace that points into the project's own code is usually the place. Do not truncate output with `| head`; read it all once.
3. **Form one hypothesis, test it cheaply.** Add a print/log, run a 3-line script, check a value. Change one thing at a time.
4. **Find the root cause, not the symptom.** Ask "why did this value become wrong?" until you reach the origin. A try/catch that hides the error is not a fix.
5. **Fix minimally**, in the place where the cause is.
6. **Prove it.** Re-run the reproduction. Add or update a test that would have caught it, when the project has tests.
7. **Check neighbours.** Search for the same mistake elsewhere (`grep` the pattern).

## Anti-loop rules
- Same error after 2 fixes → your model of the problem is wrong. Stop editing; read more code around it, or print intermediate values.
- Do not reinstall dependencies, delete caches or rewrite files "to see if it helps" before you know the cause.
- Environment errors (missing command, wrong path, port in use) – fix the environment, do not change app code for them.

## Common causes checklist
off-by-one · null/undefined not handled · async not awaited · wrong path (relative vs absolute, Windows `\` vs `/`) · stale build output · wrong env/config · type mismatch (string "1" vs number 1) · state mutated in two places · regex/encoding (UTF-8, diacritics).
