---
name: czek-review
description: Use before finishing any non-trivial change - a self code review of your own diff for correctness, edge cases, leftovers, security and consistency with the project, so the user gets working code the first time.
---

# Self-review before you say "done"

Re-read the full diff (`git diff` or the files you touched) and check:

1. **Does it do what was asked** – all of it, nothing extra?
2. **Edge cases**: empty/null input, errors from network/files, large inputs, concurrent use, first run with no data.
3. **Errors are handled** where they can happen and shown to the user in a useful way; nothing is silently swallowed.
4. **Consistency**: naming, style, file layout and libraries match the rest of the project; no duplicated helper that already exists.
5. **Leftovers**: debug prints, commented-out code, TODOs you created, unused imports/variables, temp files.
6. **Security**: no secrets in code, user input validated/escaped, no `eval` on input, paths cannot escape their folder.
7. **It was actually run**: build + tests + a real run of the feature. If something could not be verified, say it explicitly.

Fix what you find, then report briefly. Do not pad the report.
