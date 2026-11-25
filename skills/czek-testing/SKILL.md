---
name: czek-testing
description: Use when writing, fixing or running tests, when asked to add tests, or before claiming a feature works. How to test what matters with the project's existing test setup, keep tests honest and never edit tests to make them pass.
---

# Testing

- **Use what the project already has** (package.json `test` script, `pytest`, `cargo test`, `go test`…). Do not add a new framework unless there is none; then pick the standard one (`node:test`, pytest, built-in test runners).
- **Test behaviour, not implementation.** Inputs → expected outputs, including edge cases: empty, zero, very large, invalid input, unicode/diacritics, missing file.
- **One reason to fail per test**, clear names (`returns 0 for an empty cart`).
- **Never weaken or delete a test to get green.** If a test is truly wrong, say so and explain why before changing it.
- **Run the full suite** at the end, not only the new test. Report the exact pass/fail counts.
- **Bug fix = regression test first**: write a test that fails because of the bug, then fix the code until it passes.
- Keep tests fast and isolated: temp folders, no real network or real user data, no fixed ports when avoidable.
- For UI: at minimum render/start the app and check it shows content; for CLIs run the command with real arguments.
