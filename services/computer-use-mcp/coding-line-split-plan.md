# Coding Line Split Plan

## Purpose

This document defines how to split the current `computer-use-mcp` coding line into reviewable stacked branches.

It is a **salvage plan**, not a history-preservation plan.

The current branch already mixes:

- coding domain logic
- workflow/runtime glue
- server registration changes
- soak/e2e scaffolding
- unrelated desktop/browser commits

Because of that, the split must be driven by **final file state and dependency boundaries**, not by preserving the existing commit graph.

## Ground Rules

1. Treat the current dirty coding branch as a **salvage source only**.
2. Do **not** use interactive rebase to extract the stack.
3. Rebuild each branch from `main` using path-based restore of the final file state.
4. Keep each PR aligned to a real review boundary:
   - pure logic first
   - runtime substrate next
   - tool surface after that
   - workflow glue later
   - e2e/soak last
5. Do **not** mix `projection` into the main coding stack yet.
6. Do **not** invent a separate “task-memory PR”. The current diff only changes `task-memory/merge.ts`; there is no standalone task-memory subsystem worth presenting as its own architecture layer.

## Why Not Rebase Extraction

The current branch is too dirty for history surgery to be worth it:

- it is far ahead of `main`
- it changes hundreds of files across multiple problem domains
- the current `projection` commit is contaminated by unrelated desktop/browser files
- several large files like `src/coding/primitives.ts` and `src/server/register-tools.ts` already dominate review cost on their own

Trying to preserve the existing commit history would optimize for archaeology instead of reviewability.

## Why Projection Is Deferred

`src/projection/*` should not go into the main coding stack yet.

Current reasons:

1. the projector still assumes transcript-style trace events that are not yet aligned with the real operational session trace schema
2. it is not yet ready to wire into the runner without first settling the input contract
3. the current projection commit is contaminated by unrelated files

Projection should be treated as a separate future line:

- `design(computer-use-mcp): define projection source contract from real session trace`
- later `feat(computer-use-mcp): add pre-request context projection and runtime pruning`

## Recommended Stack

### S1. Domain Core

**Goal:** Land pure coding domain models and reasoning helpers with no runtime or server glue.

**Branch:** `codex/coding-s1-domain-core`

**Include:**

- `services/computer-use-mcp/src/coding/result-shape.ts`
- `services/computer-use-mcp/src/coding/target-case.ts`
- `services/computer-use-mcp/src/coding/target-case.test.ts`
- `services/computer-use-mcp/src/coding/diagnosis-case.ts`
- `services/computer-use-mcp/src/coding/diagnosis-case.test.ts`
- `services/computer-use-mcp/src/coding/judgement-schema.ts`
- `services/computer-use-mcp/src/coding/coding-memory-taxonomy.ts`
- `services/computer-use-mcp/src/coding/coding-memory-taxonomy.test.ts`
- `services/computer-use-mcp/src/coding/causal-trace.ts`
- `services/computer-use-mcp/src/coding/causal-trace.test.ts`
- `services/computer-use-mcp/src/coding/planner-graph.ts`
- `services/computer-use-mcp/src/coding/planner-graph.test.ts`

**Do not include:**

- server registration
- runtime state
- workflow glue
- e2e/smoke harness

### S2. Search and Verification Core

**Goal:** Land read/search/guard/verification logic that still does not require the full workflow runner.

**Branch:** `codex/coding-s2-search-verification-core`

**Include:**

- `services/computer-use-mcp/src/coding/search.ts`
- `services/computer-use-mcp/src/coding/search.test.ts`
- `services/computer-use-mcp/src/coding/retrieval.ts`
- `services/computer-use-mcp/src/coding/retrieval.test.ts`
- `services/computer-use-mcp/src/coding/shell-command-guard.ts`
- `services/computer-use-mcp/src/coding/shell-command-guard.test.ts`
- `services/computer-use-mcp/src/coding/verification-gate.ts`
- `services/computer-use-mcp/src/coding/verification-gate.test.ts`
- `services/computer-use-mcp/src/coding/verification-nudge.ts`
- `services/computer-use-mcp/src/coding/verification-nudge.test.ts`
- `services/computer-use-mcp/src/verification-contracts/index.ts`
- `services/computer-use-mcp/src/verification-contracts/index.test.ts`
- `services/computer-use-mcp/src/verification-evidence.ts`

**Do not include:**

- `register-tools.ts`
- workflow runner files
- e2e/soak

### S3. Runtime Substrate

**Goal:** Introduce the state/facts/verification substrate the coding lane actually runs on.

**Branch:** `codex/coding-s3-runtime-substrate`

**Include:**

- `services/computer-use-mcp/src/state.ts`
- `services/computer-use-mcp/src/types.ts`
- `services/computer-use-mcp/src/transparency.ts`
- `services/computer-use-mcp/src/strategy.ts`
- `services/computer-use-mcp/src/server/runtime-facts.ts`
- `services/computer-use-mcp/src/server/runtime-facts.test.ts`
- `services/computer-use-mcp/src/server/runtime-coordinator.ts`
- `services/computer-use-mcp/src/server/runtime-coordinator.test.ts`
- `services/computer-use-mcp/src/server/verification-evidence-capture.ts`
- `services/computer-use-mcp/src/server/verification-evidence-capture.test.ts`
- `services/computer-use-mcp/src/server/verification-runner.ts`
- `services/computer-use-mcp/src/server/verification-runner.test.ts`
- `services/computer-use-mcp/src/task-memory/merge.ts`

**Notes:**

- This is the right place for new runtime facts and verification capture plumbing.
- It is not the right place for MCP tool registration or workflow orchestration.

### S4. Tool Surface

**Goal:** Land the coding MCP tool surface and registration seam in isolation.

**Branch:** `codex/coding-s4-tool-surface`

**Include:**

- `services/computer-use-mcp/src/coding/primitives.ts`
- `services/computer-use-mcp/src/coding/primitives.test.ts`
- `services/computer-use-mcp/src/server/register-coding.ts`
- `services/computer-use-mcp/src/server/register-coding.test.ts`
- `services/computer-use-mcp/src/server/tool-descriptors/coding.ts`
- `services/computer-use-mcp/src/server/tool-descriptors/task-memory.ts`
- the minimum supporting changes required in `services/computer-use-mcp/src/server/runtime.ts`

**Why isolated:**

- `primitives.ts` is too large to hide inside a broader PR
- this layer is the first place where reviewer attention shifts from domain logic to exposed tool behavior

### S5. Workflow Loop

**Goal:** Wire the coding substrate and tool surface into the actual runner/workflow path.

**Branch:** `codex/coding-s5-workflow-loop`

**Include:**

- `services/computer-use-mcp/src/workflows/coding-loop.ts`
- `services/computer-use-mcp/src/workflows/coding-agentic-loop.ts`
- `services/computer-use-mcp/src/workflows/prep-tools.ts`
- `services/computer-use-mcp/src/workflows/prep-tools.test.ts`
- `services/computer-use-mcp/src/workflows/engine.ts`
- `services/computer-use-mcp/src/workflows/engine.test.ts`
- `services/computer-use-mcp/src/workflows/index.ts`
- `services/computer-use-mcp/src/workflows/types.ts`
- `services/computer-use-mcp/src/server/register-tools.ts`
- `services/computer-use-mcp/src/server/register-tools-coding-workflow.test.ts`
- `services/computer-use-mcp/src/server/runtime.ts`

**Notes:**

- This layer should come only after the substrate and tool surface are already reviewable.
- Reviewers should be able to read this layer as “how the pieces are wired”, not “what every piece means”.

### S6. E2E and Soak

**Goal:** Land the scripted governor/e2e/smoke harness only after product code is already in place.

**Branch:** `codex/coding-s6-e2e-soak`

**Include:**

- `services/computer-use-mcp/src/bin/e2e-coding-governor-xsai-soak.ts`
- `services/computer-use-mcp/src/bin/e2e-coding-governor-xsai-soak.test.ts`
- `services/computer-use-mcp/src/bin/e2e-coding-*.ts`
- `services/computer-use-mcp/src/server/workflow-coding-*.test.ts`
- `services/computer-use-mcp/src/server/smoke-coding-*.test.ts`

**Why last:**

- e2e and soak code amplifies review noise
- it should validate the stack, not define the stack

## What Does Not Belong In This Stack

Do not mix these into the coding stack rebuild:

- `services/computer-use-mcp/src/projection/*`
- desktop/browser bridge work
- stage-tamagotchi files
- `AGENTS.md`
- unrelated root/docs cleanup

If a path restore for one layer drags in any of the above, the branch is already dirty and should be reset before review.

## Extraction Method

Use path-based restore from the dirty branch into fresh stacked branches.

Example for S1:

```bash
git switch main
git switch -c codex/coding-s1-domain-core
git restore --source=codex/cu-mcp-s10-tool-lane-hygiene -- \
  services/computer-use-mcp/src/coding/result-shape.ts \
  services/computer-use-mcp/src/coding/target-case.ts \
  services/computer-use-mcp/src/coding/target-case.test.ts \
  services/computer-use-mcp/src/coding/diagnosis-case.ts \
  services/computer-use-mcp/src/coding/diagnosis-case.test.ts \
  services/computer-use-mcp/src/coding/judgement-schema.ts \
  services/computer-use-mcp/src/coding/coding-memory-taxonomy.ts \
  services/computer-use-mcp/src/coding/coding-memory-taxonomy.test.ts \
  services/computer-use-mcp/src/coding/causal-trace.ts \
  services/computer-use-mcp/src/coding/causal-trace.test.ts \
  services/computer-use-mcp/src/coding/planner-graph.ts \
  services/computer-use-mcp/src/coding/planner-graph.test.ts
```

Then:

1. run only the tests relevant to S1
2. commit S1
3. branch S2 from S1
4. restore only S2 paths
5. repeat

## Review Strategy

Each PR should answer only one kind of reviewer question.

- S1: “Are these domain models and taxonomies coherent?”
- S2: “Are the search/guard/verification rules sound?”
- S3: “Is the runtime substrate/state model correct?”
- S4: “Do the coding tools expose the right surface?”
- S5: “Does the workflow runner wire the pieces correctly?”
- S6: “Do the soak/e2e harnesses meaningfully validate the stack?”
        
If a PR forces reviewers to answer two of those at the same time, it is split incorrectly.

## Immediate Recommendation

Do not touch Git history on the current dirty branch.

Use that branch only as a source of final file state.

The next concrete move, when implementation starts, should be:

1. open a fresh worktree from `main`
2. build `codex/coding-s1-domain-core`
3. validate that branch in isolation
4. only then stack S2 on top

That is the least risky path to turn the current coding line into something reviewers can actually process.
