---
name: czek-git
description: Use for commits, branches, merges, pull requests, resolving conflicts or any git trouble. Safe everyday git workflow for team and class projects - small commits, clear messages, never committing secrets, never destroying others' work.
---

# Git workflow

- Check state first: `git status`, `git branch --show-current`, `git log --oneline -5`.
- **Small, focused commits** with clear messages (`fix: …`, `feat: …`, `docs: …`). One logical change per commit.
- Before committing: review `git diff --cached`; make sure no secrets, `.env`, build output or `node_modules` are staged. Add them to `.gitignore`.
- Work on a branch for anything non-trivial: `git checkout -b short-topic`.
- Sync before pushing: `git pull --rebase` (or merge if the team prefers). Resolve conflicts by keeping BOTH sides' intent, then run tests.
- **Never** run destructive commands (`reset --hard`, `push --force`, `clean -fd`, `branch -D`) on shared branches or without explicit user approval; they can delete others' work.
- Pull requests: describe what and why, how it was tested, screenshots for UI.
- If a secret was committed: tell the user to revoke it immediately; rewriting history alone is not enough once pushed.
