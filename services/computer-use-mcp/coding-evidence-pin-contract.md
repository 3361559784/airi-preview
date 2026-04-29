# Coding Evidence Pin Contract

This document defines the current evidence pin contract for coding-runner Task
Memory.

Evidence pins are current-run recovery anchors. They are not semantic memory,
not durable project knowledge, and not prompt authority.

## Purpose

Evidence pins keep small, high-value runtime proof visible under context
pressure. They should help the runner recover from known completion, validation,
and proof failures without turning Task Memory into a general fact store.

## Limits

- Maximum pins kept in Task Memory: `TASK_MEMORY_LIMITS.evidencePins` (`8`).
- Maximum formatted pin length: `240` characters.
- Formatting strips control characters and collapses whitespace.
- Merge behavior deduplicates pins and keeps the newest bounded tail.

## Current Pin Prefixes

The current coding-runner pin prefixes are:

- `budget_exhausted:<details>`
- `tool_failure:<toolName>: <summary>`
- `verification_gate_failed:<reasonCode>: <summary>`
- `archive_recall_denied: <summary>`
- `reported_status:<status>: <summary>`
- `edit_proof:<path>: <proof summary>`
- `terminal_result:<command>: <exit summary>`
- `change_review:<status>: <review summary>`

Do not add new prefixes unless a concrete replayed live failure needs a new
recovery anchor.

## Non-Pin Recovery State

Some recovery paths intentionally update `recentFailureReason` and `nextStep`
without adding a pin.

Current example:

- text-only final / report-only correction

Reason: the corrective turn is immediate and bounded; pinning assistant summary
text would risk turning a protocol failure into durable semantic memory.

## Boundaries

Evidence pins must not:

- persist across runs
- auto-promote into workspace memory
- contain project-level long-term memory
- override user instructions, trusted tool results, or verification gates
- become a general taxonomy language
- store raw transcript/archive dumps

If a recovery needs more information than a bounded pin can hold, use replay,
archive recall, or a targeted runner follow-up instead of expanding pins.

## Related Code

- `src/coding-runner/memory.ts`
- `src/task-memory/types.ts`
- `src/task-memory/merge.ts`
- `src/task-memory/manager.ts`

Related tests:

- `src/coding-runner/memory.test.ts`
- `src/task-memory/task-memory.test.ts`
- `src/coding-runner/coding-runner.test.ts`

