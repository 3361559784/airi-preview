---
name: multi-agent
description: Coordinate local Spark subagents, GitHub Copilot CLI, and Gemini CLI for parallel code exploration, review, test-gap scouting, and low-risk helper work while keeping GPT-5.5 as final controller.
---

# Multi-Agent Dispatch

Use this skill when the user asks to use multiple agents, Copilot, Gemini, Spark,
external reviewers, worker pools, or parallel AI help on this repo.

## Controller Rule

- GPT-5.5 remains the controller.
- The controller owns scope, patch decisions, verification commands, conflict
  resolution, final judgment, commit, and push.
- Spark, Copilot, and Gemini are workers. Treat their output as evidence, not
  authority.
- Repository facts, diffs, typecheck, tests, logs, and direct code inspection
  override every worker opinion.

## Default Dispatch

- Use Spark aggressively for fast read-only local repo work:
  code maps, call paths, test discovery, risk scans, and focused diff review.
- Use Copilot GPT-5 mini or GPT-4.1 aggressively for cheap high-frequency work:
  simple test-gap scouting, boilerplate checks, alternate wording, low-risk
  review, and quick sanity passes.
- Use Copilot `gpt-5.3-codex` with `xhigh` effort for hard code review,
  runtime/state-machine review, memory-governance review, concurrency concerns,
  or subtle test-contract checks. Prefer `xhigh` over `high`.
- Use Gemini for broad context review and independent architecture/readability
  checks. Prefer Gemini 3 Pro; when the Gemini 3 family exposes Gemini 3.1 Pro
  in the current account/session, switch to Gemini 3.1 Pro before deep reviews.
- If Gemini is slow, unavailable, or quota-constrained, fall back to Copilot.

## Session Discipline

- Prefer reusable background or interactive worker sessions for repeated review
  in the same workstream.
- Do not reflexively run one-shot prompts and throw away context when a
  persistent session is useful.
- If the terminal tool returns a running session id for Copilot or Gemini, keep
  that session id and send follow-up prompts with stdin instead of spawning a new
  worker.
- A non-interactive `-p` command exits after completion. Treat that result as
  disposable; use the tool's resume feature or start a named session when the
  conversation should continue.

## Copilot CLI Patterns

Use the cheapest useful model for routine work:

```bash
gh copilot --model gpt-5-mini --effort high --mode plan -p "<prompt>"
gh copilot --model gpt-4.1 --effort high --mode plan -p "<prompt>"
```

Use strong Copilot for hard review:

```bash
gh copilot --model gpt-5.3-codex --effort xhigh --mode plan -p "<prompt>"
```

For reusable sessions:

```bash
gh copilot --model gpt-5.3-codex --effort xhigh --mode plan --name computer-use-mcp-review
gh copilot --resume computer-use-mcp-review
gh copilot --continue
```

If the `gh` wrapper rejects Copilot flags, insert `--` before Copilot flags:

```bash
gh copilot -- --model gpt-5.3-codex --effort xhigh --mode plan
```

## Gemini CLI Patterns

Use read-only plan mode by default:

```bash
gemini --approval-mode plan --skip-trust -i "<prompt>"
```

Select the model at startup when the exact model id is known:

```bash
gemini --approval-mode plan --skip-trust --model "<gemini-3-pro-model-id>" -i "<prompt>"
```

For interactive sessions, use `/model` first to select Gemini 3 Pro, or Gemini
3.1 Pro when available. Resume instead of restarting when continuing the same
review:

```bash
gemini --resume latest
gemini --resume <session-id>
```

## Spark Patterns

- Use `spark_explorer` for local code maps, call paths, implementation risks,
  and focused subsystem questions.
- Use `spark_test_finder` for missing tests and narrow regression coverage.
- Use `spark_diff_reviewer` for current diff review before finalizing.
- Split questions so workers do not duplicate each other.
- Keep Spark tasks read-only unless the user explicitly requests worker edits.

## When To Use Multiple Workers

- Before non-trivial implementation: run one Spark explorer for code shape and
  one Copilot cheap worker for missing-test ideas.
- Before risky runtime/state/memory changes: run Spark diff review and Copilot
  `gpt-5.3-codex xhigh`.
- For broad design or architecture uncertainty: ask Gemini for an independent
  plan/risk review after local repo facts are gathered.
- For tiny mechanical edits: do not use workers just for ceremony.

## Worker Write Policy

- Default to read-only workers.
- If the user explicitly allows worker edits, assign one narrow, disjoint write
  scope per worker.
- Do not let workers commit, push, rebase, reset, or clean the worktree.
- The controller must inspect worker diffs before adoption.
- Do not let worker suggestions expand the scope without fresh evidence.

## Standard Worker Prompts

Focused diff review:

```text
Read-only review. Do not edit files or run broad commands.
Review this diff for blockers against the stated contract.
Return concrete blockers only, or NO_BLOCKERS.
Focus on: behavior regressions, missing tests, unsafe assumptions, stale state,
security boundary mistakes, and schema/API drift.
```

Test-gap scout:

```text
Read-only test-gap scout. Identify the smallest missing regression tests for
this change. Do not propose broad test suites. Return file/test names and the
specific behavior each test should lock.
```

Low-risk helper implementation:

```text
You are not alone in the codebase. Edit only the assigned files. Do not revert
or reformat unrelated changes. Do not commit. List changed files and explain the
contract each change satisfies.
```

## Hard Boundaries

- Do not send secrets, API keys, tokens, cookies, or private credentials to
  external tools.
- Do not treat Copilot/Gemini/Spark output as proof.
- Do not mix worker-governance docs, runtime code, tests, labels, and `.codex`
  changes in one commit unless explicitly requested.
- Do not keep waiting on workers if the main task can make progress locally.
- Do not delegate the immediate blocking critical-path task when doing it
  locally is faster and safer.

## Closeout

When workers were used, report:

- which workers/models were used
- whether they were read-only or write-scoped
- concrete findings adopted
- concrete findings rejected
- tests and commands that remain the final proof
