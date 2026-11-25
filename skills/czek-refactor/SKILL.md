---
name: czek-refactor
description: Use for cleanup, restructuring, renaming, splitting big files or functions, removing duplication. How to change structure without changing behaviour - safety net first, small steps, run tests after each step.
---

# Refactoring safely

- **Behaviour must not change.** If there are no tests around the code, write a quick characterization test or script first that captures current output.
- **Small steps, each one green**: rename → run → extract function → run → move file → run. Never a big-bang rewrite.
- Use project-wide search to update every usage (imports, strings in config, docs). Check that nothing still references the old name.
- Keep public interfaces (exported functions, CLI flags, config keys, file formats) unless the user asked to change them; if you must, keep a compatibility path.
- Delete dead code only when you proved it is unused (search for usages, run tests).
- Stop when the code is clearly better; do not refactor unrelated parts in the same change.
