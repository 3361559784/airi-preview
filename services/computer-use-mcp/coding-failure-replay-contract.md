# Coding Failure Replay Contract

This document defines the failure replay contract for the coding runner in
`services/computer-use-mcp`.

Failure replay is coding execution memory. It is not runtime recovery,
provider-specific workaround logic, project-level memory, or `plast-mem`
integration.

## Purpose

Live provider failures are evidence. They should become deterministic
classification and replay coverage before changing runner behavior.

The replay path answers:

- what failed
- which known failure class it maps to
- whether it is a provider observation, deterministic replay task, or runtime
  follow-up
- which follow-up name and deterministic anchor should be used

It must not decide runtime completion, verification, tool access, memory
promotion, or prompt authority.

## Pipeline

Inputs:

- coding runner result
- coding runner events
- transcript tool rows from eval reports
- optional source metadata: label, provider, model, log path

Normalization:

- `normalizeCodingLiveFailureReplay()` converts a runner result and optional
  events into a bounded replay row.
- It preserves tool order, tool names, statuses, summaries, errors, terminal cwd
  evidence, and latest verification gate evidence.
- It may truncate long previews for row size.
- It must not mutate input result, turn, event, or source objects.

Classification:

- `classifyCodingLiveFailureText()` maps bounded evidence text into a known
  `CodingLiveFailureClass`.
- Classification is eval follow-up routing only.
- Provider/source metadata can be preserved, but it must not be classification
  authority.
- Unknown failures must remain explicit and map to deterministic replay first.

Summary:

- `buildCodingEvalReplayRow()` adapts live MCP eval output into replay rows.
- Completed runner results do not produce failure rows.
- `summarizeCodingEvalReplayRows()` produces stable follow-up entries for
  failed rows only.

## Required Behaviors

- Same input produces the same replay row.
- Normalization is pure and read-only over its input.
- Tool history ordering is preserved.
- `effectiveCwd` and `terminalState.effectiveCwd` remain separate evidence
  fields.
- Latest `verification_gate_evaluated` event wins.
- Completed results produce no failure row in eval replay reports.
- Unknown failure rows map to:
  `test(computer-use-mcp): add deterministic replay for unmapped coding live failure`.
- Provider capacity and latency rows stay `provider_observation_only` unless a
  non-provider runner failure body proves otherwise.

## Boundaries

Replay rows must not enter:

- Task Memory
- Run Evidence Archive
- Workspace Memory Adapter
- prompt context
- completion or verification gate logic

Replay must not add:

- provider-specific runtime branches
- new memory fields
- archive recall behavior
- workspace memory promotion
- `plast-mem` integration

Absolute paths may remain in replay evidence because path shape can be the
failure signal. Do not anonymize paths unless a concrete leak risk is being
handled in a separate security slice.

## When To Add A Failure Class

Add a new class only when there is concrete live evidence and the existing
classes would route the follow-up incorrectly.

Do not add speculative categories just because they sound plausible.

For a new class, add:

- a corpus entry in `live-failure-corpus.ts`
- a classifier test
- a deterministic anchor or a clear test follow-up
- eval replay summary coverage when the failure can appear through eval reports

## Related Code

- `src/coding-runner/live-failure-corpus.ts`
- `src/coding-runner/live-failure-replay.ts`
- `src/bin/coding-eval-replay.ts`
- `src/bin/coding-eval-report.ts`

Related navigation docs:

- `coding-memory-construction-plan.md`
- `coding-agent-code-index.md`
- `context-memory-diagram-index.md`
