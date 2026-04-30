import type { PlanSpec, PlanState } from './contract'
import type {
  PlanHostOrchestrationDecisionInput,
  PlanHostOrchestrationEntryResult,
} from './host-entrypoint'
import type { PlanStateApplyResult } from './state-apply'
import type { PlanStateTransitionProposal, PlanStateTransitionProposalKind } from './state-transition'

import { reviewPlanStateTransitionProposal } from './host-entrypoint'
import { applyAcceptedPlanStateTransition } from './state-apply'

export type PlanHostRuntimeTransitionStatus
  = | 'applied'
    | 'rejected'
    | 'replan_requested'
    | 'blocked'
    | 'skipped'

export type PlanHostRuntimeTransitionProblemReason
  = | 'host_entry_problem'
    | 'apply_problem'

export interface PlanHostRuntimeTransitionProblem {
  reason: PlanHostRuntimeTransitionProblemReason
  detail: string
}

export interface PlanHostRuntimeTransitionResult {
  scope: 'current_run_plan_host_runtime_transition'
  status: PlanHostRuntimeTransitionStatus
  proposalKind: PlanStateTransitionProposalKind
  nextState: PlanState
  hostEntry: PlanHostOrchestrationEntryResult
  applyResult: PlanStateApplyResult
  problems: PlanHostRuntimeTransitionProblem[]
  mutatesInputPlanState: false
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Host-owned current-run transition boundary. It composes transition review and
 * returned-state apply, but still does not persist state or execute tools.
 */
export function runHostPlanStateTransition(params: {
  plan: PlanSpec
  state: PlanState
  proposal: PlanStateTransitionProposal
  hostDecision: PlanHostOrchestrationDecisionInput
}): PlanHostRuntimeTransitionResult {
  const hostEntry = reviewPlanStateTransitionProposal({
    plan: params.plan,
    state: params.state,
    proposal: params.proposal,
    hostDecision: params.hostDecision,
  })
  const applyResult = applyAcceptedPlanStateTransition({
    state: params.state,
    hostEntry,
  })

  return {
    scope: 'current_run_plan_host_runtime_transition',
    status: resolveRuntimeStatus(hostEntry, applyResult),
    proposalKind: hostEntry.proposalKind,
    nextState: applyResult.nextState,
    hostEntry,
    applyResult,
    problems: [
      ...hostEntry.problems.map(problem => ({
        reason: 'host_entry_problem' as const,
        detail: problem.detail,
      })),
      ...applyResult.problems.map(problem => ({
        reason: 'apply_problem' as const,
        detail: problem.detail,
      })),
    ],
    mutatesInputPlanState: false,
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function resolveRuntimeStatus(
  hostEntry: PlanHostOrchestrationEntryResult,
  applyResult: PlanStateApplyResult,
): PlanHostRuntimeTransitionStatus {
  if (hostEntry.status === 'blocked' || applyResult.status === 'blocked')
    return 'blocked'
  if (hostEntry.decision === 'request_replan')
    return 'replan_requested'
  if (hostEntry.decision === 'reject_transition')
    return 'rejected'
  return applyResult.status
}
