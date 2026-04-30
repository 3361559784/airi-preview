import type { PlanState } from './contract'
import type { PlanHostOrchestrationEntryResult } from './host-entrypoint'
import type { PlanStateTransitionOperation } from './state-transition'

export type PlanStateApplyStatus = 'applied' | 'skipped' | 'blocked'

export type PlanStateApplyProblemReason
  = | 'host_entry_not_accepted'
    | 'host_entry_has_problems'
    | 'empty_accepted_operations'

export interface PlanStateApplyProblem {
  reason: PlanStateApplyProblemReason
  detail: string
}

export interface PlanStateApplyResult {
  scope: 'current_run_plan_state_apply_result'
  status: PlanStateApplyStatus
  nextState: PlanState
  appliedOperations: PlanStateTransitionOperation[]
  problems: PlanStateApplyProblem[]
  appliesTo: 'returned_plan_state_copy'
  mutatesInputPlanState: false
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Applies host-accepted transition operations to a returned PlanState copy.
 * This is still a host-owned current-run boundary: it does not execute tools,
 * persist state, or treat plan state as verification or mutation proof.
 */
export function applyAcceptedPlanStateTransition(params: {
  state: PlanState
  hostEntry: PlanHostOrchestrationEntryResult
}): PlanStateApplyResult {
  const nextState = clonePlanState(params.state)

  if (params.hostEntry.status !== 'accepted' || params.hostEntry.decision !== 'accept_transition') {
    return buildResult({
      status: params.hostEntry.status === 'blocked' ? 'blocked' : 'skipped',
      nextState,
      appliedOperations: [],
      problems: [{
        reason: 'host_entry_not_accepted',
        detail: `Plan state transition was not accepted by host entrypoint: ${params.hostEntry.status}/${params.hostEntry.decision}`,
      }],
    })
  }

  if (params.hostEntry.problems.length > 0) {
    return buildResult({
      status: 'blocked',
      nextState,
      appliedOperations: [],
      problems: [{
        reason: 'host_entry_has_problems',
        detail: 'Accepted host entrypoint result still contains validation problems.',
      }],
    })
  }

  if (params.hostEntry.acceptedOperations.length === 0) {
    return buildResult({
      status: 'skipped',
      nextState,
      appliedOperations: [],
      problems: [{
        reason: 'empty_accepted_operations',
        detail: 'Accepted host entrypoint result did not include operations to apply.',
      }],
    })
  }

  const appliedOperations = params.hostEntry.acceptedOperations.map(operation => ({ ...operation }))
  for (const operation of appliedOperations)
    applyOperation(nextState, operation)

  return buildResult({
    status: 'applied',
    nextState,
    appliedOperations,
    problems: [],
  })
}

function clonePlanState(state: PlanState): PlanState {
  return {
    ...(state.currentStepId ? { currentStepId: state.currentStepId } : {}),
    completedSteps: [...state.completedSteps],
    failedSteps: [...state.failedSteps],
    skippedSteps: [...state.skippedSteps],
    evidenceRefs: state.evidenceRefs.map(ref => ({ ...ref })),
    blockers: [...state.blockers],
    ...(state.lastReplanReason ? { lastReplanReason: state.lastReplanReason } : {}),
  }
}

function applyOperation(state: PlanState, operation: PlanStateTransitionOperation): void {
  switch (operation.kind) {
    case 'append_completed_step':
      appendUnique(state.completedSteps, operation.stepId)
      return
    case 'append_failed_step':
      appendUnique(state.failedSteps, operation.stepId)
      return
    case 'set_current_step':
      if (operation.stepId)
        state.currentStepId = operation.stepId
      return
    case 'clear_current_step':
      delete state.currentStepId
      return
    case 'append_blocker':
      appendUnique(state.blockers, operation.summary.trim())
  }
}

function appendUnique(target: string[], value: string | undefined): void {
  if (!value || target.includes(value))
    return
  target.push(value)
}

function buildResult(params: {
  status: PlanStateApplyStatus
  nextState: PlanState
  appliedOperations: PlanStateTransitionOperation[]
  problems: PlanStateApplyProblem[]
}): PlanStateApplyResult {
  return {
    scope: 'current_run_plan_state_apply_result',
    status: params.status,
    nextState: params.nextState,
    appliedOperations: params.appliedOperations.map(operation => ({ ...operation })),
    problems: params.problems.map(problem => ({ ...problem })),
    appliesTo: 'returned_plan_state_copy',
    mutatesInputPlanState: false,
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}
