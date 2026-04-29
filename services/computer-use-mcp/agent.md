# computer-use-mcp Current Handoff Notes

Scope: `services/computer-use-mcp/**`

This file is a current workstream handoff snapshot and package-local operating
guide. It is not a global AIRI rule file and should not be copied into the
monorepo root as a blanket instruction.

Do not treat this file as the only truth source. Before relying on any
current-status claim here, verify against implementation, tests,
`src/support-matrix.ts`, and package scripts.

## Mission

`computer-use-mcp` is AIRI's deterministic execution substrate.

- AIRI owns planning, chat UX, approval UX, provider integration, and MCP attachment.
- `computer-use-mcp` owns execution primitives, workflow orchestration, terminal/browser/desktop surfaces, trace, audit, and safety checks.
- Treat terminal, browser, editor, and desktop operations as one task system. Do not split them into disconnected demos.

## Architectural Center

Do not let this package drift into a "tool system with some execution attached".

The architectural center of `computer-use-mcp` should be:

1. runtime facts
2. lane contracts
3. action cycle correctness
4. verification / repair / audit

Tool descriptors, tool directory/search, and coding-line retrieval are useful,
but they are support layers. They are not the system center.

If a future design choice looks more like "Claude Code shape adoption" than
"stronger observe -> decide -> act -> verify -> repair behavior", treat that as
a warning sign and justify it explicitly.

## AI Worker Dispatch Policy

This policy is local to `services/computer-use-mcp/**`. Do not copy it into
global Codex config or unrelated AIRI workstreams without an explicit decision.

Use GPT-5.5 as the controller. It owns scope, final judgment, code edits,
verification choices, and whether a finding is real. External AI workers are
allowed to be used aggressively, but they are evidence-gathering and review
workers, not authorities.

Default worker posture:

- Use Spark subagents aggressively for fast read-only repo exploration, test
  discovery, and diff review.
- Use Copilot CLI aggressively for external read-only plan/review passes.
- Use Copilot GPT-5 mini and GPT-4.1 aggressively for high-frequency low-risk
  scans, sanity checks, alternate test ideas, and cheap second opinions.
- Use Copilot `gpt-5.3-codex` with `xhigh` effort for harder code review,
  implementation reasoning, or candidate patch review. Prefer `xhigh` over
  `high` when asking Copilot to judge subtle runtime or memory-governance diffs.
- If model names change, preserve the role split: cheap/fast worker for triage,
  stronger coding model for hard review, GPT-5.5 as final controller.
- Use Gemini CLI for broad context review, independent risk checks, and
  second-opinion architecture/readability passes. Prefer Gemini 3 Pro for
  default Gemini review sessions. If the Gemini 3 family exposes Gemini 3.1 Pro
  in the current CLI/account, select it before deep reviews.
- If Gemini quota or latency is bad, fall back to Copilot workers.

Session discipline:

- Prefer reusable background/interactive sessions for repeated Copilot or Gemini
  reviews in the same workstream. Do not reflexively open one-shot sessions and
  throw them away when a persistent session can keep useful review context.
- For Copilot, use named/resumable plan-mode sessions for longer reviews, for
  example `gh copilot --model gpt-5.3-codex --effort xhigh --mode plan
  --name computer-use-mcp-review`. Resume with `--resume` / `--continue` when
  continuing the same review thread.
- For quick Copilot one-shots, `-p` is fine, but treat the result as disposable.
  Prefer `gpt-5-mini` or `gpt-4.1` for cheap checks and `gpt-5.3-codex xhigh`
  for hard review.
- For Gemini, start read-only review sessions with plan approval, for example
  `gemini --approval-mode plan --skip-trust -i "<prompt>"`. Set the model at
  startup with `--model` when the exact model name is known, or use `/model` in
  the interactive session to select Gemini 3 Pro / Gemini 3.1 Pro when
  available. Resume with `gemini --resume latest` or a specific session id.
- If Codex captures an interactive worker as a running terminal session, keep
  the session id and send follow-up prompts to that session instead of spawning a
  new worker. If the command was run with non-interactive `-p` and exits, it is
  not reusable; use the tool's resume feature or start a new named session.

Recommended dispatch:

- Before a non-trivial implementation: ask one Spark explorer to map local code
  paths and one Copilot cheap worker to look for obvious missing tests.
- Before finalizing a risky diff: ask Spark or Copilot for a focused diff review.
- For larger context/memory/runtime-policy changes: run at least one external
  second opinion from Copilot or Gemini unless local tests already expose the
  answer clearly.
- For tiny, mechanically obvious edits: do not force external workers just to
  perform ceremony.

Hard boundaries:

- Workers default to read-only. Do not let external workers write files unless
  the user explicitly asks for that worker to implement.
- Do not send secrets, API keys, cookies, or private credentials to external
  tools.
- Do not trust worker output over repository facts, typecheck, tests, logs, or
  direct diffs.
- Do not let worker suggestions expand scope. Unsupported claims are discarded.
- Do not mix `.codex`, Copilot/Gemini governance, labels, runtime code, and test
  changes in one commit unless the user explicitly asks for a snapshot commit.

## Current Status Snapshot

Last reviewed: 2026-04-28
Workstream: terminal-lane-v2

If this date is old, treat this section as stale until revalidated against code,
tests, package scripts, and `src/support-matrix.ts`.

Updated for the current terminal-lane-v2 workstream.

The important truth is:

- `exec` is already a real mainline surface.
- `PTY` is no longer just a loose tool set; the workflow engine now has self-acquire support.
- The service-layer terminal E2Es are green.
- The AIRI chat terminal demo is now aligned with terminal lane v2 and no longer pre-creates PTY.
- The desktop shell now distinguishes `pty_session` from `terminal_and_apps`.
- AIRI chat self-acquire is now part of the strict release gate set, so PTY mainline support is no longer intentionally held back.

Do not rely on compressed chat summaries to resume this work. Use this file as
the current handoff index and update it when terminal-lane behavior changes
materially.

## Coding Line Closeout Snapshot

Last reviewed: 2026-04-29
Workstream: coding-line-product-stability

This section is the current handoff memory for the coding line. It is repo-local
documentation, not Codex long-term memory and not a product claim.

Current branch baseline:

```text
codex/coding-line-complete-local
Remote target: 3361559784/airi-preview
Latest pushed commits:
  bd8f1d851 fix(computer-use-mcp): suppress completed eval failure rows
  41ad81a07 fix(coding-runner): constrain validation recovery to workspace cwd
  84807ca6a test(computer-use-mcp): classify coding eval outside-workspace validation detours
```

Current status:

- Treat the coding line as a usable internal baseline for handoff, not as a
  long-term-validated product-grade coding agent.
- The latest DeepSeek default baseline completed the real runner loop:
  search/read, patch, terminal validation, and `coding_report_status`.
- The latest observed runner result was `completed` with `totalSteps=12`.
- `workflow_coding_agentic_loop` can still fail in the deterministic scaffold;
  that is not the transcript runner baseline.
- We do not currently have enough local budget to prove long-run stability with
  broad repeated live soaks. Do not overstate this baseline to reviewers.
- If future resources are available, validate breadth before adding features.

Recent stabilized contracts:

- Text-only final is not accepted as completion; the runner allows only one
  bounded report-only correction.
- Archive recall is current-run-only, search-before-read, latest-search-only,
  bounded, and labeled as historical evidence.
- Analysis/report archive denial has a bounded finalization recovery path
  without weakening archive recall discipline.
- Task memory is labeled as runtime data, not executable instructions or system
  authority.
- Context assembly has an explicit coding-turn policy for trace and transcript
  retention.
- Terminal validation cwd is constrained to the active coding workspace in the
  runner tool adapter, and bounded verification recheck uses the run workspace
  instead of baseline temp worktree cwd.
- Live eval replay reports now classify known failures and do not emit failure
  rows for completed runs.

Current memory status:

- Task Memory: closed for this baseline. It is current-run state with evidence
  pins, recent failure recovery, budget pressure, and a prompt trust label. Do
  not expand `evidencePins` semantics unless a new live failure maps directly
  there.
- Archive Memory: closed for this baseline. It is a current-run historical
  evidence cache, not long-term memory and not instruction authority. Do not
  add auto-promotion from archive into workspace memory.
- Workspace Memory Adapter: local governance substrate and review CLI exist, but
  this is not AIRI's project-level long-term memory system. Project memory
  belongs to `plast-mem`; this package should keep workspace-memory-like context
  as a governed coding adapter boundary. MCP request/apply flows and the CLI are
  operator-governed surfaces; GUI review, automatic stale/conflict cleanup, and
  any `plast-mem` bridge remain follow-up work.

Memory construction source:

- `coding-memory-construction-plan.md` defines the current coding memory
  construction order and the boundary between coding execution memory and
  project-level `plast-mem` memory.
- `context-memory-diagram-index.md` is the visual index for the same layers:
  operational trace, transcript, task memory, run evidence archive, and
  workspace memory adapter.
- `coding-agent-code-index.md` is the agent-facing code navigation index for
  those layers: concept-to-file map, call graph, invariants, test map, and
  failure routing.
- `coding-failure-replay-contract.md` defines how live coding failures become
  deterministic replay/classification evidence before runtime fixes.

What this baseline currently proves:

- Existing-file edit loop can read/search, patch, validate, and report
  completion with DeepSeek.
- Analysis/report has deterministic coverage for report-only completion and
  archive-denial finalization recovery.
- Shell misuse and missing mutation proof have bounded recovery contracts in
  tests and previous live observations, but they should be revalidated before
  claiming broad provider stability.
- The eval replay layer can preserve failure evidence and map known failure
  classes without treating successful runs as unknown failures.

Primary code map:

- Runner control:
  - `src/coding-runner/service.ts`
  - `src/coding-runner/transcript-runtime.ts`
  - `src/coding-runner/context-policy.ts`
  - `src/coding-runner/tool-runtime.ts`
- Guardrails and proof:
  - `src/coding/primitives.ts`
  - `src/coding/verification-gate.ts`
  - `src/coding/shell-command-guard.ts`
  - `src/state.ts`
- Task/context memory:
  - `src/task-memory/`
  - `src/transcript/retention.ts`
  - `src/transcript/projector.ts`
  - `src/archived-context/`
  - `src/workspace-memory/`
- Eval entrypoints:
  - `src/bin/evaluate-coding-entries.ts`
  - `src/bin/e2e-coding-governor-xsai-soak.ts`
- Main regression tests:
  - `src/coding-runner/coding-runner.test.ts`
  - `src/coding/verification-gate.test.ts`
  - `src/bin/e2e-coding-governor-xsai-soak.test.ts`
  - `src/archived-context/archived-context.test.ts`
  - `src/workspace-memory/workspace-memory.test.ts`

Resume procedure:

1. Run `git status --short` and `git log -5 --oneline`.
2. Read this file and `coding-provider-eval-observations.md`.
3. If there is no new repeated failure, do not change runner runtime.
4. If there is a failure, classify it before opening a narrow follow-up.
5. Verify with targeted tests first, then package typecheck/full test only after
   the narrow change is stable.

Failure class map:

- `TEXT_ONLY_FINAL`: report-only correction state machine.
- `verification_bad_faith` or report-only analysis blocked: report-only
  verification evidence path.
- `ARCHIVE_RECALL_DENIED` in analysis/report: analysis/report archive
  finalization correction. Do not weaken archive latest-search-only discipline.
- Shell misuse: shell guard plus patch recovery. Do not add shell fallback tools.
- Missing mutation proof: auto proof recovery and mutation proof/readback path.
- `TOOL_ADHERENCE_VIOLATION` in soak: check scenario tool-surface contract and
  guidance first; do not treat unavailable-tool requests as pass.

Stop rules:

- Do not touch archive, workspace memory, task memory, or context policy unless
  the failure maps there.
- Do not expand `evidencePins` semantics to carry more product behavior.
- Do not change runner runtime only because the current matrix is green and a
  broader soak feels desirable.
- Do not mix Chika CLI handoff, provider eval docs, and runtime/test fixes in
  one commit.

## Terminal Lane v2: What Is Already Landed

### 1. Terminal surface model exists

Terminal-capable workflow steps now have explicit terminal semantics instead of pure guesswork:

- `mode: 'exec' | 'auto' | 'pty'`
- `interaction: 'one_shot' | 'persistent'`

The main implementation lives in:

- `src/workflows/types.ts`
- `src/workflows/surface-resolver.ts`
- `src/terminal/interactive-patterns.ts`

### 2. Auto surface resolution is fixed to a small rule set

`auto` is intentionally narrow. It only upgrades to PTY when one of these is true:

1. The current `taskId + stepId` already has a bound PTY session.
2. The step explicitly declares `interaction: 'persistent'`.
3. The command matches `KNOWN_INTERACTIVE_COMMAND_PATTERNS`.
4. A failed/timed-out exec attempt surfaces one of `INTERACTIVE_OUTPUT_MARKERS`.

This rule set is covered by:

- `src/workflows/surface-resolver.test.ts`
- `src/terminal/interactive-patterns.test.ts`

### 3. Workflow engine can self-acquire PTY

The engine already contains the v2 shape:

- `AcquirePtyForStep`
- `StepTerminalProgress`
- suspension point `before_pty_acquire`
- PTY step family support:
  - `pty_send_input`
  - `pty_read_screen`
  - `pty_wait_for_output`
  - `pty_destroy_session`

The main implementation lives in:

- `src/workflows/engine.ts`

The intended behavior is:

- workflow resolves the terminal surface
- if PTY is needed, workflow acquires/binds PTY itself
- workflow continues inside the same workflow
- outward terminal reroute is now secondary, not the mainline proof

### 4. Service-layer PTY self-acquire E2E exists and is green

The current real terminal E2E for v2 is:

- `src/bin/e2e-terminal-self-acquire.ts`

This script now proves:

- **no pre-created PTY**
- workflow detects an interactive command
- engine self-acquires PTY
- command executes on PTY
- step succeeds without outward reroute
- run-state / binding / audit stay consistent

It currently uses:

- `workflow_validate_workspace`
- an interactive `checkCommand` of `vim --version`

This is the current service-level proof for terminal lane v2.

### 5. AIRI chat self-acquire demo is now on the v2 path

`src/bin/e2e-airi-chat-terminal-self-acquire.ts` follows the same product story:

- no harness-side `pty_create`
- AIRI calls the real workflow
- the workflow self-acquires PTY for the interactive validation step
- AIRI finishes with a natural-language summary for demo use

The latest successful reports live under:

- `.computer-use-mcp/reports/airi-chat-terminal-self-acquire-*`

The current package commands are:

- `pnpm -F @proj-airi/computer-use-mcp e2e:airi-chat-terminal-self-acquire`
- `pnpm -F @proj-airi/computer-use-mcp demo:terminal-self-acquire`

### 6. Support matrix already reflects the new direction

Relevant entries in `src/support-matrix.ts`:

- `terminal_exec` → `product-supported`
- `terminal_pty` → `product-supported`
- `terminal_exec_to_pty_reroute` → `covered` and explicitly labeled legacy fallback
- `terminal_auto_surface_resolution` → `covered`
- `terminal_pty_self_acquire` → `product-supported`
- `terminal_pty_step_family` → `covered`

The current strict release gates are:

- `pnpm -F @proj-airi/computer-use-mcp e2e:developer-workflow`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-exec`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-pty`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-self-acquire`
- `pnpm -F @proj-airi/computer-use-mcp e2e:airi-chat-terminal-self-acquire`

## What Is Still Not Finished

These are the real gaps. Do not talk yourself into thinking terminal lane is fully shipped before they are closed.

### 1. Desktop approval semantics are improved, but still need one more explicit review

`apps/stage-tamagotchi/src/renderer/App.vue` now distinguishes:

- `terminal_and_apps`
- `pty_session`

and it no longer pretends a PTY approval is the same thing as a generic terminal/app grant.

The current intended behavior is:

- `terminal_exec` / `open_app` / `focus_app` keep the old session-scoped auto-approve behavior
- `pty_create` stores a `pty_session` grant scope
- `pty_create` does **not** auto-approve future PTY creation requests

This is much closer to the product model, but it is still worth reviewing whenever approval UX changes again.

## Where To Look First

If you are continuing terminal lane work, read these first:

1. `src/workflows/engine.ts`
2. `src/workflows/surface-resolver.ts`
3. `src/terminal/interactive-patterns.ts`
4. `src/bin/e2e-terminal-self-acquire.ts`
5. `src/bin/e2e-airi-chat-terminal-self-acquire.ts`
6. `src/support-matrix.ts`
7. `apps/stage-tamagotchi/src/renderer/App.vue`
8. `apps/stage-tamagotchi/src/renderer/modules/computer-use-approval.ts`

That set is enough to reconstruct the current terminal-lane-v2 state without rereading the entire repo.

## Validation Commands

Use these as the baseline checks for terminal lane work:

### Service-level terminal lane

- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-exec`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-pty`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-self-acquire`
- `pnpm -F @proj-airi/computer-use-mcp e2e:airi-chat-terminal-self-acquire`

### Core test coverage

- `pnpm -F @proj-airi/computer-use-mcp exec vitest run --config ./vitest.config.ts`

### Typecheck

- `pnpm -F @proj-airi/computer-use-mcp typecheck`
- `pnpm -F @proj-airi/stage-ui typecheck`

If `pnpm -F @proj-airi/stage-tamagotchi typecheck` behaves oddly in the current environment, run the two underlying commands directly:

- `pnpm -F @proj-airi/stage-tamagotchi run typecheck:node`
- `pnpm -F @proj-airi/stage-tamagotchi run typecheck:web`

## Handoff Rules

If you change terminal lane behavior, update this file before stopping.

At minimum, always rewrite these four facts:

1. Is PTY self-acquire the mainline, or does any path still depend on pre-created PTY?
2. Is AIRI chat E2E aligned with the service-level terminal lane, or still on an older path?
3. Is desktop approval using real `pty_session` semantics, or still old `terminal_and_apps` semantics?
4. Which terminal capabilities are `product-supported` vs only `covered` in `src/support-matrix.ts`?

If those four facts are stale, the next agent will lose time re-deriving context from code.

## Boundary Reminder

- Keep provider-specific behavior in AIRI / `packages/stage-ui/**`.
- Keep OS-executor and workflow orchestration logic here.
- Do not expand this workstream into browser, native click/type/press, or VS Code productization until terminal lane is actually closed.
