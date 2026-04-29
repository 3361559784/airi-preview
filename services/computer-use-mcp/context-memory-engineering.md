# Context Memory Engineering

Engineering contract for long-running coding context, transcript compaction, archived context, and future long-term memory inside `computer-use-mcp`.

For the current code-state audit and follow-up slice order, see
`coding-context-memory-substrate-audit.md`. This file remains the architectural
contract; the audit file is the branch-local reality check.

This document exists to stop the memory line from degenerating into:

- blind `messagesCache` slicing
- piles of unstructured `.md` summaries
- accidental pollution of `TaskMemory`
- a fake "memory system" that is really just prompt stuffing with extra steps

The goal here is not to make the system sound smart. The goal is to make long-running coding work lose less context without corrupting the execution substrate.

## Current Facts

These are already true in the codebase:

- `src/task-memory/*`
  - `TaskMemory` exists and is the current-task execution snapshot.
  - It is not a long-term memory system.
- `src/state.ts`
  - `RunState` is ephemeral run state.
- `audit.jsonl`
  - operational trace is persistent, but it is an execution/audit log, not an LLM transcript store.
- `src/transcript/*`
  - transcript truth source and non-destructive projection already exist as a V1 prototype.
- `src/projection/*`
  - operational trace projection exists, but it is not the same thing as transcript memory.
- `src/coding-runner/*`
  - an experimental transcript-driven coding runner exists, but it is not the mainline coding entry yet.

This means the project already has enough substrate to build a proper memory line, but it does not yet have a completed long-term memory subsystem.

## Problem Statement

Simple context compression is too destructive.

If old context is only summarized or sliced away, the system gets three bad outcomes:

1. token pressure drops for the current step, but old details are gone
2. later recovery depends on lossy summaries
3. long runs become increasingly likely to re-open solved questions or repeat mistakes

So the required behavior is:

- prompt context can be compacted
- compacted material must remain recoverable
- recovery must be targeted, not full-folder scavenging
- long-term memory must be governed, not auto-promoted from every summary

## Core Principles

### 1. Truth source and projection stay separate

Do not make projected prompt context the truth source.

Truth sources are layered:

- `TaskMemory`
  - current task snapshot
- `RunState`
  - ephemeral cursor and execution state
- `audit.jsonl`
  - operational execution trace
- `TranscriptStore`
  - transcript truth source for LLM messages
- archived compaction artifacts
  - recoverable compressed context

Projection is always read-only and disposable.

### 2. Not all compacted context is memory

Compacted context is first an archive artifact, not a promoted memory item.

That means:

- every compacted block may be stored
- not every stored block is high-confidence
- not every stored block may be recalled by default
- almost nothing should auto-promote into workspace memory

### 3. `TaskMemory` stays clean

Do not turn `TaskMemory` into a junk drawer.

It remains only for:

- goal
- current step
- blockers
- confirmed facts
- next step
- recent failure reason

It must not absorb:

- archived transcript summaries
- project-wide heuristics
- speculative lessons from one failed run
- durable workspace rules

### 4. Local files are storage, not intelligence

Using local `.md` files is fine for the archive layer.

It is not fine to assume:

- "there is a folder full of summaries"
- "the model can just look around and find the right one"

Memory quality comes from:

- structure
- metadata
- retrieval
- promotion rules
- pollution control

Not from the existence of markdown files.

## Memory Architecture

The memory line should be treated as four layers.

### Layer 0: Operational Trace

Source:

- `audit.jsonl`

Role:

- execution/audit evidence
- approvals
- tool execution artifacts
- screenshot and command evidence

Rules:

- never redefined as transcript memory
- never used as the sole source for prompt history

### Layer 1: Transcript Truth Source

Source:

- `src/transcript/*`
- `transcript.jsonl`

Role:

- canonical LLM transcript store
- non-destructive storage of user/assistant/tool messages
- source for prompt projection

Rules:

- append-only
- no destructive pruning
- compacted summaries never replace transcript truth

### Layer 2: Archived Context

This is the first new long-running memory layer to implement.

Role:

- store compacted or displaced context blocks outside the active prompt
- keep them recoverable by run/task/file relevance
- make them readable by both humans and agents

This layer is the right place for markdown-backed artifacts.

Recommended shape:

- `archived-context/run/<run-id>/...`
- `archived-context/task/<task-id>/...`

Recommended format:

- markdown body for human readability
- frontmatter metadata for retrieval and governance

Minimum metadata:

- `id`
- `scope` (`run` or `task`)
- `run_id`
- `task_id`
- `created_at`
- `summary_type`
- `confidence`
- `tags`
- `related_files`
- `source`
- `human_verified`

This layer is recallable archive, not high-trust memory.

### Layer 3: Workspace Memory

This is the true long-term memory layer.

Role:

- durable project constraints
- stable repo facts
- repeated build/tooling rules
- verified recurring pitfalls

Examples:

- package manager requirements
- stable build entrypoints
- known validation commands
- confirmed directory ownership rules

Rules:

- update threshold must be high
- no automatic promotion from ordinary compaction
- should require repeated evidence, explicit verification, or human confirmation

If this layer is implemented too early, it will fill with false confidence garbage.

## Retrieval Model

Do not let the model freely sweep a folder tree.

Archived context must be accessed through a retrieval surface.

V1 retrieval should stay simple and explicit:

- search by `run_id`
- search by `task_id`
- search by `tags`
- search by `related_files`
- search by keyword

Results should be narrowed before read:

- return a small candidate list
- default to 3 to 5 items, not entire directories

The intended future tool shape is conceptually:

- `search_archived_context`
- `read_archived_context`

`promote_workspace_memory` should exist only after archive retrieval is stable.

## Compaction and Archive Policy

Compaction should stop being destructive.

When active prompt context must be reduced:

1. compute compacted summaries from transcript/history blocks
2. write those summaries into archived context
3. keep only the necessary projection in the active prompt
4. leave transcript truth source intact

Archive writes should happen only for compacted or displaced blocks that are still plausibly useful later.

Do not archive:

- every trivial turn
- every repetitive tool success
- every hallucinated plan fragment

Do archive:

- long tool outputs whose detail may matter later
- change-review summaries tied to specific files
- diagnosis artifacts
- failure investigations
- plan revisions that explain why direction changed

## Pollution Control

This is the part most likely to rot if ignored.

Bad summaries should not silently become durable truth.

Required controls:

- every archived artifact carries confidence
- archive scope stays separate from workspace memory
- recalled context is still evidence, not truth, unless verified
- promotion to workspace memory is rare and explicit

If a model makes a wrong summary once, that summary must not automatically poison future runs.

## Implementation Phases

### Phase 1: Archive Layer V1

Build only:

- archive storage layout
- markdown + frontmatter record format
- write path for compacted artifacts
- manual readability

Do not build:

- workspace memory promotion
- vector memory
- GUI

### Phase 2: Retrieval V1

Build:

- archive search by run/task/tags/files/keywords
- bounded candidate output
- archive read path

Do not build:

- freeform folder crawling by the model
- global auto-recall

### Phase 3: Recall Integration

Build:

- targeted recall during coding runs
- bounded insertion of retrieved archive artifacts into prompt projection

Do not build:

- broad automatic replay of archived context

### Phase 4: Workspace Memory Governance

Only after the first three phases are stable:

- define promotion rules
- define verification threshold
- define conflict resolution and stale-memory cleanup

Current governance and lifecycle rules are documented in
`coding-context-memory-substrate-audit.md#workspace-memory-promotion-governance`
and
`coding-context-memory-substrate-audit.md#workspace-memory-lifecycle-governance`.
Treat those sections as the current policy source before implementing any new
promotion, cleanup, GUI, or model-visible review surface.

## Explicit Non-Goals

These are intentionally out of scope for the first real memory implementation:

- GUI for memory browsing
- vector database by default
- automatic long-term promotion of every compacted summary
- replacing `TaskMemory`
- replacing transcript truth source
- treating `audit.jsonl` as memory
- letting the model recursively browse a directory full of markdown files

## Success Criteria

This line is successful when all of the following are true:

- active prompt context can shrink without destroying recoverability
- compacted context is archived outside the active prompt
- archived context is retrievable by narrow, explicit queries
- `TaskMemory` remains clean and task-scoped
- transcript truth source remains append-only
- workspace memory remains rare, governed, and high-trust

If those are not true, the system is still doing primitive compression, not memory engineering.

## Practical Call

The next engineering move is not GUI and not full long-term memory.

The next move is:

- build the archive layer
- make compaction artifacts recoverable
- add bounded retrieval

That is the first durable version of memory that is worth shipping.

## Current-State Note

The original Phase 1 target was a write-only archive layer. The current code has
already moved past that narrow statement: archive artifacts are still written as
markdown/frontmatter files, but current-run `search()` / `readArtifact()` and
runner tools now exist.

Current label:

- Archive is a current-run recallable archive.
- Archive is not cross-run long-term memory.
- Archive is not workspace memory.
- Workspace memory proposal/search/read exists, but promotion governance is not
  complete.

Do not describe the memory line as complete. Use
`coding-context-memory-substrate-audit.md` for the current source-of-truth map,
known gaps, and next implementation slices.
