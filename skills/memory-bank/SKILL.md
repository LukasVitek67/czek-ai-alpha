---
name: memory-bank
description: Persistent, queryable project memory in `.claude/memory_bank/` (decisions, patterns, architecture, troubleshooting) so context survives between sessions and prompts stay small. Use when the user asks to create, update, sync, query, clean up or back up the memory bank, at the start of work in a project that already has `.claude/memory_bank/`, or when wrapping up a feature/hotfix and its knowledge should be recorded.
---

# Memory Bank

Adapted for OpenCode from [russbeye/claude-memory-bank](https://github.com/russbeye/claude-memory-bank) (MIT). The original instructions are kept verbatim in `reference/`; follow them. Paths in them (`.claude/memory_bank/...`) are relative to the project root and stay compatible with Claude Code.

## Layout (in the user's project)

- `.claude/memory_bank/decisions/**` – ADRs and trade-offs
- `.claude/memory_bank/patterns/**` – cross-cutting patterns and conventions
- `.claude/memory_bank/architecture/**` – module/service topology
- `.claude/memory_bank/troubleshooting/**` – known issues and proven fixes
- `.claude/memory_bank/stash/**` – scratch pad, read only when referenced
- `.claude/memory_bank/archive/**` – historic snapshots, **read-only**, last resort

## Principles

- Context order: memory bank → code search → archive (read-only, last resort).
- Load granular files with narrow path scopes; never pull the whole bank.
- Exclude `.claude/memory_bank` from commits unless the user says otherwise.
- Never modify anything under `archive/**`.

## Tasks → which reference to follow

| User wants | Read and follow |
|---|---|
| Create the memory bank / refresh it after changes ("update memory bank") | `reference/commands/context/update-memory-bank.md` |
| Find relevant context for a task ("context query", "what do we know about X") | `reference/commands/context/context-query.md` |
| See what changed since last sync | `reference/commands/context/context-diff.md` |
| Find stale or outdated entries | `reference/commands/context/stale-context-check.md` |
| Clean up / deduplicate context | `reference/commands/context/cleanup-context.md` |
| Rebuild granular files from the archive | `reference/commands/context/rebuild-granular-from-archive.md` |
| Start a new feature with the right context | `reference/workflows/memory-bank/new-feature-rehydrate.md` |
| Finish a feature and record what was learned | `reference/workflows/memory-bank/feature-wrap.md` |
| Hotfix flow | `reference/workflows/memory-bank/hotfix.md` |
| Just-in-time context loading | `reference/workflows/memory-bank/jit-context.md` |
| Periodic hygiene / delta sync | `reference/workflows/memory-bank/hygiene.md`, `reference/workflows/memory-bank/delta-sync.md` |

General guidance (token-lean rules, backups, archive handling, fast file search tips): `reference/guidance.md`.
Role descriptions the original uses as sub-agents (code-searcher, memory-bank-synchronizer, context-query-agent, …): `reference/agents/`. In OpenCode, perform those roles yourself (or via OpenCode's own sub-agents if available).

Some commands mention CLI tools (`fd`, `rg`, `git`). If a tool is missing, use the equivalent tools you have.
