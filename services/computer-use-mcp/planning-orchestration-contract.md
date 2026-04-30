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
- `src/planning-orchestration/workflow-execution.ts`
- `src/planning-orchestration/workflow-execution.test.ts`
- `src/planning-orchestration/workflow-session.ts`
- `src/planning-orchestration/workflow-session.test.ts`
- `src/planning-orchestration/session-replay.ts`
- `src/planning-orchestration/session-replay.test.ts`
- `src/planning-orchestration/workflow-evidence.ts`
- `src/planning-orchestration/workflow-evidence.test.ts`
- `src/planning-orchestration/workflow-reconciliation.ts`
- `src/planning-orchestration/workflow-reconciliation.test.ts`
- `src/planning-orchestration/state-transition.ts`
- `src/planning-orchestration/state-transition.test.ts`
- `src/planning-orchestration/host-entrypoint.ts`
- `src/planning-orchestration/host-entrypoint.test.ts`
- `src/planning-orchestration/state-apply.ts`
- `src/planning-orchestration/state-apply.test.ts`
- `src/planning-orchestration/host-runtime.ts`
- `src/planning-orchestration/host-runtime.test.ts`
- `src/planning-orchestration/host-runtime-state.ts`
- `src/planning-orchestration/host-runtime-state.test.ts`
- `src/planning-orchestration/host-workflow-caller.ts`
- `src/planning-orchestration/host-workflow-caller.test.ts`
- `src/planning-orchestration/runtime-recovery.ts`
- `src/planning-orchestration/runtime-recovery.test.ts`
- `src/planning-orchestration/runtime-replan.ts`
- `src/planning-orchestration/runtime-replan.test.ts`
- `src/planning-orchestration/runtime-session.ts`
- `src/planning-orchestration/runtime-session.test.ts`
- `src/planning-orchestration/session-projection.ts`
- `src/planning-orchestration/session-projection.test.ts`
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
- explicit mapped workflow execution boundary
- explicit mapped workflow execution to host session boundary
- deterministic workflow execution to plan evidence observation bridge
- explicit workflow execution reconciliation summary
- deterministic plan state transition proposal shape
- host-owned transition proposal review entrypoint
- returned-copy plan state transition apply result
- host-owned current-run transition boundary
- host-owned in-memory plan state holder
- explicit host workflow reconciliation caller
- bounded plan runtime recovery and replan request
- host-supplied replacement plan acceptance boundary
- host-owned current-run plan runtime session boundary
- bounded plan runtime session projection shape
- deterministic plan session recovery replay shape

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

## Workflow Execution Boundary

`executeMappedPlanWorkflow()` is the first explicit planning-to-workflow runtime
wiring point. It accepts only a mapped `PlanWorkflowMappingResult` and delegates
to the existing `executeWorkflow()` engine.

Execution is allowed only when:

- mapping status is `mapped`
- a `WorkflowDefinition` is present
- the workflow has at least one step

The execution result must include:

- `scope: current_run_plan_workflow_execution`
- `status: completed | failed | paused | reroute_required | blocked`
- `executed: true` only after `executeWorkflow()` is called
- blocked problems for unmapped, missing, or empty workflows
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This boundary does not add an MCP tool and does not make the planner an
authority. It uses the existing workflow engine, action executor, approval
suspension, PTY acquisition, reroute, and formatter contracts. `autoApproveSteps`
defaults to `false`; callers must opt in explicitly if they own a higher-level
approval boundary.

## Workflow Evidence Observation Bridge

`buildPlanEvidenceObservationsFromWorkflowExecution()` defines the first
workflow-result-to-plan-evidence bridge. It consumes a mapped workflow result
and a mapped workflow execution result, then emits current-run
`PlanEvidenceObservation` rows for the reconciler.

The bridge is allowed to emit only:

- `source: tool_result`
- `status: satisfied | failed`
- original plan step ids from `PlanWorkflowMappingResult.mappedSteps`
- workflow step status, explanation, and tool metadata

It must not emit:

- `verification_gate` evidence
- `human_approval` evidence
- mutation proof
- completion proof
- Workspace Memory, Archive, TaskMemory, or plast-mem export records

This keeps workflow execution below the verification gate. A successful mapped
workflow can make a plan ready for final verification only when the plan
expected `tool_result` evidence; it still cannot satisfy final verification by
itself.

## Workflow Reconciliation Summary

`reconcilePlanWorkflowExecution()` defines the first explicit reconciliation
summary for mapped workflow execution. It combines:

- `PlanSpec`
- optional current-run `PlanState`
- `PlanWorkflowMappingResult`
- `PlanWorkflowExecutionResult`
- workflow-derived `tool_result` observations

When `PlanState` is omitted, reconciliation is skipped and the result records
`skippedReason: missing_plan_state`. This keeps the tool useful for execution
without pretending it owns plan state. When workflow execution did not run,
reconciliation is also skipped.

When `PlanState` is supplied and workflow execution produced step results, the
summary delegates to `reconcilePlanEvidence()`. The output remains current-run
metadata:

- `scope: current_run_plan_workflow_reconciliation`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This summary can say a plan is ready for final verification. It still cannot
mark the coding runner completed, satisfy mutation proof, or bypass
`coding_report_status`.

## Plan State Transition Proposal

`derivePlanStateTransitionProposal()` converts a reconciliation result into a
host-readable proposal for current-run plan state changes.

Proposal kinds are:

- `advance_step`
- `mark_failed`
- `require_approval`
- `replan`
- `ready_for_final_verification`
- `noop`

The output may include proposed operations such as `append_completed_step`,
`set_current_step`, `append_failed_step`, or `append_blocker`, but those
operations are descriptive only. This contract does not mutate `PlanState`.

Every transition proposal must include:

- `scope: current_run_plan_state_transition_proposal`
- `mayMutatePlanState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

Workflow reconciliation includes a transition proposal only when explicit
`PlanState` was supplied and workflow execution produced step results. The host
or a future orchestration entrypoint must decide whether to apply it.

## Host-Owned Orchestration Entry Point

`reviewPlanStateTransitionProposal()` defines the first host-owned entrypoint
contract for transition proposals. It accepts:

- `PlanSpec`
- current-run `PlanState`
- `PlanStateTransitionProposal`
- host decision metadata: `decision`, `actor`, and `rationale`

Supported host decisions are:

- `accept_transition`
- `reject_transition`
- `request_replan`

The entrypoint returns an audited decision record:

- `scope: current_run_plan_host_orchestration_entrypoint`
- `status: accepted | rejected | blocked`
- trimmed `actor` and `rationale`
- accepted operations only when the host accepts a valid transition
- validation problems for invalid accepted transitions
- `mayMutatePlanState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This contract deliberately does not apply operations to `PlanState`. It only
defines what a host-owned orchestration boundary must validate before a future
runtime loop can apply state transitions. Rejecting or requesting replan does
not validate operation applicability because no operations are applied.

## Accepted Plan State Apply Result

`applyAcceptedPlanStateTransition()` defines the first deterministic apply
shape for host-accepted transition records. It consumes current-run `PlanState`
plus the audited result from `reviewPlanStateTransitionProposal()`.

The apply result is deliberately narrow:

- it applies only `status: accepted` + `decision: accept_transition`
- it skips rejected or replan-requested records
- it blocks already-blocked host records
- it copies `PlanState` before applying operations
- it returns `nextState` instead of mutating the input state
- duplicate terminal step or blocker appends are idempotent

The result must include:

- `scope: current_run_plan_state_apply_result`
- `status: applied | skipped | blocked`
- `nextState`
- applied operations
- problems for skipped or blocked records
- `appliesTo: returned_plan_state_copy`
- `mutatesInputPlanState: false`
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This still is not a runner loop. A host may choose to persist or discard the
returned `nextState`, but this helper does not write Workspace Memory,
TaskMemory, Archive, plast-mem, workflow state, or MCP-visible state.

## Host-Owned Runtime Transition Boundary

`runHostPlanStateTransition()` composes the host-owned review boundary with the
returned-copy apply helper. It accepts:

- `PlanSpec`
- current-run `PlanState`
- `PlanStateTransitionProposal`
- host decision metadata

The boundary returns:

- `scope: current_run_plan_host_runtime_transition`
- `status: applied | rejected | replan_requested | blocked | skipped`
- `hostEntry` from `reviewPlanStateTransitionProposal()`
- `applyResult` from `applyAcceptedPlanStateTransition()`
- `nextState` copied from the apply result
- `mutatesInputPlanState: false`
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This is the first host-owned current-run runtime boundary, but it is still not
automatic planning. It does not call a model, execute a lane, register a tool,
or persist the returned `nextState`. Rejections and replan requests remain
audited decisions, not hidden state mutations.

## Host-Owned Runtime State Holder

`createPlanHostRuntimeState()` defines the first current-run in-memory state
holder for `PlanState`. It owns a copied `PlanSpec`, the current `PlanState`,
and transition history for one host runtime instance.

The state holder can:

- return defensive copies of the current state, snapshot, and transition history
- run `runHostPlanStateTransition()` against the current state
- persist only `status: applied` transitions inside the current runtime
  instance
- record rejected, replan-requested, and blocked transitions without updating
  the current state

The state holder must not:

- persist state outside the runtime instance
- register MCP tools
- expose model-visible state mutation
- execute lanes or workflows
- write TaskMemory, Archive, Workspace Memory, or plast-mem records
- satisfy verification gates or mutation proof

Every transition record must include:

- `scope: current_run_plan_host_runtime_transition_record`
- a monotonically increasing `sequence`
- `previousState`
- `nextState`
- the audited transition result
- `stateUpdated`
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

## Explicit Host Workflow Reconciliation Caller

`applyWorkflowReconciliationTransitionForHost()` defines the first explicit
caller that can feed workflow reconciliation output into host-owned runtime
state. It accepts:

- a `PlanHostRuntimeStateController`
- a `PlanWorkflowReconciliationResult`
- host decision metadata

It only calls the runtime state holder when reconciliation is included and a
`transitionProposal` is present. Otherwise it returns `status: skipped` and
does not append runtime history.

The result must include:

- `scope: current_run_plan_host_workflow_reconciliation_caller`
- `status: applied | rejected | replan_requested | blocked | skipped`
- optional `transitionRecord`
- current runtime `snapshot`
- skipped problems when no transition can be applied
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This explicit caller is still host-owned. It is not registered as an MCP tool,
not exposed to the coding-runner model loop, and not a workflow executor.

## Runtime Recovery And Replan Request

`derivePlanRuntimeRecoveryRequest()` defines the first recovery contract for
blocked or host-requested replanning after workflow reconciliation.

The function consumes a `PlanHostWorkflowCallerResult` and returns either:

- `status: not_required`
- `status: replan_required`

Recovery is required only when:

- the caller status is `blocked`
- the caller status is `replan_requested`

The recovery request may include `replanInput` with the previous goal, previous
plan, current state, trigger, reason, blocked summaries, and boundary lines.
This data is for a future host/planner to use as input. It is not a generated
replacement plan.

The recovery contract must include:

- `scope: current_run_plan_runtime_recovery_request`
- `mayCreatePlanSpec: false`
- `mayMutatePlanState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This keeps replanning as an explicit host step. The recovery layer does not
call a planner model, invent lane mappings, replace `PlanState`, or export
failed plan state into TaskMemory, Archive, Workspace Memory, or plast-mem.

## Host-Supplied Replacement Plan Acceptance

`acceptHostSuppliedReplacementPlan()` defines the first boundary for accepting a
replacement `PlanSpec` after recovery requested replanning.

The function accepts:

- a `replan_required` recovery request
- a host-supplied replacement `PlanSpec`
- a host-supplied replacement initial `PlanState`
- host actor and rationale

It can create a new current-run `PlanHostRuntimeStateController`, but it must
not generate the replacement plan. It validates host metadata, basic plan
structure, duplicate step ids, and initial state references before creating the
new runtime holder.

The replacement record must include:

- `scope: current_run_plan_runtime_replacement`
- `status: accepted | blocked`
- trimmed actor and rationale
- recovery status and trigger
- previous plan/state when available from recovery input
- replacement runtime snapshot only when accepted
- `acceptsHostSuppliedPlanSpecOnly: true`
- `mayCreatePlanSpec: false`
- `mayMutatePreviousPlanState: false`
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This boundary is still not automatic replanning. A future host/planner must
produce the replacement `PlanSpec` explicitly; this package only validates and
holds it for the current run.

## Host-Owned Runtime Session

`createPlanHostRuntimeSession()` composes one current-run planning session from:

- an initial `PlanSpec`
- an initial `PlanState`
- the active `PlanHostRuntimeStateController`
- transition events
- host-supplied replacement-plan events

The session is an in-memory runtime holder. It can switch the active runtime
generation only when `acceptHostSuppliedReplacementPlan()` accepts a host-owned
replacement. Blocked replacement attempts are recorded as current-run session
events but do not switch the active plan.

The session snapshot must include:

- `scope: current_run_plan_host_runtime_session`
- `sessionId`
- current `generation`
- initial runtime snapshot
- active runtime snapshot
- event count
- transition count
- replacement count
- current-run event history
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

Session events must be either:

- `transition`
- `replacement`

Transition events wrap host runtime transition records. Replacement events wrap
replacement acceptance records and preserve previous/next runtime snapshots.
The session owns current-run composition only; it does not create replacement
plans, route lanes, execute workflows, write memory, or expose a model-visible
mutation surface.

## Runtime Session Projection

`projectPlanRuntimeSessionForPrompt()` defines how a host-owned current-run
planning session may be summarized for model context.

The projection accepts a `PlanHostRuntimeSessionSnapshot` and emits a bounded
text block plus metadata. It is separate from session control. It cannot call
`transition()`, call `replacePlan()`, route lanes, or execute workflows.

The block must say:

- `Plan runtime session summary (runtime guidance, not authority):`
- session history is current-run guidance only
- session history must not be persisted to Workspace Memory, Archive, or
  plast-mem
- session generation and event claims cannot execute lanes or satisfy
  completion proof

The metadata must include:

- `scope: current_run_plan_runtime_session_projection`
- `included: true`
- projection `status`
- active generation
- transition count
- replacement count
- projected/omitted event counts
- `authoritySource: plan_state_reconciler_decision`
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This projection may help a future runner understand current-run orchestration
state, but it is still lower authority than trusted tool evidence and the
verification gate.

`projectForCodingTurn()` can include this bounded session projection under
`【Current Plan Runtime Session】`. The injection order is:

1. base system prompt
2. current execution plan
3. current plan route summary
4. current plan runtime session summary
5. governed local Workspace Memory
6. optional plast-mem context
7. TaskMemory / operational trace / transcript projection

This wiring is context-only. It does not expose `transition()`, `replacePlan()`,
workflow execution, or replacement-plan submission to the coding-runner model
tool loop.

## Evidence Reconciliation

`reconcilePlanEvidence()` defines the first current-run evidence reconciliation
contract. It is a pure function. It is used by explicit workflow
reconciliation summaries, but it is not a global runner completion path.

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

## Host Session Workflow Run

`executeMappedPlanWorkflowForHostSession()` is the first explicit wiring between
mapped workflow execution and a host-owned current-run plan session.

It performs this sequence:

1. read the active plan/state snapshot from `PlanHostRuntimeSessionController`
2. execute a previously mapped `WorkflowDefinition` through
   `executeMappedPlanWorkflow()`
3. reconcile workflow results through `reconcilePlanWorkflowExecution()`
4. apply the resulting transition proposal to the session only when an explicit
   host decision is supplied

The result must include:

- `scope: current_run_plan_host_session_workflow_run`
- workflow execution result
- workflow reconciliation result
- optional session transition event
- before/after session snapshots
- skipped problems when reconciliation is unavailable
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This helper can execute workflow steps because it delegates to the existing
workflow engine, but the helper result itself still cannot satisfy completion
proof. It does not create plans, create mappings, approve actions, expose a
model-visible session control surface, or persist session state.

## Plan Session Recovery Replay

`normalizePlanSessionRecoveryReplay()` defines a deterministic replay row for
blocked or unresolved host-owned plan session histories.

Inputs:

- `PlanHostRuntimeSessionSnapshot`
- optional `PlanHostSessionWorkflowRunResult`

The normalizer is pure and bounded. It may classify:

- blocked host transitions
- rejected host transitions
- host-requested replan transitions
- blocked replacement plan acceptance
- blocked mapped workflow execution
- skipped workflow reconciliation
- unknown recovery signals

The replay row must include:

- `scope: current_run_plan_session_recovery_replay`
- `source: host_plan_runtime_session`
- session id, generation, active goal/current step, and event counts
- bounded latest event and workflow-run summaries
- deterministic failure class, anchor, and next follow-up
- `mutatesPersistentState: false`
- `mayExecute: false`
- `maySatisfyVerificationGate: false`
- `maySatisfyMutationProof: false`

This replay row is local triage evidence only. It must not be inserted into
TaskMemory, Archive, Workspace Memory, plast-mem, prompt authority, or MCP tool
schemas. Unknown rows must route to a deterministic replay follow-up before any
runtime recovery behavior is expanded.

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
- Applying an accepted transition only updates returned current-run plan state;
  it does not satisfy verification or mutation proof.
- The host runtime transition boundary composes review and apply, but still
  cannot execute lanes or persist state by itself.
- The in-memory runtime holder can persist current-run state inside one host
  instance only; it still cannot write durable memory or satisfy proof gates.
- The explicit workflow reconciliation caller can update that holder only when
  a host supplies decision metadata; it still cannot execute workflows.
- Runtime recovery can request replanning for blocked or replan-requested
  transitions, but it cannot create a replacement `PlanSpec`.
- Replacement plan acceptance can create a new in-memory runtime holder only
  from host-supplied `PlanSpec` and `PlanState`.
- A host runtime session can compose initial and replacement runtime holders
  into one current-run history, but it still cannot execute lanes, persist
  state, or satisfy proof gates.
- A projected session summary can inform the model about current-run session
  history, but it still cannot control the session or prove completion.
- The coding context projection may include bounded session summaries, but this
  is still prompt context only and not a session control channel.
- Host session workflow wiring can execute explicitly mapped workflow steps and
  record the reconciled transition in current-run session history, but its
  result still cannot bypass approval or verification gates.
- Plan session recovery replay can classify blocked/rejected/replan histories,
  but it cannot recover the session, execute lanes, or write memory.

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
- No default model-visible cross-lane execution tool.
- No generic MCP workflow execution tool.
- No runtime lane router execution.
- No model-visible host session workflow run tool.
- No MCP schema or tool-surface change.
- No automatic creation of `PlanSpec` or `PlanState`.
- No automatic persistence of applied plan state.
- No automatic host runtime loop scheduling.
- No durable PlanState store.
- No durable plan runtime session store.
- No model-visible plan state mutation caller.
- No model-visible plan runtime session control surface.
- No model-visible session projection control surface.
- No automatic PlanSpec generation during recovery.
- No model-visible replacement-plan submission surface.
- No automatic session recovery from replay rows.
- No Workspace Memory write.
- No TaskMemory merge.
- No plast-mem export or ingestion.
- No desktop/browser/coding execution behavior change.
- No merge or rebase with upstream desktop/chrome-extension work.

## Future Slices

1. `test(computer-use-mcp): define host planner recovery policy contract`
   - Decide which classified replay rows may request a replacement plan, and
     which must fail or wait for host approval.

2. `feat(computer-use-mcp): expose host-owned plan session control surface`
   - Only after recovery policy is explicit, define a host-side surface for
     applying recovery decisions. Do not expose it to the model loop by default.
