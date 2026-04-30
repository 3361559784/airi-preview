import type { PlanSpec, PlanState } from './contract'
import type { PlanStateTransitionProposal, PlanStateTransitionProposalKind } from './state-transition'

export type PlanHostOrchestrationDecision = 'accept_transition' | 'reject_transition' | 'request_replan'

export type PlanHostOrchestrationStatus = 'accepted' | 'rejected' | 'blocked'

export interface PlanHostOrchestrationDecisionInput {
  decision: PlanHostOrchestrationDecision
  actor: string
  rationale: string
}

export interface PlanHostOrchestrationProblem {
  reason:
    | 'empty_actor'
    | 'empty_rationale'
    | 'plan_step_missing'
    | 'transition_step_conflict'
    | 'invalid_noop_acceptance'
    | 'invalid_ready_for_final_verification_acceptance'
  detail: string
  stepId?: string
}

export interface PlanHostOrchestrationEntryResult {
  scope: 'current_run_plan_host_orchestration_entrypoint'
  status: PlanHostOrchestrationStatus
  decision: PlanHostOrchestrationDecision
  actor: string
  rationale: string
  proposalKind: PlanStateTransitionProposalKind
  problems: PlanHostOrchestrationProblem[]
  acceptedOperations: PlanStateTransitionProposal['proposedOperations']
  mayMutatePlanState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Defines the host-owned boundary for accepting or rejecting a transition
 * proposal. This is still contract-only: it validates the proposal and returns
 * an audited decision record, but it never mutates PlanState.
 */
export function reviewPlanStateTransitionProposal(params: {
  plan: PlanSpec
  state: PlanState
  proposal: PlanStateTransitionProposal
  hostDecision: PlanHostOrchestrationDecisionInput
}): PlanHostOrchestrationEntryResult {
  const actor = params.hostDecision.actor.trim()
  const rationale = params.hostDecision.rationale.trim()
  const problems = [
    ...validateHostDecision(actor, rationale),
    ...validateProposalAgainstPlanState(params.plan, params.state, params.proposal, params.hostDecision.decision),
  ]

  const blocked = problems.length > 0
  const rejected = params.hostDecision.decision === 'reject_transition' || params.hostDecision.decision === 'request_replan'
  const status: PlanHostOrchestrationStatus = blocked
    ? 'blocked'
    : rejected ? 'rejected' : 'accepted'

  return {
    scope: 'current_run_plan_host_orchestration_entrypoint',
    status,
    decision: params.hostDecision.decision,
    actor,
    rationale,
    proposalKind: params.proposal.proposal,
    problems,
    acceptedOperations: status === 'accepted'
      ? params.proposal.proposedOperations.map(operation => ({ ...operation }))
      : [],
    mayMutatePlanState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function validateHostDecision(actor: string, rationale: string): PlanHostOrchestrationProblem[] {
  const problems: PlanHostOrchestrationProblem[] = []
  if (!actor) {
    problems.push({
      reason: 'empty_actor',
      detail: 'Host orchestration decision requires a non-empty actor.',
    })
  }
  if (!rationale) {
    problems.push({
      reason: 'empty_rationale',
      detail: 'Host orchestration decision requires a non-empty rationale.',
    })
  }
  return problems
}

function validateProposalAgainstPlanState(
  plan: PlanSpec,
  state: PlanState,
  proposal: PlanStateTransitionProposal,
  decision: PlanHostOrchestrationDecision,
): PlanHostOrchestrationProblem[] {
  if (decision !== 'accept_transition')
    return []

  const problems: PlanHostOrchestrationProblem[] = []
  const planStepIds = new Set(plan.steps.map(step => step.id))
  const knownStateStepIds = new Set([
    ...state.completedSteps,
    ...state.failedSteps,
    ...state.skippedSteps,
    ...(state.currentStepId ? [state.currentStepId] : []),
  ])

  for (const operation of proposal.proposedOperations) {
    if (operation.stepId && !planStepIds.has(operation.stepId)) {
      problems.push({
        reason: 'plan_step_missing',
        stepId: operation.stepId,
        detail: `Transition operation references step outside PlanSpec: ${operation.stepId}`,
      })
    }
    if (operation.kind === 'append_completed_step' && operation.stepId && state.failedSteps.includes(operation.stepId)) {
      problems.push({
        reason: 'transition_step_conflict',
        stepId: operation.stepId,
        detail: `Transition cannot complete already failed step: ${operation.stepId}`,
      })
    }
    if (operation.kind === 'append_failed_step' && operation.stepId && state.completedSteps.includes(operation.stepId)) {
      problems.push({
        reason: 'transition_step_conflict',
        stepId: operation.stepId,
        detail: `Transition cannot fail already completed step: ${operation.stepId}`,
      })
    }
    if (operation.kind === 'set_current_step' && operation.stepId && knownStateStepIds.has(operation.stepId)) {
      problems.push({
        reason: 'transition_step_conflict',
        stepId: operation.stepId,
        detail: `Transition cannot set terminal/current step as next current step: ${operation.stepId}`,
      })
    }
  }

  if (proposal.proposal === 'noop') {
    problems.push({
      reason: 'invalid_noop_acceptance',
      detail: 'Host cannot accept a noop transition proposal; reject it or request replan.',
    })
  }

  if (proposal.proposal === 'ready_for_final_verification') {
    problems.push({
      reason: 'invalid_ready_for_final_verification_acceptance',
      detail: 'Host cannot apply ready_for_final_verification as a PlanState mutation; final verification is a separate gate.',
    })
  }

  return problems
}
