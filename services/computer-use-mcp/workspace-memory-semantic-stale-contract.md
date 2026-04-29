# Workspace Memory Semantic Stale Contract

## Purpose

This document defines the deterministic stale-judgment contract for reviewed
coding workspace memory.

It is not an automatic cleanup system. It does not reject, activate, export, or
hide memory entries by itself. It only classifies whether an active,
human-verified memory entry should be considered current, review-worthy, or a
stale candidate for operator review.

## Scope

This contract applies to:

- local `WorkspaceMemoryEntry` records with `status: active`
- entries with `humanVerified: true`
- coding memory that may be exported to, ingested by, or retrieved near
  `plast-mem`

It does not apply to:

- proposed memory
- rejected memory
- TaskMemory
- Run Evidence Archive / archived context
- failure replay rows
- plast-mem internal semantic consolidation state

## Contract Surface

The tested contract lives in:

- `src/workspace-memory/semantic-stale.ts`
- `src/workspace-memory/semantic-stale.test.ts`
- `src/bin/workspace-memory-review.ts` command `list-semantic-stale`
- `src/bin/workspace-memory-review.test.ts`

The public function is:

```ts
judgeWorkspaceMemorySemanticStale(input)
```

It is a pure function:

- no filesystem reads
- no JSONL appends
- no MCP calls
- no plast-mem HTTP calls
- no WorkspaceMemoryStore mutation
- no review request resolution

Every result includes:

```text
{
  status: 'not_applicable' | 'current' | 'review_recommended' | 'stale_candidate'
  memoryId: string
  reasons: WorkspaceMemorySemanticStaleReasonRecord[]
  suggestedAction: 'none' | 'operator_review' | 'operator_review_before_reuse'
  mutatesMemory: false
}
```

## Inputs

### Memory Entry

Only active, human-verified entries are judged:

```ts
entry.status === 'active'
entry.humanVerified === true
```

Anything else returns:

```text
status: 'not_applicable'
suggestedAction: 'none'
mutatesMemory: false
```

This prevents proposed or rejected entries from being treated as stale active
memory candidates.

### Source Files Changed

Input:

```text
changedFiles: string[]
```

If any `changedFiles` overlap with `entry.relatedFiles`, the function emits:

```text
reason: 'source_files_changed'
severity: 'soft'
status: 'review_recommended'
```

This is not a hard stale decision. A related file changing means the memory
should be rechecked, not automatically rejected.

### Review Age

Input:

```text
now: string | Date
maxReviewAgeDays?: number
```

Default max review age:

```text
90 days
```

If `entry.review.reviewedAt` is older than the threshold, the function emits:

```text
reason: 'review_age_exceeded'
severity: 'soft'
status: 'review_recommended'
```

Age alone is not enough to reject memory. It is only an operator review signal.

### Current-Run Evidence Conflicts

Input:

```text
currentRunEvidenceConflicts: Array<{
  source: 'trusted_tool_result' | 'verification_gate' | 'archive_recall' | 'task_memory'
  summary: string
}>
```

If present, the function emits:

```text
reason: 'conflicts_with_current_run_evidence'
severity: 'hard'
status: 'stale_candidate'
suggestedAction: 'operator_review_before_reuse'
```

Reason: current-run evidence has higher authority than workspace memory. A
reviewed memory entry that conflicts with current tool/gate evidence should not
be silently trusted.

### Plast-Mem Invalidation Signal

Input:

```text
plastMemInvalidationSignal: {
  source: string
  reason: string
  receivedAt?: string
}
```

If present, the function emits:

```text
reason: 'plast_mem_invalidation_signal'
severity: 'hard'
status: 'stale_candidate'
suggestedAction: 'operator_review_before_reuse'
```

This signal is advisory for local governance. It does not let plast-mem mutate
local workspace memory directly.

## Output Semantics

### `current`

No stale signal exists.

The entry may continue to be considered active local workspace context, still
below current-run evidence and verification gates.

### `review_recommended`

Only soft signals exist:

- related source file changed
- review age exceeded

The operator should inspect it, but the function does not mark it rejected,
stale, or inactive.

### `stale_candidate`

At least one hard signal exists:

- conflicts with current-run evidence
- plast-mem invalidation signal

The operator should review before reuse, but status changes still require the
existing governed review/apply/reject surfaces.

### `not_applicable`

The entry is not active human-verified workspace memory.

## Authority Boundary

Semantic stale judgment is weaker than:

- runtime/system rules
- active user instruction
- verification gate decisions
- trusted current-run tool results
- current-run TaskMemory evidence
- current-run Archive recall evidence

Semantic stale judgment cannot:

- satisfy completion
- satisfy mutation proof
- bypass verification gates
- mutate workspace memory
- resolve review requests
- export memory to plast-mem
- ingest memory into plast-mem
- suppress shell guard, archive recall, or tool-adherence failures

## Non-Goals

- No automatic reject/activate.
- No automatic stale cleanup.
- No MCP tool.
- No coding-runner prompt behavior change.
- No plast-mem HTTP call.
- No filesystem scan.
- No vector/BM25/RRF retrieval.
- No GUI review behavior.
- No TaskMemory or Archive promotion.

## Future Slices

1. `feat(computer-use-mcp): add MCP semantic stale candidate listing`
   - Optional external host surface over the same pure judgment.
   - Must remain read-only.

2. `feat(computer-use-mcp): add semantic stale review CLI`
   - Add higher-level operator workflows around request/reject/apply.
   - Must use existing governed review surfaces.

3. `feat(computer-use-mcp): surface semantic stale candidates in review GUI`
   - GUI should consume existing candidate/review/apply/reject surfaces.
   - GUI must not invent new governance behavior.
