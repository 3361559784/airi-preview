import type {
  PlanSessionRecoveryReplayClass,
  PlanSessionRecoveryReplayRow,
} from './session-replay'

export type PlanHostPlannerRecoveryPolicyDecision
  = | 'request_replacement_plan'
    | 'require_host_approval'
    | 'fail_recovery_attempt'
    | 'deterministic_replay_required'

export type PlanHostPlannerRecoveryRequiredAction
  = | 'review_rejected_transition'
    | 'fix_blocked_transition'
    | 'inspect_recovery_failure'
    | 'add_deterministic_replay'

export interface PlanHostPlannerReplacementPlanRequest {
  scope: 'current_run_plan_replacement_plan_request'
  sessionId: string
  generation: number
  activeGoalPreview: string
  activeCurrentStepId?: string
  trigger: Extract<
    PlanSessionRecoveryReplayClass,
    'replan_requested' | 'workflow_execution_blocked' | 'workflow_reconciliation_skipped'
  >
  reason: string
  boundaries: string[]
  acceptsHostSuppliedPlanSpecOnly: true
  mayCreatePlanSpec: false
  mayMutatePlanState: false
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanHostPlannerRecoveryPolicyResult {
  scope: 'current_run_plan_host_planner_recovery_policy'
  source: 'plan_session_recovery_replay'
  sessionId: string
  generation: number
  replayFailureClass: PlanSessionRecoveryReplayClass
  decision: PlanHostPlannerRecoveryPolicyDecision
  reason: string
  replacementPlanRequest?: PlanHostPlannerReplacementPlanRequest
  requiredHostAction?: PlanHostPlannerRecoveryRequiredAction
  deterministicAnchor: string
  nextFollowUp: string
  mayRequestReplacementPlan: boolean
  requiresHostApproval: boolean
  failsRecoveryAttempt: boolean
  deterministicReplayRequired: boolean
  mayCreatePlanSpec: false
  mayMutatePlanState: false
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export const PLAN_HOST_PLANNER_RECOVERY_POLICY_BOUNDARY_LINES: readonly string[] = Object.freeze([
  'Recovery policy is current-run host guidance, not instruction authority.',
  'The policy may request a host/planner supplied replacement PlanSpec, but it never creates one.',
  'Replay rows and policy decisions do not execute tools, mutate PlanState, or satisfy verification gates.',
  'Unknown recovery classes require deterministic replay before runtime recovery changes.',
  'Blocked replacement attempts must not loop into automatic replacement-plan generation.',
])

/**
 * Maps deterministic session replay rows to host/planner next-action policy.
 * The result is current-run guidance only; it never creates a replacement
 * PlanSpec, mutates a session, or executes workflow steps.
 */
export function derivePlanHostPlannerRecoveryPolicy(params: {
  replay: PlanSessionRecoveryReplayRow
}): PlanHostPlannerRecoveryPolicyResult {
  const replay = params.replay

  switch (replay.failureClass) {
    case 'replan_requested':
      return buildReplacementPlanRequestPolicy({
        replay,
        reason: 'Host explicitly requested a replacement plan for this current-run session.',
      })
    case 'workflow_execution_blocked':
      return buildReplacementPlanRequestPolicy({
        replay,
        reason: 'The mapped workflow could not execute; a host/planner supplied replacement route may be needed.',
      })
    case 'workflow_reconciliation_skipped':
      return buildReplacementPlanRequestPolicy({
        replay,
        reason: 'Workflow evidence did not produce a usable plan transition; a replacement route may be needed.',
      })
    case 'transition_rejected':
      return buildHostApprovalPolicy({
        replay,
        requiredHostAction: 'review_rejected_transition',
        reason: 'Host rejected the transition; policy must wait for explicit host direction before replanning.',
      })
    case 'transition_blocked':
      if (replay.latestEvent?.problemReasons.includes('host_entry_problem')) {
        return buildHostApprovalPolicy({
          replay,
          requiredHostAction: 'fix_blocked_transition',
          reason: 'Transition was blocked at the host entrypoint; host decision metadata or proposal validity must be reviewed first.',
        })
      }

      return buildFailedRecoveryPolicy({
        replay,
        reason: 'Transition was blocked after host entry review; fail this recovery attempt instead of automatic replanning.',
      })
    case 'replacement_blocked':
      return buildFailedRecoveryPolicy({
        replay,
        reason: 'A host-supplied replacement plan was blocked; do not loop into automatic replacement generation.',
      })
    case 'unknown':
      return buildDeterministicReplayPolicy({
        replay,
        reason: 'The replay class is unknown; add deterministic coverage before expanding recovery behavior.',
      })
  }
}

function buildReplacementPlanRequestPolicy(params: {
  replay: PlanSessionRecoveryReplayRow
  reason: string
}): PlanHostPlannerRecoveryPolicyResult {
  const replacementPlanRequest = buildReplacementPlanRequest({
    replay: params.replay,
    reason: params.reason,
  })
  return buildBasePolicy({
    replay: params.replay,
    decision: 'request_replacement_plan',
    reason: params.reason,
    replacementPlanRequest,
    nextFollowUp: 'feat(computer-use-mcp): accept host-supplied replacement plan for recovery policy',
    mayRequestReplacementPlan: true,
    requiresHostApproval: false,
    failsRecoveryAttempt: false,
    deterministicReplayRequired: false,
  })
}

function buildHostApprovalPolicy(params: {
  replay: PlanSessionRecoveryReplayRow
  requiredHostAction: PlanHostPlannerRecoveryRequiredAction
  reason: string
}): PlanHostPlannerRecoveryPolicyResult {
  return buildBasePolicy({
    replay: params.replay,
    decision: 'require_host_approval',
    reason: params.reason,
    requiredHostAction: params.requiredHostAction,
    nextFollowUp: 'test(computer-use-mcp): define host approval handling for plan recovery policy',
    mayRequestReplacementPlan: false,
    requiresHostApproval: true,
    failsRecoveryAttempt: false,
    deterministicReplayRequired: false,
  })
}

function buildFailedRecoveryPolicy(params: {
  replay: PlanSessionRecoveryReplayRow
  reason: string
}): PlanHostPlannerRecoveryPolicyResult {
  return buildBasePolicy({
    replay: params.replay,
    decision: 'fail_recovery_attempt',
    reason: params.reason,
    requiredHostAction: 'inspect_recovery_failure',
    nextFollowUp: 'test(computer-use-mcp): define failed plan recovery attempt reporting',
    mayRequestReplacementPlan: false,
    requiresHostApproval: false,
    failsRecoveryAttempt: true,
    deterministicReplayRequired: false,
  })
}

function buildDeterministicReplayPolicy(params: {
  replay: PlanSessionRecoveryReplayRow
  reason: string
}): PlanHostPlannerRecoveryPolicyResult {
  return buildBasePolicy({
    replay: params.replay,
    decision: 'deterministic_replay_required',
    reason: params.reason,
    requiredHostAction: 'add_deterministic_replay',
    nextFollowUp: params.replay.nextFollowUp,
    mayRequestReplacementPlan: false,
    requiresHostApproval: false,
    failsRecoveryAttempt: false,
    deterministicReplayRequired: true,
  })
}

function buildBasePolicy(params: {
  replay: PlanSessionRecoveryReplayRow
  decision: PlanHostPlannerRecoveryPolicyDecision
  reason: string
  replacementPlanRequest?: PlanHostPlannerReplacementPlanRequest
  requiredHostAction?: PlanHostPlannerRecoveryRequiredAction
  nextFollowUp: string
  mayRequestReplacementPlan: boolean
  requiresHostApproval: boolean
  failsRecoveryAttempt: boolean
  deterministicReplayRequired: boolean
}): PlanHostPlannerRecoveryPolicyResult {
  return {
    scope: 'current_run_plan_host_planner_recovery_policy',
    source: 'plan_session_recovery_replay',
    sessionId: params.replay.sessionId,
    generation: params.replay.generation,
    replayFailureClass: params.replay.failureClass,
    decision: params.decision,
    reason: params.reason,
    ...(params.replacementPlanRequest ? { replacementPlanRequest: cloneReplacementPlanRequest(params.replacementPlanRequest) } : {}),
    ...(params.requiredHostAction ? { requiredHostAction: params.requiredHostAction } : {}),
    deterministicAnchor: params.replay.deterministicAnchor,
    nextFollowUp: params.nextFollowUp,
    mayRequestReplacementPlan: params.mayRequestReplacementPlan,
    requiresHostApproval: params.requiresHostApproval,
    failsRecoveryAttempt: params.failsRecoveryAttempt,
    deterministicReplayRequired: params.deterministicReplayRequired,
    mayCreatePlanSpec: false,
    mayMutatePlanState: false,
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function buildReplacementPlanRequest(params: {
  replay: PlanSessionRecoveryReplayRow
  reason: string
}): PlanHostPlannerReplacementPlanRequest {
  const trigger = params.replay.failureClass
  if (
    trigger !== 'replan_requested'
    && trigger !== 'workflow_execution_blocked'
    && trigger !== 'workflow_reconciliation_skipped'
  ) {
    throw new Error(`Replay class cannot request replacement plan: ${trigger}`)
  }

  return {
    scope: 'current_run_plan_replacement_plan_request',
    sessionId: params.replay.sessionId,
    generation: params.replay.generation,
    activeGoalPreview: params.replay.activeGoalPreview,
    ...(params.replay.activeCurrentStepId ? { activeCurrentStepId: params.replay.activeCurrentStepId } : {}),
    trigger,
    reason: params.reason,
    boundaries: [...PLAN_HOST_PLANNER_RECOVERY_POLICY_BOUNDARY_LINES],
    acceptsHostSuppliedPlanSpecOnly: true,
    mayCreatePlanSpec: false,
    mayMutatePlanState: false,
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function cloneReplacementPlanRequest(
  request: PlanHostPlannerReplacementPlanRequest,
): PlanHostPlannerReplacementPlanRequest {
  return {
    ...request,
    boundaries: [...request.boundaries],
  }
}
