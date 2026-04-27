# Coding Provider Eval Observations

Last reviewed: 2026-04-27

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

## Recommended Follow-Up Slices

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

Do not change runtime behavior from the current DeepSeek observation alone.

The next engineering move should be:

```text
test(computer-use-mcp): cover coding provider cwd recovery noise
```

That keeps the coding line moving toward product stability without smuggling a
provider-specific workaround into the runner.
