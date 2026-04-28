# Coding Provider Eval Observations

Last reviewed: 2026-04-28

This document records live-provider observations for the coding runner. It is a
handoff note, not a runtime contract and not a claim that the coding line is
production-complete.

Use it to decide the next small stability slice after the current context,
archive, task-memory, and workspace-memory governance work.

## Scope

This note covers live `workflow_coding_runner` behavior observed through
`src/bin/evaluate-coding-entries.ts`.

It does not define:

- new MCP tool behavior
- new verification-gate rules
- new workspace memory behavior
- new archive recall behavior
- provider-specific prompt policy

## Latest DeepSeek Live Matrix

Last matrix update: 2026-04-28

The governor soak was refreshed on 2026-04-28 with five runs per scenario.
The analysis/report, shell misuse recovery, and auto proof recovery entries
below remain from the 2026-04-27 matrix run.

Provider settings:

```text
AIRI_AGENT_BASE_URL=https://api.deepseek.com/v1
AIRI_AGENT_MODEL=deepseek-chat
```

API keys are local environment data. Do not print them in logs, prompts, or
reports.

### Commands

Use the local environment source appropriate for the machine, then export
`AIRI_AGENT_API_KEY`. The commands below intentionally use the same script entry
points as the live matrix; they do not require runtime code changes.

Analysis/report:

```bash
AIRI_AGENT_MODEL=deepseek-chat \
AIRI_AGENT_BASE_URL=https://api.deepseek.com/v1 \
AIRI_EVAL_INCLUDE_ANALYSIS_REPORT=1 \
pnpm -F @proj-airi/computer-use-mcp exec tsx ./src/bin/evaluate-coding-entries.ts
```

Shell misuse recovery:

```bash
AIRI_AGENT_MODEL=deepseek-chat \
AIRI_AGENT_BASE_URL=https://api.deepseek.com/v1 \
AIRI_EVAL_INCLUDE_SHELL_MISUSE=1 \
pnpm -F @proj-airi/computer-use-mcp exec tsx ./src/bin/evaluate-coding-entries.ts
```

Auto proof recovery:

```bash
AIRI_AGENT_MODEL=deepseek-chat \
AIRI_AGENT_BASE_URL=https://api.deepseek.com/v1 \
AIRI_EVAL_INCLUDE_AUTO_PROOF_RECOVERY=1 \
pnpm -F @proj-airi/computer-use-mcp exec tsx ./src/bin/evaluate-coding-entries.ts
```

Governor soak, five runs per scenario:

```bash
AIRI_AGENT_MODEL=deepseek-chat \
AIRI_AGENT_BASE_URL=https://api.deepseek.com/v1 \
AIRI_SOAK_SCENARIO=all \
AIRI_SOAK_RUNS=5 \
AIRI_SOAK_MAX_STEPS=15 \
AIRI_SOAK_STEP_TIMEOUT_MS=30000 \
pnpm -F @proj-airi/computer-use-mcp exec tsx ./src/bin/e2e-coding-governor-xsai-soak.ts
```

### Results

The latest matrix passed:

```text
analysis/report: PASS
  codingRunner.status: completed
  codingRunner.totalSteps: 8
  analysisReportRunner.status: completed
  analysisReportRunner.totalSteps: 6

shell misuse recovery: PASS
  shellMisuseScenarioStatus: passed
  shellMisuseGuardDenied: true
  shellMisuseGuardCode: dangerous_file_mutation
  shellMisusePatchAfterDenial: true
  shellMisuseValidationAfterDenial: true
  shellMisusePostCheck.ok: true

auto proof recovery: PASS
  autoProofRecoveryScenarioStatus: passed
  autoProofRecoveryReportDenied: true
  autoProofRecoveryDenialKind: missing_mutation_proof
  autoProofRecoveryPatchAfterDenial: true
  autoProofRecoveryReadAfterDenial: true
  autoProofRecoveryReviewAfterDenial: true
  autoProofRecoveryValidationAfterDenial: true
  autoProofRecoveryPostCheck.ok: true

governor soak all, runs=5: PASS
  existing-file: 5/5 passed
  fake-completion: 5/5 passed
  stalled-read: 5/5 passed
  stalled-search: 5/5 passed
  toolAdherenceViolation: none
  requestedUnavailableTool: none
```

Trace locations from the latest run:

```text
/tmp/airi-coding-live-analysis-report-20260427-181401.log
/tmp/airi-coding-live-shell-misuse-20260427-181554.log
/tmp/airi-coding-live-auto-proof-20260427-181657.log
/tmp/airi-coding-live-governor-all-r5-20260428-185039.log
services/computer-use-mcp/.computer-use-mcp/reports/soak/2026-04-28T10-50-40-588Z.jsonl
```

### Failure Mapping

- `analysisReportRunner.status !== "completed"` means the analysis/report path
  regressed. Map it to report-only evidence, verification gate, or archive
  finalization before changing prompts.
- `shellMisuseScenarioStatus === "failed"` means shell guard recovery regressed.
  Inspect `shellMisuseGuardCode`, `shellMisusePatchAfterDenial`, and
  `shellMisuseValidationAfterDenial`.
- `shellMisuseScenarioStatus === "not_exercised"` is inconclusive, not a
  runtime failure. The model used the safe path directly.
- `autoProofRecoveryScenarioStatus === "failed"` means completion-denial
  recovery regressed. Inspect `autoProofRecoveryDenialKind`,
  `autoProofRecoveryPatchAfterDenial`, `autoProofRecoveryReadAfterDenial`,
  `autoProofRecoveryReviewAfterDenial`, and
  `autoProofRecoveryValidationAfterDenial`.
- Governor soak failure is scenario-specific. Map `existing-file` to patch
  mismatch recovery, `fake-completion` to completion denial, and
  `stalled-read` / `stalled-search` to analysis governor cutoff behavior.

## Confirmed Observations

The latest DeepSeek run used:

```text
AIRI_AGENT_BASE_URL=https://api.deepseek.com/v1
AIRI_AGENT_MODEL=deepseek-chat
AIRI_EVAL_INCLUDE_AUTO_PROOF_RECOVERY=1
```

The run completed the normal coding-runner scenario and the auto filesTouched
completion-denial recovery scenario.

The auto-proof recovery report showed:

```text
autoProofRecoveryScenarioStatus: passed
autoProofRecoveryReportDenied: true
autoProofRecoveryDenialKind: missing_mutation_proof
autoProofRecoveryPatchAfterDenial: true
autoProofRecoveryReadAfterDenial: true
autoProofRecoveryReviewAfterDenial: true
autoProofRecoveryValidationAfterDenial: true
autoProofRecoveryPostCheck.ok: true
```

That means the core recovery path worked in this live run:

1. a premature completion report was denied
2. the runner continued
3. a real patch happened
4. read/review/validation evidence appeared
5. final completion was accepted

## Provider / Tooling Noise Seen

The same run also showed terminal and lane-summary noise that should be treated
as provider/eval observations before changing runtime behavior.

### Lane advisory noise

Tool summaries can include advisory text like:

```text
You are currently in the "coding" lane but called "terminal_exec" which belongs
to the "desktop" lane.
```

and:

```text
You are currently in the "desktop" lane but called "coding_read_file" which
belongs to the "coding" lane.
```

These advisories did not break the run, but they are prompt-visible text and can
compete with task evidence during recovery.

Current interpretation:

- observed prompt noise
- not yet proven to be a runner bug
- not enough by itself to justify changing lane contracts

### Terminal cwd presentation noise

Observed terminal tool results can contain two different cwd-related facts:

```text
backend.effectiveCwd: /var/folders/.../xsai-governor-eval-...
backend.terminalState.effectiveCwd: /Users/liuziheng/airi
```

In the successful baseline run, `terminal_exec` without an explicit `cwd`
executed `node check.js` in the fixture workspace and passed. That means the
normal terminal execution path was not simply broken.

In the auto-proof recovery run, the model also attempted:

```text
terminal_exec({ command: "cat index.ts", cwd: "/Users/liuziheng/airi" })
```

which failed with:

```text
cat: index.ts: No such file or directory
```

The model recovered by listing the fixture directory, reading the absolute file
path, and running:

```text
cd /var/folders/.../xsai-governor-eval-... && node check.js
```

Current interpretation:

- the provider/model can be distracted by cwd state shown in terminal output
- the backend can still execute correctly when the command is scoped correctly
- this is a fixture/eval stability concern before it is a product runtime bug

### Readback / terminal fallback noise

One live run included a `coding_read_file` result summarized as unchanged content
for `index.ts`, after which the model used terminal `cat` to inspect the file.

Current interpretation:

- useful as a recovery observation
- not enough to claim `coding_read_file` is incorrect
- should be fixture-tested before changing readback behavior

## Non-Conclusions

Do not infer these from the current observations:

- DeepSeek is unsupported.
- terminal execution cwd is globally broken.
- lane advisory text must be removed immediately.
- `coding_read_file` is unreliable.
- auto-proof recovery is production-grade.
- more task-memory or workspace-memory semantics are needed.

The live run is evidence that the current coding runner can recover under this
provider. It is also evidence that prompt-visible tool summaries still contain
noise that can cause detours.

## Historical Follow-Up Slices

### Slice 1: Fixture provider-noise observation

Suggested title:

```text
test(computer-use-mcp): cover coding provider cwd recovery noise
```

Goal:

- turn the observed cwd/lane-advisory detour into a deterministic fixture
- prove whether the runner should care about `terminalState.effectiveCwd` in
  tool summaries
- keep this as test/eval coverage first

Non-goals:

- no lane contract rewrite
- no provider-specific prompt branch
- no workspace-memory change
- no archive recall change

### Slice 2: Terminal summary noise reduction

Suggested title:

```text
fix(coding-runner): reduce terminal lane advisory prompt noise
```

Only do this after Slice 1 proves the summary noise is reproducible and harmful.

Candidate changes:

- keep backend facts in structured content
- make advisory text shorter or less prominent in coding-runner prompt-visible
  summaries
- distinguish command execution cwd from terminal session remembered cwd

Non-goals:

- no hiding execution failures
- no removing audit facts
- no weakening shell guard or permission boundaries

### Slice 3: Provider eval corpus metadata

Suggested title:

```text
docs(computer-use-mcp): track coding provider eval corpus
```

Goal:

- record provider, model, enabled eval flags, status, and key failure/noise
  observations for live evals
- keep live eval observations separate from runtime truth-source docs

Non-goals:

- no pass/fail marketing table
- no provider ranking
- no production-readiness claim

## Current Recommendation

Do not change runtime behavior from the current DeepSeek matrix alone.

The current product-stability signal is healthy enough to freeze this baseline.
If more evidence is needed, increase soak breadth first instead of changing
runner logic:

```text
AIRI_SOAK_SCENARIO=all AIRI_SOAK_RUNS=3
```

Only open a runtime follow-up when a repeated live failure maps to a specific
failure class above.
