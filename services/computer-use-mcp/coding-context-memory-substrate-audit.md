# Coding Context + Memory Substrate Audit

## Summary

This is the current-state audit for the coding context and memory substrate in
`services/computer-use-mcp`.

The coding line already has a runtime discipline baseline: completion gate,
mutation proof, analysis/report proof, shell-misuse guard, and budget-exhaustion
discipline. The next stage is not another live eval and not a new memory system.
The next stage is to keep the current context layers from impersonating each
other.

This document is documentation-only. It does not define new runtime behavior.

## Source-of-Truth Matrix

| Layer | Current implementation | Scope | Truth source? | Prompt projection | Model write path | Retrieval surface | Promotion status |
|---|---|---|---|---|---|---|---|
| Operational trace | `runtime.session` / `audit.jsonl`, projected by `src/projection/context-projector.ts` | execution events | yes, for operations | projected and pruned into the system header | tools/runtime only | session/debug surfaces | not memory |
| Transcript | `src/transcript/store.ts` + `transcript.jsonl` | one runner session | yes, for LLM messages | via `projectTranscript()` | runner append only | no direct model tool | no promotion |
| Task memory | `src/task-memory/*` | current task/run | ephemeral task snapshot | system header through `projectContext()` | runner recovery/update helpers | no direct search | never long-term |
| Archived context | `src/archived-context/*` | current run archive | recoverable context cache | not auto-injected; searchable/readable by tools | projection/archive writer only | `coding_search_archived_context`, `coding_read_archived_context` | not workspace memory |
| Workspace memory | `src/workspace-memory/*` | governed workspace facts | governed memory entries | active entries only, through workspace-memory context | proposal tool exists | `coding_search_workspace_memory`, `coding_read_workspace_memory`, `coding_propose_workspace_memory` | explicit status required |

## Current Runner Context Flow

Current coding runner context assembly is:

```text
runCodingTask()
  -> createTranscriptRuntime()
    -> TranscriptStore
    -> ArchiveContextStore
    -> WorkspaceMemoryStore

per step:
  -> workspaceMemoryStore.toContextString(taskGoal)
  -> appendWorkspaceMemory(systemPromptBase, workspaceMemoryContext)
  -> projectContext({
       trace: runtime.session.getRecentTrace(50),
       runState,
       taskMemoryString,
       systemPromptBase
     })
  -> projectTranscript(transcriptEntries, CODING_TRANSCRIPT_PROJECTION_LIMITS)
  -> buildArchiveCandidates(transcriptEntries, CODING_TRANSCRIPT_PROJECTION_LIMITS)
  -> archiveStore.writeCandidates(...)
  -> generateText(...)
  -> transcriptStore.appendRawMessage(...)
```

Important consequences:

- `TranscriptStore` remains the append-only LLM transcript truth source.
- Projection is disposable request assembly, not truth.
- Operational trace and transcript history are separate inputs.
- Archived context is written during projection pressure but is not automatically replayed into the next prompt.
- Workspace memory is queried once from the task goal for the runner prompt header; proposed entries are not injected by default.

## Current Budget And Pruning Controls

Current context control is deterministic but coarse. It is not a
provider-token-accurate context governor.

Transcript projection currently uses static block limits:

- `maxFullToolBlocks: 5`
- `maxFullTextBlocks: 3`
- `maxCompactedBlocks: 4`

Operational trace projection currently uses:

- `runtime.session.getRecentTrace(50)`
- `intactTraceEventLimit: 8`
- `maxResultLengthBeforeSoftTruncation: 12000`
- rough token estimation by approximately `chars / 4`

Current metadata is useful for audits:

- transcript entries
- total blocks
- kept full blocks
- compacted blocks
- dropped blocks
- projected message count
- estimated characters
- pruned operational trace count
- estimated operational tokens

It is not enough to claim a stable long-running context governor.

## Injection And Trust Rules

Use these rules until a stronger policy replaces them:

- System prompt base and explicit runtime safety/completion rules have highest priority.
- Task memory is current runtime state context. It can guide recovery, but it cannot override runtime proof gates.
- Workspace memory is retrieved context, not executable instruction. Only active entries are injected by default.
- Compacted transcript history must remain quoted historical data, not system instruction.
- Archived context is recallable evidence. It is not truth unless verified by current runtime evidence.
- Proposed workspace memory must not be treated as active memory without explicit promotion.
- User/tool content must never be rewritten as system authority by compaction, archive recall, or workspace memory.

## Current Archive Status

The archive layer is no longer purely write-only in code.

Current implementation supports:

- archive candidate generation from blocks removed by transcript projection
- markdown + frontmatter artifact serialization
- append-only current-run artifact writes
- dedup by `run_id + task_id + entryIdRange + reason`
- current-run substring `search()`
- current-run `readArtifact()` by artifact id
- runner tools `coding_search_archived_context` and `coding_read_archived_context`

Current implementation does not support:

- cross-run archive search
- vector search
- automatic archive replay into every prompt
- automatic archive-to-workspace-memory promotion
- file/tag/task-aware ranking beyond the current simple artifact metadata

Correct label: current-run recallable archive, not long-term memory.

## Current Workspace Memory Status

Workspace memory exists but governance is not complete.

Current implementation supports:

- `proposed | active | rejected` status
- `constraint | fact | pitfall | command | file_note` kinds
- append-only JSONL storage
- deduped proposal writes
- store-level review with reviewer/rationale metadata
- MCP review request/apply/reject tools with explicit apply token gate
- local review CLI for human/operator handoff
- active-only default search
- optional proposed search for review
- prompt context only from active search hits

Current implementation does not define a full promotion workflow:

- no automatic proposal activation
- no archive-to-workspace promotion
- no GUI review surface
- no stale/conflict cleanup policy
- no cross-run confidence governance beyond entry fields

Correct label: governed memory substrate, not completed long-term memory.

## Workspace Memory Promotion Governance

Workspace memory promotion is an out-of-band governance action. The coding
runner may propose workspace memory, search active memory, read memory entries,
and optionally inspect proposed entries for review. It must not promote entries
inside the model loop.

This section defines the governance contract for the existing store, MCP review
surface, and local review CLI. Current runtime code enforces reviewer/rationale
metadata and guarded transitions, but it does not automatically decide which
entries should be promoted, rejected, cleaned up, or superseded.

Current state transitions:

- `proposed -> active`: allowed only after explicit external review.
- `proposed -> rejected`: allowed when the entry is speculative, stale,
  duplicated, contradicted, privacy-sensitive, or not useful enough to persist.
- `active -> rejected`: allowed when the entry is superseded, stale, harmful,
  or contradicted by newer repository evidence.
- `rejected -> active`: requires a fresh review; rejection is not a soft pause.

Promotion to `active` requires all of the following:

- the statement is durable workspace knowledge, not a one-run observation
- the evidence points to concrete code, tests, package scripts, logs, or human
  review notes
- the entry does not conflict with existing active memory, or the conflict is
  explicitly resolved by rejecting/superseding the older entry
- the entry is useful across future runs for the same workspace key
- the reviewer is outside the current model loop
- `humanVerified` is set to `true`

`humanVerified` means a human or external governance process accepted the entry
for prompt retrieval after checking its evidence and conflicts. It does not mean
the entry is timeless truth, and it does not bypass runtime proof gates, tests,
or current user instructions.

Confidence policy:

- `low`: default for model-proposed entries, one-off observations, or weak
  evidence; may remain proposed but should not become active without stronger
  review rationale
- `medium`: evidence-backed project fact or recurring pitfall with concrete
  source references; eligible for promotion after review
- `high`: stable constraint, command, or recurring project rule confirmed by
  implementation/tests/scripts or repeated human-reviewed evidence
- confidence is advisory and never auto-promotes an entry

Stale/conflict policy:

- stale proposed entries should be rejected rather than silently ignored
- stale active entries should be re-reviewed and either kept active, replaced by
  a newer active entry, or rejected
- conflicting active entries are a defect in governance; resolve by keeping one
  active entry and rejecting or replacing the other
- proposed entries that overlap active memory should be treated as update
  candidates, not as parallel truths

Archive and task-memory boundaries:

- archived context is historical evidence and must not auto-promote to
  workspace memory
- task memory and evidence pins are current-run state and must not auto-promote
  to workspace memory
- repeated archive/task-memory evidence can justify a proposal, but activation
  still requires external review

Correct governance label: workspace memory is rare, reviewed, and high-trust
retrieved context. It is not a dumping ground for model summaries.

## Workspace Memory Lifecycle Governance

Workspace memory lifecycle is explicit and operator-governed. The model may
propose entries, but it must not decide durable memory truth by itself.

Lifecycle states:

- `proposed`: candidate workspace knowledge. It is excluded from default prompt
  injection and default search. It can be listed or searched only through review
  surfaces or explicit proposed-search options.
- `pending review request`: governance request over an existing memory entry.
  A request records the requested decision, requester, rationale, and target
  snapshot. It does not mutate memory status.
- `active`: reviewed workspace memory eligible for active-only search and prompt
  context. Active entries remain contextual data, not instruction authority.
- `rejected`: reviewed-out or obsolete memory. It is excluded from default
  search and prompt context. Re-activation requires a fresh review.
- `stale review request`: a pending request whose target changed before apply.
  It must not mutate memory. The operator should inspect the current entry and
  create a fresh request if the decision still applies.
- The local review CLI can list stale pending request candidates with
  `list-stale-requests`. This is a read-only preflight view; it does not mark
  requests stale and does not clean them up.

Proposal rules:

- Proposals should be rare and specific: durable constraints, recurring
  pitfalls, stable commands, file-specific notes, or verified project facts.
- Proposals must include concrete evidence. A model summary without code, test,
  command, log, or human-review backing is not enough.
- One-run observations should usually stay in task memory or eval notes rather
  than workspace memory.
- Proposed entries that duplicate active memory should become update/review
  candidates, not parallel truths.

Review request rules:

- Review requests are allowed only for existing entries.
- `request-review` is request-only: it may create or return a pending request,
  but it must not change memory status.
- Duplicate pending requests for the same `memoryId + decision` should return
  the existing request.
- Empty requester/rationale is invalid because review queues without attribution
  are not governance.

Apply/reject rules:

- Applying a review request requires an external authorization boundary. Current
  MCP/CLI apply paths use `COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN` as
  the local host/client gate.
- Applying `activate` calls the store review path and sets the memory entry to
  `active` with `humanVerified: true`.
- Applying `reject` calls the store review path and sets the memory entry to
  `rejected` with `humanVerified: false`.
- Rejecting a review request resolves only the request. It must not mutate the
  target memory entry.
- A stale request must be marked stale and must not mutate memory.

Conflict and cleanup rules:

- Conflicting active entries are a governance defect. Keep one active entry and
  reject or replace the other.
- Superseded active memory should be rejected with reviewer/rationale metadata,
  not left active with contradicting newer facts.
- Stale proposed memory should be rejected rather than silently accumulating.
- Cleanup is an explicit review action. There is no automatic TTL, decay,
  confidence demotion, or archive/task-memory promotion in the current design.

Tool-surface boundaries:

- Coding-runner xsai tools may search/read/propose workspace memory, but they
  must not activate or reject it.
- MCP review request/apply tools are external host/client surfaces, not model
  loop tools.
- The local CLI is an operator wrapper over the same JSONL stores; it is not a
  new source of truth and does not start an MCP server.
- `public: false`, hidden descriptors, or tool naming are not authorization
  boundaries. Real mutation still requires an explicit apply gate.

## Known Gaps

- Documentation drift: `archived-context/types.ts` and older docs still describe V1 as write-only/no retrieval, while current-run search/read now exist.
- Status drift: older archive status notes still describe blockers that have since been fixed in code/tests.
- Projection constants are duplicated between transcript projection, archive candidate generation, and runner runtime wiring.
- Operational trace projection and transcript projection are composed in `projectForCodingTurn()`, but budget ownership is not yet one explicit policy.
- Task memory injection is useful but still string-oriented; failure summaries and previous model text need stronger "runtime data, not instruction" labeling.
- Workspace memory is queried from the initial task goal; mid-run task redirection does not yet have a stronger retrieval strategy.
- Archive search is current-run substring matching only. This is acceptable for V1, but it is not a general memory retrieval system.
- Long tasks may still lose specific validation/edit/review evidence under projection pressure unless those evidence classes are explicitly pinned.
- Workspace memory lifecycle governance is now documented and has store/MCP/CLI
  surfaces, but no GUI review surface or automatic stale/conflict cleanup is
  implemented.

## Follow-Up Slices

### Slice 1: Projection Retention Contract

Goal: make transcript projection and archive candidate selection share an
explicit retention contract.

Include:

- shared retention helper/policy
- kept/compacted/dropped ranges
- `maxCompactedBlocks = 0` coverage
- no orphan tool messages
- compacted history never enters system

Do not include:

- token-accurate provider budgeting
- vector memory
- workspace memory promotion

### Slice 2: Coding Turn Context Budget Policy

Goal: give `projectForCodingTurn()` one explicit context policy for transcript,
operational trace, task memory, and workspace memory.

Include:

- projection metadata for each context source
- clear priority order
- deterministic pruning order

Do not include:

- LLM summarization
- new retrieval behavior
- long-term memory promotion

### Slice 3: In-Run Evidence Pins

Goal: keep critical recovery evidence available under context pressure.

Evidence candidates:

- recent failure reason
- last validation command/result
- latest edit proof summary
- review status
- budget pressure reason

Do not include:

- workspace memory writes
- cross-run memory
- planner rewrite

### Slice 4: Archive Recall Discipline

Goal: tighten current-run archive recall rules before expanding retrieval.

Include:

- bounded search results
- read only by artifact id
- historical/evidence labeling
- current-run-only guarantees

Do not include:

- broad prompt replay
- cross-run search
- vector search
- workspace memory promotion

### Slice 5: Workspace Memory Governance

Goal: implement tooling only after the promotion rules above prove sufficient in
manual/out-of-band review.

Include:

- external review surfaces for proposed entries
- explicit `proposed -> active/rejected` status updates
- conflict/stale review workflow
- audit trail for reviewer decisions

Do not include:

- automatic promotion
- GUI
- archive-to-workspace memory pipeline

## Non-Goals

- Do not implement new retrieval behavior in this audit.
- Do not change runner runtime semantics.
- Do not change MCP schemas.
- Do not change `CodingPrimitives`.
- Do not change `evaluateCodingVerificationGate()`.
- Do not change shell guard behavior.
- Do not add live eval scenarios.
- Do not add UI, CLI, chafa, desktop, or browser features.
- Do not call archived context long-term memory.
- Do not call workspace memory governance complete.
- Do not treat projected prompt context as a truth source.
