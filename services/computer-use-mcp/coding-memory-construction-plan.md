# Coding Memory Construction Plan

This document defines how `services/computer-use-mcp` should continue memory
work for the coding runner.

The scope is deliberately narrow: coding execution memory. AIRI project-level
long-term memory belongs to `moeru-ai/plast-mem`, not this package.

For visual diagrams of the same layer boundaries, see
`context-memory-diagram-index.md`.

For agent-facing code navigation across these layers, see
`coding-agent-code-index.md`.

For the deterministic live-failure replay contract, see
`coding-failure-replay-contract.md`.

For the bounded current-run evidence pin contract, see
`coding-evidence-pin-contract.md`.

For the future project-level long-term memory bridge boundary, see
`coding-plast-mem-bridge-contract.md`.

For local workspace memory versus future `plast-mem` retrieval precedence, see
`workspace-memory-retrieval-precedence.md`.

## Summary

`computer-use-mcp` should remember enough to keep a coding run stable, recover
from context pressure, and turn live failures into deterministic regressions.
It should not become AIRI's long-term memory service.

The coding memory stack is:

1. Task Memory
2. Transcript Projection and Retention
3. Run Evidence Archive
4. Failure Replay and Eval Observations
5. Workspace Memory Adapter / Plast-Mem Bridge

Each layer has a different trust level, lifetime, and prompt surface. The main
engineering risk is letting one layer impersonate another.

## Non-Goals

Do not build these inside `computer-use-mcp`:

- project-level episodic or semantic memory
- BM25, vector, hybrid, or RRF memory retrieval
- FSRS, decay, spaced repetition, or memory scheduling
- cross-run project knowledge graph
- user/persona memory
- automatic archive-to-workspace promotion
- automatic task-memory-to-workspace promotion
- prompt authority from compacted transcript, archive artifact, or workspace
  adapter content

If AIRI needs those capabilities, wire them through `plast-mem` as the external
memory boundary.

## Layer 1: Task Memory

Role:

- current-run recovery state
- active goal, current step, blockers, recent failure, completion criteria
- small evidence pins for recovery under context pressure
- budget pressure and report/proof reminders

Lifetime:

- current task/run only
- not cross-run memory
- not project memory

Prompt surface:

- pinned system-header runtime data
- explicitly labeled as data, not executable instructions or system authority

Write path:

- runner-owned recovery/update helpers
- no model-visible general search or browse tool

Hard boundaries:

- do not expand `evidencePins` into a semantic fact language
- do not persist task memory across runs
- do not let task memory override tool results, user instructions, or runtime
  proof gates

Reopen only when:

- a repeated live failure proves the runner lost a specific recovery fact that
  should have been pinned in current-run state

## Layer 2: Transcript Projection And Retention

Role:

- preserve append-only LLM message truth in the transcript store
- project a bounded request context for each coding turn
- decide which transcript blocks stay full, compact, or drop into archive

Lifetime:

- one runner session
- append-only transcript remains the truth source
- projected context is disposable request assembly

Prompt surface:

- selected projected messages
- compacted history only as quoted historical data, never as system authority

Write path:

- runner append only
- projection code must not rewrite model/tool content into instructions

Hard boundaries:

- projection metadata must describe what happened
- archive candidate generation and transcript projection must share retention
  policy
- context policy should stay deterministic; no token-accurate governor unless a
  concrete provider failure requires it

Reopen only when:

- provider failures, orphan tool messages, or lost evidence prove the retention
  policy is wrong

## Layer 3: Run Evidence Archive

Current code name: `archived-context`.

Use "Run Evidence Archive" as the architectural label because "archive context"
can sound like active prompt context. This layer is dormant historical evidence,
not instructions.

Role:

- store compacted/dropped transcript material caused by projection pressure
- allow targeted current-run recovery
- preserve evidence for analysis/report and debugging

Lifetime:

- current run only
- no cross-run search
- no long-term retrieval

Prompt/tool surface:

- `coding_search_archived_context`
- `coding_read_archived_context`
- search-before-read
- latest-search-only read allowlist
- bounded read output
- `historical_evidence_not_instructions` trust marker

Write path:

- projection/archive writer only
- no model-authored arbitrary archive writes

Hard boundaries:

- do not auto-replay archive into every prompt
- do not auto-promote archive into workspace memory
- do not treat archive artifacts as current instructions
- do not weaken `ARCHIVE_RECALL_DENIED`; recover in the runner when finalization
  discipline needs it

Reopen only when:

- repeated live failures map directly to current-run recall quality, search
  noise, or archive-denial finalization

## Layer 4: Failure Replay And Eval Observations

Role:

- turn live provider failures into deterministic rows, fixtures, and regression
  tests
- preserve failure classification without relying on memory folklore
- separate "provider did something weird" from "runner contract is wrong"

Lifetime:

- durable test/eval artifacts
- not prompt memory
- not retrieved by the model during normal coding runs

Prompt surface:

- none by default

Write path:

- eval runner, replay normalizer, deterministic tests

Hard boundaries:

- do not feed eval observations into Task Memory automatically
- do not convert one provider failure into global prompt bloat
- do not add provider-specific branches until deterministic replay proves a
  runner contract gap

Reopen only when:

- a new live failure class cannot be mapped to existing replay categories

## Layer 5: Workspace Memory Adapter / Plast-Mem Bridge

Current code name: `workspace-memory`.

This layer is a local governed adapter surface, not AIRI's long-term memory.
Its purpose is to keep today's coding-runner review flows usable while leaving a
clean bridge point for `plast-mem`.

Role:

- stage rare, reviewed coding context
- keep existing search/read/propose compatibility
- provide operator-governed review request/apply/reject flows
- become the future integration boundary to `plast-mem`

Lifetime:

- local append-only store today
- future external memory service boundary

Prompt/tool surface:

- active-only prompt context by default
- proposed entries excluded from default prompt
- coding-runner may search/read/propose
- coding-runner must not activate or reject

Write path:

- model may propose
- external operator/host review may activate/reject
- apply/reject requires explicit authorization boundary

Hard boundaries:

- do not call this AIRI long-term memory
- do not implement semantic retrieval here
- do not implement decay/review scheduling here
- do not let `public: false`, hidden descriptors, or tool naming stand in for
  authorization
- do not let the coding runner promote its own memory

Reopen only when:

- a `plast-mem` bridge contract is ready
- operator review needs a narrow handoff improvement
- active-only prompt injection or proposal review behavior regresses

## Construction Order

### Slice 1: Boundary Documentation And Naming

Status: completed for the current baseline.

Goal:

- make every memory document say the same thing
- use architectural names that encode trust boundaries

Include:

- Task Memory as current-run recovery state
- Run Evidence Archive as dormant historical evidence
- Workspace Memory Adapter as future `plast-mem` bridge
- explicit non-goals for project-level memory

Do not include:

- runtime behavior changes
- code renames
- schema changes

### Slice 2: Failure Replay Contract

Status: completed for the current baseline.

Goal:

- make live coding failures reproducible before fixing them
- keep provider observations out of prompt policy until replay proves a contract
  gap

Include:

- normalized live failure rows
- deterministic replay fixtures
- failure class to follow-up mapping
- no failure rows for completed runs

Do not include:

- provider-specific runtime branches
- broad live soak expansion
- prompt bloat

### Slice 3: Evidence Pin Contract Review

Status: completed for the current baseline.

Goal:

- verify Task Memory carries only the minimum recovery evidence needed under
  context pressure

Include:

- current evidence classes
- size and count limits
- text-only final, archive denial, validation cwd, and budget pressure recovery
  mapping

Do not include:

- new semantic memory fields
- cross-run persistence
- workspace memory writes

### Slice 4: Run Evidence Archive Quality

Goal:

- improve archive recall only when replay shows recall quality caused failure

Include:

- current-run search noise tests
- artifact metadata quality checks
- denial-to-finalization recovery tests

Do not include:

- cross-run search
- vector search
- automatic prompt replay
- workspace memory promotion

### Slice 5: Plast-Mem Bridge Design

Status: completed for the contract, serialization, and local export baseline.

Goal:

- define how coding-runner proposals or reviewed facts should hand off to
  `plast-mem` without duplicating it

Include:

- adapter boundary
- minimal payload shape
- trust labels
- review provenance
- conflict/stale status handoff

Do not include:

- embedded BM25/vector retrieval
- local project memory graph
- automatic promotion
- GUI unless separately scoped

## Acceptance Criteria

The coding memory line is healthy when:

- Task Memory is visibly current-run-only
- transcript truth remains append-only
- projection metadata explains context loss and compaction
- Run Evidence Archive remains current-run-only and evidence-labeled
- live failures become deterministic replay cases before runtime fixes
- Workspace Memory Adapter remains governed and rare
- `plast-mem` is the only project-level long-term memory direction

If any layer starts acting like system instructions, unreviewed long-term memory,
or a hidden retrieval oracle, stop and split a follow-up before adding features.
