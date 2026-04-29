import type { PlanSpec, PlanState } from './contract'
import type { PlanEvidenceReconciliationResult, PlanStepEvidenceReconciliation } from './reconciliation'

export type PlanStateTransitionProposalKind
  = | 'advance_step'
    | 'mark_failed'
    | 'require_approval'
    | 'replan'
    | 'ready_for_final_verification'
    | 'noop'

export type PlanStateTransitionOperationKind
  = | 'set_current_step'
    | 'clear_current_step'
    | 'append_completed_step'
    | 'append_failed_step'
    | 'append_blocker'

export interface PlanStateTransitionOperation {
  kind: PlanStateTransitionOperationKind
  stepId?: string
  summary: string
}

export interface PlanStateTransitionProposal {
  scope: 'current_run_plan_state_transition_proposal'
  proposal: PlanStateTransitionProposalKind
  reason: string
  stepId?: string
  nextStepId?: string
  proposedOperations: PlanStateTransitionOperation[]
  mayMutatePlanState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Converts evidence reconciliation into a host-readable state transition
 * proposal. It never mutates PlanState; host orchestration must apply or reject
 * the proposal explicitly.
 */
export function derivePlanStateTransitionProposal(params: {
  plan: PlanSpec
  state: PlanState
  reconciliation: PlanEvidenceReconciliationResult
}): PlanStateTransitionProposal {
  const decision = params.reconciliation.decision

  if (decision.decision === 'ready_for_final_verification') {
    return buildProposal({
      proposal: 'ready_for_final_verification',
      reason: decision.reason,
      proposedOperations: [],
    })
  }

  if (decision.decision === 'require_approval') {
    return buildProposal({
      proposal: 'require_approval',
      reason: decision.reason,
      stepId: decision.stepId,
      proposedOperations: [{
        kind: 'append_blocker',
        stepId: decision.stepId,
        summary: decision.requiredApproval
          ? `Awaiting approval: ${decision.requiredApproval}`
          : 'Awaiting required human approval.',
      }],
    })
  }

  const failedStep = params.reconciliation.stepResults.find(step => step.evidenceStatus === 'blocked_by_failed_evidence')
  if (failedStep) {
    return buildProposal({
      proposal: 'mark_failed',
      reason: decision.reason,
      stepId: failedStep.stepId,
      proposedOperations: [
        {
          kind: 'append_failed_step',
          stepId: failedStep.stepId,
          summary: `Mark plan step ${failedStep.stepId} failed because current-run evidence failed.`,
        },
        ...(params.state.currentStepId === failedStep.stepId
          ? [{
              kind: 'clear_current_step' as const,
              stepId: failedStep.stepId,
              summary: `Clear current step ${failedStep.stepId} after failed evidence.`,
            }]
          : []),
      ],
    })
  }

  if (decision.decision === 'replan' || decision.decision === 'fail') {
    return buildProposal({
      proposal: 'replan',
      reason: decision.reason,
      stepId: decision.stepId,
      proposedOperations: [{
        kind: 'append_blocker',
        stepId: decision.stepId,
        summary: decision.reason,
      }],
    })
  }

  const advanceCandidate = findAdvanceCandidate(params.plan, params.state, params.reconciliation)
  if (advanceCandidate) {
    const nextStepId = findNextPendingStepId(params.plan, params.state, advanceCandidate.stepId)
    return buildProposal({
      proposal: 'advance_step',
      reason: `Current step ${advanceCandidate.stepId} has satisfied expected evidence.`,
      stepId: advanceCandidate.stepId,
      nextStepId,
      proposedOperations: [
        {
          kind: 'append_completed_step',
          stepId: advanceCandidate.stepId,
          summary: `Mark plan step ${advanceCandidate.stepId} completed.`,
        },
        ...(nextStepId
          ? [{
              kind: 'set_current_step' as const,
              stepId: nextStepId,
              summary: `Advance current step to ${nextStepId}.`,
            }]
          : [{
              kind: 'clear_current_step' as const,
              stepId: advanceCandidate.stepId,
              summary: 'Clear current step; no further pending step is available.',
            }]),
      ],
    })
  }

  return buildProposal({
    proposal: 'noop',
    reason: decision.reason,
    stepId: decision.stepId,
    proposedOperations: [],
  })
}

function findAdvanceCandidate(
  plan: PlanSpec,
  state: PlanState,
  reconciliation: PlanEvidenceReconciliationResult,
): PlanStepEvidenceReconciliation | undefined {
  if (!state.currentStepId)
    return undefined

  const step = reconciliation.stepResults.find(candidate => candidate.stepId === state.currentStepId)
  if (!step || step.planStatus !== 'in_progress' || step.evidenceStatus !== 'satisfied')
    return undefined

  return plan.steps.some(candidate => candidate.id === step.stepId) ? step : undefined
}

function findNextPendingStepId(
  plan: PlanSpec,
  state: PlanState,
  currentStepId: string,
): string | undefined {
  const currentIndex = plan.steps.findIndex(step => step.id === currentStepId)
  if (currentIndex < 0)
    return undefined

  const terminalStepIds = new Set([
    ...state.completedSteps,
    ...state.failedSteps,
    ...state.skippedSteps,
    currentStepId,
  ])

  return plan.steps.slice(currentIndex + 1).find(step => !terminalStepIds.has(step.id))?.id
}

function buildProposal(params: {
  proposal: PlanStateTransitionProposalKind
  reason: string
  stepId?: string
  nextStepId?: string
  proposedOperations: PlanStateTransitionOperation[]
}): PlanStateTransitionProposal {
  return {
    scope: 'current_run_plan_state_transition_proposal',
    proposal: params.proposal,
    reason: params.reason,
    ...(params.stepId ? { stepId: params.stepId } : {}),
    ...(params.nextStepId ? { nextStepId: params.nextStepId } : {}),
    proposedOperations: params.proposedOperations.map(operation => ({ ...operation })),
    mayMutatePlanState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}
