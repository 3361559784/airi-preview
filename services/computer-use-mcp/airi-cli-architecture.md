# AIRI Coding CLI + Chafa Architecture (Draft)

## Purpose

Define a narrow, reviewable architecture for a terminal-facing AIRI coding CLI that can optionally render an animated avatar via `chafa`, without polluting `computer-use-mcp` core runtime.

This document is intentionally focused on **boundaries and contracts**, not full implementation.

## Decisions (Confirmed 2026-04-26)

1. CLI location: `packages/airi-cli`
2. First integration channel: `runner in-process callback`
3. `stdin JSONL` remains a follow-up adapter for fixture replay and tooling interop.

## Evidence Baseline (Current Code)

From the current `computer-use-mcp` codebase:

- `src/coding-runner/types.ts` exposes `runCodingTask(params): Promise<CodingRunnerResult>`.
- `src/coding-runner/service.ts` accumulates `turns` and returns one aggregated result at the end.
- `src/bin/coding-runner.ts` prints final JSON after execution.

Implication:

- A stable external event stream contract for CLI rendering is not yet formalized.
- Building terminal animation first would be presentation-only illusion unless the runner emits reliable run/step/tool/result status.

## Hard Boundaries

1. `chafa` is **presentation layer only**, not agent runtime.
2. `services/computer-use-mcp` core runner must remain headless-safe and CI-safe.
3. CLI consumes runner state/events; CLI does not own agent planning/runtime logic.
4. `chafa` must be optional (`--avatar=chafa` / `--avatar=none` / `--no-avatar`).
5. Missing `chafa` binary must degrade to plain text rendering, not fail run execution.

## Proposed Location Split

- Core runtime: `services/computer-use-mcp/src/coding-runner`
- CLI package (new): `packages/airi-cli`
- Chafa adapter: `packages/airi-cli/src/renderers/chafa-avatar.ts`
- Text renderer: `packages/airi-cli/src/renderers/text.ts`
- Shared CLI event types: `packages/airi-cli/src/contracts/runner-events.ts`

## Runner Event Contract (v0 Draft)

Use an append-only event envelope. First transport is `in-process callback`; JSONL is an adapter layer.

```ts
interface RunnerEventEnvelope<TKind extends string = string, TPayload = unknown> {
  runId: string
  seq: number // strictly increasing per run
  at: string // ISO timestamp
  kind: TKind
  payload: TPayload
}
```

### Event Kinds (Minimum for CLI)

1. `run_started`
2. `preflight_started`
3. `preflight_completed`
4. `step_started`
5. `tool_call_started`
6. `tool_call_completed`
7. `assistant_message`
8. `step_timeout`
9. `report_status` (from `coding_report_status`)
10. `run_finished`
11. `run_crashed`

### Required Payload Fields (Minimum)

- `run_started`: `workspacePath`, `taskGoal`, `maxSteps`, `stepTimeoutMs`
- `step_started`: `stepIndex`, `maxSteps`
- `tool_call_started`: `toolName`, `argsSummary`
- `tool_call_completed`: `toolName`, `ok`, `status`, `summary`, `error?`
- `assistant_message`: `text`
- `report_status`: `status` (`completed|failed|blocked`), `summary?`
- `run_finished`: `finalStatus`, `totalSteps`, `error?`

## CLI Architecture

`airi-cli` should have three separable layers:

1. **Input Adapter**
   - Reads `RunnerEventEnvelope` stream (stdin JSONL / in-process adapter).

2. **State Reducer**
   - Builds deterministic `CliViewState` from events.
   - No terminal I/O in reducer (pure function, easy tests).

3. **Renderer Adapter**
   - `TextRenderer` (default, always available)
   - `ChafaAvatarRenderer` (optional capability)

## Chafa Adapter Design

`ChafaAvatarRenderer` should:

- Probe `chafa` binary availability at startup.
- Select rendering source (sprite sheet / GIF / PNG sequence).
- Convert frame(s) to ANSI safely.
- Support frame pacing independent of runner event rate.
- Auto-fallback to text-only if:
  - `chafa` missing
  - non-TTY output
  - explicit `--avatar=none` or `--no-avatar`

## CLI Flags (Initial)

- `--avatar=chafa|none`
- `--no-avatar` (alias for `--avatar=none`)
- `--events=runner|stdin|jsonl-file`
- `--output=pretty|jsonl`

## Test Strategy

1. Contract tests for event schema and ordering (`seq` monotonic).
2. Reducer tests from fixture JSONL streams.
3. Text renderer snapshot tests (deterministic output sections).
4. Chafa adapter tests with mocked process/binary probing.
5. CI default path runs text mode only; no `chafa` required.

## Delivery Stages

### Stage 1: Contract + Doc

- Finalize `RunnerEventEnvelope` kinds/payload minimum.
- Add fixture JSONL examples for run success/fail/timeout.

### Stage 2: Minimal CLI (Text)

- Build `airi-cli` skeleton.
- Consume runner callback events and render run/step/tool/error/final summary.

### Stage 2.5: JSONL Adapter

- Add stdin/jsonl adapter for replay, fixture-driven tests, and offline demos.

### Stage 3: Optional Chafa Adapter

- Add `chafa` renderer with capability probe and fallback.
- Keep CI and headless execution chafa-free.

## Acceptance Criteria

1. No `chafa` dependency added to `services/computer-use-mcp` runtime.
2. CLI works when `chafa` is not installed.
3. CI does not require `chafa`.
4. Event reducer is testable with mocked streams.
5. Terminal output gracefully degrades to plain text.

## Review Checklist (for PR Review)

Use this checklist to keep reviews narrow and evidence-based:

1. **Layering check**
   - No `chafa` dependency introduced under `services/computer-use-mcp/**`.
   - CLI changes remain under `packages/airi-cli/**` (or explicitly justified exceptions).

2. **Runtime purity check**
   - Runner core remains headless/CI-safe.
   - No terminal-rendering assumptions added to runner runtime behavior.

3. **Contract check**
   - Event `seq` is monotonic within a run.
   - Required event payload fields are present and typed.
   - Failure/timeout paths emit deterministic terminal events.

4. **Fallback check**
   - Missing `chafa` binary does not fail CLI execution.
   - Non-TTY mode degrades to text/JSONL output.

5. **Scope check**
   - PR does not mix coding memory/runner substrate refactors with CLI rendering features.
   - Desktop/browser lane changes are excluded from this CLI line.

## PR Scope Guardrails

For this line, reject or split any PR that simultaneously modifies:

- `services/computer-use-mcp/src/coding-runner/**` runtime semantics, and
- `packages/airi-cli/**` rendering adapters/UX behavior.

If both are needed, split into:

1. contract/runtime PR (no UI rendering behavior), then
2. CLI renderer PR (consumes already-landed contract).

## Out of Scope (for this line)

- Full long-term memory promotion/governance.
- Desktop/browser runtime refactors.
- Rewriting runner logic for animation-first UX.

## Suggested Follow-up PR Naming

- `feat(cli): define coding runner event contract`
- `feat(cli): scaffold airi-coding-cli text renderer`
- `feat(cli): add optional terminal AIRI avatar renderer with chafa`
