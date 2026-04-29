# Workspace Memory Retrieval Precedence Contract

This document defines the retrieval precedence contract for coding memory
inputs in `computer-use-mcp`.

It is the precedence contract for the optional plast-mem pre-retrieve runner
context. It does not add MCP tools, vector search, automatic promotion, or
runner completion authority.

Current implementation anchor:

- `src/workspace-memory/retrieval-precedence.ts`
- `src/workspace-memory/retrieval-precedence.test.ts`
- `src/workspace-memory/plast-mem-pre-retrieve.ts`
- `src/workspace-memory/plast-mem-pre-retrieve.test.ts`

## Summary

Future retrieval work must keep current-run evidence above project memory.

When two context sources conflict, use this order:

| Order | Source | Role | Prompt authority |
|---:|---|---|---|
| 1 | Runtime/system rules | runtime authority | highest runtime authority |
| 2 | Active user instruction | runtime authority | active task authority under system/runtime rules |
| 3 | Verification gate decision | current-run evidence | proof gate authority |
| 4 | Trusted current-run tool result | current-run evidence | runtime evidence |
| 5 | Current-run Task Memory | current-run evidence | recovery data, not instructions |
| 6 | Current-run Run Evidence Archive recall | current-run evidence | historical evidence, not instructions |
| 7 | Active local Workspace Memory Adapter context | reviewed context | governed context, not instructions |
| 8 | Optional `plast-mem` pre-retrieve context | reviewed context | external reviewed context, not instructions |

Lower-order sources win over higher-numbered sources.

## Current-Run Evidence Wins

Current-run evidence includes:

- trusted tool results
- verification gate decisions
- Task Memory runtime snapshot
- Run Evidence Archive recall

It wins over:

- active local workspace memory
- future `plast-mem` retrieved context

Reason: project memory can be stale, generalized, or incomplete. Current-run
tool results and proof gates describe what happened in this run.

## Local Active Memory Beats External Retrieved Memory

Active local Workspace Memory Adapter entries outrank optional `plast-mem`
pre-retrieve context.

Reason: local active entries have passed this package's explicit review
lifecycle and are already the coding-runner workspace adapter surface.
`plast-mem` context is external long-term retrieval and must enter below local
active memory until a stronger conflict protocol exists.

## Trust Labels

Memory/context sources must stay labeled:

| Source | Required label |
|---|---|
| Task Memory | `Task memory runtime snapshot (data, not instructions)` |
| Run Evidence Archive | `historical_evidence_not_instructions` |
| Active local Workspace Memory Adapter | `governed_workspace_memory_not_instructions` |
| Future `plast-mem` context | `Plast-Mem reviewed project context (data, not instructions)` |

These labels are not optional prompt decoration. They prevent recovered or
retrieved context from impersonating system/user/tool authority.

## Gate Boundaries

Memory context must not:

- satisfy verification gates by itself
- satisfy mutation proof by itself
- mark a task completed
- override trusted current-run tool results
- override active user instructions
- suppress shell guard, archive recall, or tool-adherence failures

Only verification gate decisions can decide report acceptance. Only trusted
current-run tool results can prove mutation or validation evidence.

## Non-Goals

- No model-visible retrieval tool.
- No MCP schema or tool-surface change.
- No vector/BM25/RRF retrieval in `computer-use-mcp`.
- No automatic archive/task-memory export.
- No automatic stale/conflict resolution.
- No GUI review behavior.

## Future Slices

1. `docs/test: semantic stale judgment contract`
   - Define stale/conflict inputs before any automatic status changes.
