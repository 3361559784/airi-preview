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
- `src/planning-orchestration/reconciliation.ts`
- `src/planning-orchestration/reconciliation.test.ts`
- `src/planning-orchestration/lane-router.ts`
- `src/planning-orchestration/lane-router.test.ts`
- `src/planning-orchestration/route-projection.ts`
- `src/planning-orchestration/route-projection.test.ts`
- `src/planning-orchestration/workflow-handoff.ts`
- `src/planning-orchestration/workflow-handoff.test.ts`
- `src/planning-orchestration/workflow-mapping.ts`
- `src/planning-orchestration/workflow-mapping.test.ts`
- `src/coding-runner/transcript-runtime.ts`
- `src/coding-runner/transcript-runtime.test.ts`

The current contract defines:

- `PlanSpec`
- `PlanState`
- `PlanLane`
- `PlanReconcilerDecision`
- planning authority precedence
- planning guidance prompt label
- bounded plan-state projection shape
- deterministic plan evidence reconciliation
- deterministic plan lane routing classification
- bounded plan route summary projection shape
- deterministic plan route to workflow handoff shape
- deterministic plan handoff to workflow template mapping shape

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
contract. It is a pure function used by `projectForCodingTurn()` only when the
caller explicitly supplies both `planSpec` and `planState`.

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

## Coding Runner Context Integration

`projectForCodingTurn()` supports optional current-run plan projection:

- if both `planSpec` and `planState` are present, it injects the bounded
  projection block into the system context
- if `planRouting` is present, it injects the bounded route-summary projection
  block into the system context
- if either value is missing, projection metadata is recorded as `skipped`
- the plan block is inserted before route summaries, local Workspace Memory,
  plast-mem context, and TaskMemory
- route-summary projection metadata is tracked separately from plan state,
  Workspace Memory, plast-mem, TaskMemory, transcript, operational trace, and
  archive metadata

This is not automatic planning. No runner code generates `PlanSpec` or
`PlanState`, and no runner code generates route summaries unless a caller
explicitly supplies a routing result.

## Lane Routing Classification

`routePlanStep()` and `routePlanSpec()` define a deterministic routing
classification contract. They are pure functions and are not wired into runner
execution yet.

Inputs:

- `PlanSpecStep`
- the existing `ToolDescriptorRegistry` or equivalent descriptor lookup

The router maps `PlanSpecStep.lane + allowedTools` to descriptor metadata and
returns:

- `scope: current_run_plan_lane_routing`
- `status: routable | requires_approval | blocked`
- requested and routed tool names
- descriptor-derived approval reasons
- blocked reasons for unknown, non-public, empty, human-tool, or cross-lane
  tool requests
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

Plan lanes intentionally map onto descriptor lanes instead of duplicating MCP
registration logic:

- `coding`: `coding` tools plus explicit coding workflow entrypoints
- `desktop`: `desktop`, `display`, and `accessibility` tools, excluding
  legacy `terminal_*` tools
- `browser_dom`: only `browser_dom` tools
- `terminal`: `pty` tools plus legacy `terminal_exec` and
  `terminal_reset_state`
- `human`: no tools; always approval-required unless blocked for declaring
  tools

Routing is classification, not scheduling. A `routable` result only means the
step's declared tool surface is internally consistent. It does not select a
terminal surface, enqueue approval, invoke a tool, or mark evidence complete.

## Route Summary Projection

`projectPlanRouteSummaryForPrompt()` defines a bounded projection for
deterministic lane-router output. `projectForCodingTurn()` can inject this
projection only when the caller explicitly supplies `planRouting`.

The projection block must include:

- a route-summary trust label
- guidance-not-authority boundary lines
- a statement that routing classification never executes tools or satisfies
  completion proof
- authority metadata from `plan_state_reconciler_decision`
- route status summaries for blocked and approval-required steps
- bounded per-step route summaries with lane, route status, routed tools,
  approval reasons, and blocked reasons

The projection metadata is current-run only:

- `scope: current_run_plan_route_projection`
- included/character counts
- projected/omitted route counts
- projected/omitted blocked and approval-required step counts
- `authoritySource: plan_state_reconciler_decision`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

Route projection is still not execution. It may explain why a future step is
`routable`, `requires_approval`, or `blocked`, but it cannot schedule the step,
call tools, enqueue approval, or override verification gates.

## Workflow Handoff Contract

`buildPlanRouteWorkflowHandoff()` defines the first route-to-workflow handoff
shape. It consumes `PlanSpec` plus deterministic route classification and
returns a current-run handoff summary for future workflow mapping.

The handoff can classify steps as:

- `ready_for_mapping`
- `requires_approval`
- `blocked`

The handoff must include:

- `scope: current_run_plan_route_workflow_handoff`
- ready, approval-required, and blocked step ids
- per-step route status, candidate tool names, approval reasons, and blocked
  reasons
- consistency errors for missing, extra, or duplicate route rows
- `workflowMappingRequired: true` on each handoff step
- `mayExecute: false`
- `mayCreateWorkflowDefinition: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This contract intentionally does not build `WorkflowDefinition` or
`WorkflowStepTemplate` objects. `PlanSpecStep` has lane, intent, allowed tools,
and expected evidence, but it does not have executable workflow `params`.
Inventing params at this layer would turn routing into model guesswork.

## Workflow Mapping Contract

`mapPlanHandoffToWorkflowDefinition()` defines the first deterministic workflow
template creation boundary. It consumes a ready workflow handoff plus explicit
caller-provided mappings and returns either a `WorkflowDefinition` or blocked
mapping problems.

Mapping is allowed only when:

- the handoff status is `ready_for_mapping`
- every ready step has exactly one explicit mapping
- no mapping targets unknown, duplicate, approval-required, or blocked steps
- the mapped `WorkflowStepKind` is compatible with the step's routed candidate
  tool names
- the caller provides concrete workflow `params`

The mapping output must include:

- `scope: current_run_plan_workflow_mapping`
- `status: mapped | blocked`
- `workflow` only when every ready step is explicitly mapped
- `problems` for missing, unknown, duplicate, non-ready, or incompatible
  mappings
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This is still not workflow execution. The mapper may create a static
`WorkflowDefinition`, but it must not call `executeWorkflow`, enqueue approval,
dispatch lane tools, infer params from plan prose, or treat a mapped workflow as
completion proof.

## Evidence Reconciliation

`reconcilePlanEvidence()` defines the first current-run evidence reconciliation
contract. It is a pure function and is not wired into runner execution yet.

Inputs:

- `PlanSpec`
- `PlanState`
- explicit current-run evidence observations

Evidence observations are intentionally narrow:

- `stepId`
- `source`: `tool_result | verification_gate | human_approval`
- `status`: `satisfied | failed`
- `summary`
- optional tool or reason metadata

Matching is exact by `stepId + source`. The reconciler must not infer evidence
from natural language summaries, transcript text, memory entries, archive
recall, or plan completion claims.

Decision precedence is deterministic:

1. structurally inconsistent plan state -> `fail`
2. unknown current step or blockers -> `replan`
3. failed current-run evidence -> `replan`
4. current approval step missing human approval evidence -> `require_approval`
5. every non-skipped step completed with matched expected evidence ->
   `ready_for_final_verification`
6. otherwise -> `continue`

`ready_for_final_verification` still is not completion. It only means the plan
contract believes the expected current-run evidence is present. The verification
gate remains the completion authority.

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
- Reconciled plan evidence cannot satisfy the verification gate by itself.

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
- No automatic workflow definition creation.
- No automatic workflow execution.
- No runtime lane router execution.
- No MCP schema or tool-surface change.
- No automatic creation of `PlanSpec` or `PlanState`.
- No Workspace Memory write.
- No TaskMemory merge.
- No plast-mem export or ingestion.
- No desktop/browser/coding execution behavior change.
- No merge or rebase with upstream desktop/chrome-extension work.

## Future Slices

1. `feat(computer-use-mcp): execute mapped plan workflows explicitly`
   - Execute only caller-supplied mapped `WorkflowDefinition` values after
     approval and host/run boundary decisions are explicit.

2. `feat(computer-use-mcp): wire plan reconciliation into an explicit workflow`
   - Consume current-run observations only after workflow mapping and approval
     boundaries are explicit.
