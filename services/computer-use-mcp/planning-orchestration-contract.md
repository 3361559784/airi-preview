# Planning Orchestration Contract

## Purpose

This document defines the first contract for a future Planning Orchestration
Layer in `computer-use-mcp`.

It is not a runtime planner implementation. It does not execute lanes, call a
model, mutate memory, or register MCP tools. The goal is to fix the authority
boundary before any cross-lane planner is introduced.

## Existing Boundaries

Current repo facts:

- `WorkflowDefinition` is a static workflow template and execution path.
- `coding_plan_changes` is coding-lane internal DAG/session planning.
- `TaskMemory` is current-run recovery data, not plan authority.
- Workspace Memory and plast-mem context are reviewed context, not completion
  authority.

The Planning Orchestration Layer is a future layer above individual lanes:

```text
AIRI Host / User Goal
  -> Planning Orchestration Layer
  -> Lane Router
  -> coding / desktop / browser_dom / terminal / human lanes
  -> tool evidence and runtime trace
  -> Plan Reconciler
  -> Verification Gate / Human Approval
  -> Final Result
```

## Contract Surface

The tested contract lives in:

- `src/planning-orchestration/contract.ts`
- `src/planning-orchestration/contract.test.ts`
- `src/planning-orchestration/projection.ts`
- `src/planning-orchestration/projection.test.ts`

The current contract defines:

- `PlanSpec`
- `PlanState`
- `PlanLane`
- `PlanReconcilerDecision`
- planning authority precedence
- planning guidance prompt label
- bounded plan-state projection shape

## PlanSpec

`PlanSpec` describes intended current-run work.

Each step includes:

- `id`
- `lane`: `coding | desktop | browser_dom | terminal | human`
- `intent`
- `allowedTools`
- `expectedEvidence`
- `riskLevel`
- `approvalRequired`

Without `allowedTools` and `expectedEvidence`, a plan is only prose. The future
router and reconciler must treat those fields as constraints, not decoration.

## PlanState

`PlanState` is current-run runtime state.

It may record:

- current step id
- completed steps
- failed steps
- skipped steps
- evidence references
- blockers
- last replan reason

It must not be written to Workspace Memory, plast-mem, or Run Evidence Archive
by this contract. Future projection may show a bounded plan-state summary, but
only as runtime guidance.

## Plan State Projection

`projectPlanStateForPrompt()` defines the first model-visible projection
contract. It is a pure function. It is not wired into `coding-runner` yet.

The projection block must include:

- the planning trust label
- guidance-not-authority boundary lines
- projection status: `active | blocked | stale | superseded`
- current goal and current step
- bounded step summaries with lane, status, risk, approval flag, allowed tools,
  and expected evidence
- bounded evidence references
- bounded blockers
- source metadata stating that plan projection cannot satisfy verification gate
  or mutation proof

The projection metadata is current-run only:

- `scope: current_run_plan_projection`
- included/character counts
- projected/omitted counts for steps, evidence refs, and blockers
- `authoritySource: plan_state_reconciler_decision`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

Blocked, stale, and superseded plans are still visible as runtime guidance, but
their state does not become failure proof or completion proof. Tool evidence and
verification gates remain the authority.

## Trust Label

Any model-visible plan block must start with:

```text
Current execution plan (runtime guidance, not authority):
```

It must also state:

- this is current-run guidance
- it is not executable instructions or system authority
- it never overrides active user instructions, approval/safety policy, trusted
  tool evidence, or verification gates
- plan completion claims require trusted evidence before final verification

## Authority Order

Lower entries are weaker:

1. runtime/system rules
2. active user instruction
3. approval/safety policy
4. verification gate decision
5. trusted current-run tool evidence
6. plan state / reconciler decision
7. current-run TaskMemory
8. current-run Archive recall
9. active local Workspace Memory
10. plast-mem retrieved context

Consequences:

- A plan can guide next actions.
- A plan cannot mark work complete by itself.
- A plan cannot satisfy mutation proof.
- A plan cannot override tool results.
- A plan cannot bypass approval or verification gates.
- A stale or superseded plan cannot delete or override current-run evidence.

## Reconciler Contract

Future `PlanReconciler` decisions are limited to:

- `continue`
- `replan`
- `require_approval`
- `fail`
- `ready_for_final_verification`

`ready_for_final_verification` is not completion. The verification gate still
decides whether the run can report success.

## Non-Goals

- No automatic planner model call.
- No automatic lane execution.
- No lane router implementation.
- No MCP schema or tool-surface change.
- No coding-runner prompt injection change.
- No plan-state projection wired into runtime prompt assembly yet.
- No Workspace Memory write.
- No TaskMemory merge.
- No plast-mem export or ingestion.
- No desktop/browser/coding runtime behavior change.
- No merge or rebase with upstream desktop/chrome-extension work.

## Future Slices

1. `feat(computer-use-mcp): add current-run plan state projection`
   - Inject plan guidance only after the projection contract is tested.

2. `test(computer-use-mcp): define plan evidence reconciliation contract`
   - Map expected evidence to current-run tool evidence and verification gate
     decisions.

3. `feat(computer-use-mcp): route plan steps across lanes`
   - Add deterministic routing only after projection and reconciliation are
     stable.
