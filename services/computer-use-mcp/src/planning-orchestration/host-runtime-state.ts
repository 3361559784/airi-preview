import type { PlanSpec, PlanState } from './contract'
import type { PlanHostOrchestrationDecisionInput } from './host-entrypoint'
import type { PlanHostRuntimeTransitionResult } from './host-runtime'
import type { PlanStateTransitionProposal } from './state-transition'

import { runHostPlanStateTransition } from './host-runtime'

export interface PlanHostRuntimeTransitionRecord {
  scope: 'current_run_plan_host_runtime_transition_record'
  sequence: number
  stateUpdated: boolean
  previousState: PlanState
  nextState: PlanState
  transition: PlanHostRuntimeTransitionResult
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanHostRuntimeStateSnapshot {
  scope: 'current_run_plan_host_runtime_state'
  plan: PlanSpec
  state: PlanState
  transitionCount: number
  lastTransition?: PlanHostRuntimeTransitionRecord
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanHostRuntimeStateController {
  getState: () => PlanState
  getHistory: () => PlanHostRuntimeTransitionRecord[]
  getSnapshot: () => PlanHostRuntimeStateSnapshot
  transition: (params: {
    proposal: PlanStateTransitionProposal
    hostDecision: PlanHostOrchestrationDecisionInput
  }) => PlanHostRuntimeTransitionRecord
}

/**
 * Creates a host-owned current-run PlanState holder. It persists state only
 * inside this runtime instance; no MCP-visible, memory, archive, or workflow
 * state is written.
 */
export function createPlanHostRuntimeState(params: {
  plan: PlanSpec
  initialState: PlanState
}): PlanHostRuntimeStateController {
  const plan = clonePlanSpec(params.plan)
  let state = clonePlanState(params.initialState)
  const history: PlanHostRuntimeTransitionRecord[] = []

  return {
    getState: () => clonePlanState(state),
    getHistory: () => history.map(cloneTransitionRecord),
    getSnapshot: () => buildSnapshot(plan, state, history),
    transition: ({ proposal, hostDecision }) => {
      const previousState = clonePlanState(state)
      const transition = runHostPlanStateTransition({
        plan,
        state: previousState,
        proposal,
        hostDecision,
      })
      const stateUpdated = transition.status === 'applied'
      if (stateUpdated)
        state = clonePlanState(transition.nextState)

      const record: PlanHostRuntimeTransitionRecord = {
        scope: 'current_run_plan_host_runtime_transition_record',
        sequence: history.length + 1,
        stateUpdated,
        previousState,
        nextState: clonePlanState(state),
        transition,
        mutatesPersistentState: false,
        mayExecute: false,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      }
      history.push(cloneTransitionRecord(record))
      return cloneTransitionRecord(record)
    },
  }
}

function buildSnapshot(
  plan: PlanSpec,
  state: PlanState,
  history: PlanHostRuntimeTransitionRecord[],
): PlanHostRuntimeStateSnapshot {
  const lastTransition = history.at(-1)
  return {
    scope: 'current_run_plan_host_runtime_state',
    plan: clonePlanSpec(plan),
    state: clonePlanState(state),
    transitionCount: history.length,
    ...(lastTransition ? { lastTransition: cloneTransitionRecord(lastTransition) } : {}),
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function cloneTransitionRecord(record: PlanHostRuntimeTransitionRecord): PlanHostRuntimeTransitionRecord {
  return {
    ...record,
    previousState: clonePlanState(record.previousState),
    nextState: clonePlanState(record.nextState),
    transition: {
      ...record.transition,
      nextState: clonePlanState(record.transition.nextState),
      hostEntry: {
        ...record.transition.hostEntry,
        problems: record.transition.hostEntry.problems.map(problem => ({ ...problem })),
        acceptedOperations: record.transition.hostEntry.acceptedOperations.map(operation => ({ ...operation })),
      },
      applyResult: {
        ...record.transition.applyResult,
        nextState: clonePlanState(record.transition.applyResult.nextState),
        appliedOperations: record.transition.applyResult.appliedOperations.map(operation => ({ ...operation })),
        problems: record.transition.applyResult.problems.map(problem => ({ ...problem })),
      },
      problems: record.transition.problems.map(problem => ({ ...problem })),
    },
  }
}

function clonePlanSpec(plan: PlanSpec): PlanSpec {
  return {
    goal: plan.goal,
    steps: plan.steps.map(step => ({
      ...step,
      allowedTools: [...step.allowedTools],
      expectedEvidence: step.expectedEvidence.map(evidence => ({ ...evidence })),
    })),
  }
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
