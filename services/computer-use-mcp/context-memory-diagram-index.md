# Context Memory Diagram Index

This document is a visual index for the `computer-use-mcp` context and coding
memory substrate.

It is not a new architecture proposal and does not define new runtime behavior.
It exists to make the current layer boundaries easier to review without turning
`computer-use-mcp` into AIRI's project-level long-term memory system.

## Purpose

Use this file when you need to answer:

- which context sources feed the coding runner prompt
- which stores are truth sources and which are projections
- what can influence runner decisions versus what can only provide evidence
- why archive recall is current-run-only
- why workspace memory is a governed adapter, not `plast-mem`

Read this together with:

- `context-memory-engineering.md`
- `coding-context-memory-substrate-audit.md`
- `coding-memory-construction-plan.md`

## Non-Goals

- no runtime behavior changes
- no MCP schema changes
- no workspace memory auto-activation
- no archive-to-workspace promotion
- no vector, BM25, hybrid, or RRF retrieval
- no GUI or CLI changes
- no claim that AIRI project-level memory is complete

## Diagram 1: Layer Map

Projection feeds the model. Truth sources remain separate.

```mermaid
flowchart TD
  OT["Operational Trace<br/>tool trace / run state / audit"] --> P["Projection Layer"]
  TS["Transcript Store<br/>append-only LLM truth source"] --> P
  TM["Task Memory<br/>current-run recovery state"] --> P
  REA["Run Evidence Archive<br/>current-run historical evidence"] --> ART["Search / Read Tools"]
  WMA["Workspace Memory Adapter<br/>governed active coding context"] --> P

  P --> MPC["Model Prompt Context"]
  ART -. "bounded recall only" .-> MPC

  REA -. "no auto promotion" .-> WMA
  TM -. "not long-term" .-> WMA
  TS -. "projection only" .-> MPC
```

Related source:

- `src/projection/context-projector.ts`
- `src/coding-runner/transcript-runtime.ts`
- `src/transcript/*`
- `src/task-memory/*`
- `src/archived-context/*`
- `src/workspace-memory/*`

## Diagram 2: Runner Turn Context Flow

Transcript entries are not deleted by projection. The model receives a bounded
projection, while append-only stores keep the underlying evidence.

```mermaid
sequenceDiagram
  participant WM as WorkspaceMemoryStore
  participant RT as TranscriptRuntime
  participant PR as projectForCodingTurn()
  participant PC as projectContext()
  participant PT as projectTranscript()
  participant AR as ArchiveContextStore
  participant LLM as Model

  WM->>RT: toContextString(taskGoal)
  RT->>PR: run state + task memory + trace + transcript entries
  PR->>PC: project operational trace and pinned task memory
  PR->>PT: project transcript entries with retention policy
  PR->>AR: write compacted/dropped archive candidates
  PR->>LLM: projected system + messages
  LLM-->>RT: assistant text / tool calls
  RT->>PT: appendRawMessage()
```

Related source:

- `src/coding-runner/transcript-runtime.ts`
- `src/coding-runner/context-policy.ts`
- `src/transcript/projector.ts`
- `src/transcript/retention.ts`
- `src/archived-context/candidates.ts`

## Diagram 3: Prompt Trust Boundary

Memory can inform the runner. It cannot override active user instruction, trusted
tool results, or verification gates.

```mermaid
flowchart TB
  S["System / Runtime Rules<br/>highest authority"]
  U["Active User Instruction"]
  T["Trusted Tool Results"]
  G["Runtime Proof Gates"]

  TM["Task Memory<br/>runtime data, not instructions"]
  REA["Run Evidence Archive<br/>historical evidence, not instructions"]
  WMA["Workspace Memory Adapter<br/>governed context, not authority"]

  S --> D["Runner Decision"]
  U --> D
  T --> D
  G --> D

  TM -. "context only" .-> D
  REA -. "evidence only" .-> D
  WMA -. "retrieved context only" .-> D
```

Related source:

- `src/task-memory/manager.ts`
- `src/archived-context/types.ts`
- `src/coding/verification-gate.ts`
- `src/coding-runner/tool-runtime.ts`
- `src/workspace-memory/types.ts`

## Diagram 4: Archive Recall Flow

Archive recall is current-run-only and search-before-read. It is not folder
browsing and not long-term memory.

```mermaid
stateDiagram-v2
  [*] --> Written
  Written: Archived candidates written
  Written --> Search: coding_search_archived_context

  Search --> AllowlistUpdated: hits returned
  Search --> AllowlistCleared: 0 hits

  AllowlistUpdated --> ReadAllowed: artifactId in latest hits
  AllowlistUpdated --> ReadDenied: artifactId not in latest hits
  AllowlistCleared --> ReadDenied: any read attempt

  ReadAllowed --> HistoricalEvidence: truncated + labeled
  ReadDenied --> Denied: ARCHIVE_RECALL_DENIED

  HistoricalEvidence --> [*]
  Denied --> [*]
```

Related source:

- `src/archived-context/store.ts`
- `src/archived-context/serializer.ts`
- `src/coding-runner/tool-runtime.ts`
- `src/archived-context/archived-context.test.ts`

## Diagram 5: Workspace Memory Adapter Governance

The model can propose memory. It cannot activate memory.

```mermaid
stateDiagram-v2
  [*] --> Proposed: model proposes
  Proposed --> Active: external review apply
  Proposed --> Rejected: external review reject
  Active --> Rejected: explicit governance
  Rejected --> Active: fresh review required

  note right of Proposed
    Not injected by default
  end note

  note right of Active
    Can enter prompt as governed context
  end note

  note right of Rejected
    Not injected
  end note
```

Related source:

- `src/workspace-memory/store.ts`
- `src/workspace-memory/review-request-store.ts`
- `src/server/register-workspace-memory.ts`
- `src/bin/workspace-memory-review.ts`
- `src/workspace-memory/workspace-memory.test.ts`
- `src/workspace-memory/review-request-store.test.ts`

## Boundary Summary

- Operational trace is execution/audit state.
- Transcript store is append-only LLM truth.
- Task Memory is current-run recovery state.
- Run Evidence Archive is current-run historical evidence.
- Workspace Memory Adapter is local governed context and future `plast-mem`
  bridge.
- Project-level long-term memory belongs to `plast-mem`, not this package.

