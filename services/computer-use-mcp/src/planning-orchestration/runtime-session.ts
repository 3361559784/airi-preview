import type { PlanSpec, PlanState } from './contract'
import type { PlanHostOrchestrationDecisionInput } from './host-entrypoint'
import type {
  PlanHostRuntimeStateController,
  PlanHostRuntimeStateSnapshot,
  PlanHostRuntimeTransitionRecord,
} from './host-runtime-state'
import type { PlanRuntimeRecoveryRequest } from './runtime-recovery'
import type {
  PlanRuntimeReplacementRecord,
} from './runtime-replan'
import type { PlanStateTransitionProposal } from './state-transition'

import { createPlanHostRuntimeState } from './host-runtime-state'
import { acceptHostSuppliedReplacementPlan } from './runtime-replan'

export type PlanHostRuntimeSessionEventKind = 'transition' | 'replacement'

export interface PlanHostRuntimeSessionEventBase {
  scope: 'current_run_plan_host_runtime_session_event'
  sequence: number
  generation: number
  kind: PlanHostRuntimeSessionEventKind
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanHostRuntimeSessionTransitionEvent extends PlanHostRuntimeSessionEventBase {
  kind: 'transition'
  transitionRecord: PlanHostRuntimeTransitionRecord
  snapshot: PlanHostRuntimeStateSnapshot
}

export interface PlanHostRuntimeSessionReplacementEvent extends PlanHostRuntimeSessionEventBase {
  kind: 'replacement'
  activeRuntimeReplaced: boolean
  replacement: PlanRuntimeReplacementRecord
  previousSnapshot: PlanHostRuntimeStateSnapshot
  nextSnapshot: PlanHostRuntimeStateSnapshot
}

export type PlanHostRuntimeSessionEvent
  = | PlanHostRuntimeSessionTransitionEvent
    | PlanHostRuntimeSessionReplacementEvent

export interface PlanHostRuntimeSessionSnapshot {
  scope: 'current_run_plan_host_runtime_session'
  sessionId: string
  generation: number
  initialSnapshot: PlanHostRuntimeStateSnapshot
  activeSnapshot: PlanHostRuntimeStateSnapshot
  eventCount: number
  transitionCount: number
  replacementCount: number
  history: PlanHostRuntimeSessionEvent[]
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanHostRuntimeSessionController {
  getActiveRuntimeSnapshot: () => PlanHostRuntimeStateSnapshot
  getHistory: () => PlanHostRuntimeSessionEvent[]
  getSnapshot: () => PlanHostRuntimeSessionSnapshot
  transition: (params: {
    proposal: PlanStateTransitionProposal
    hostDecision: PlanHostOrchestrationDecisionInput
  }) => PlanHostRuntimeSessionTransitionEvent
  replacePlan: (params: {
    recovery: PlanRuntimeRecoveryRequest
    replacementPlan: PlanSpec
    initialState: PlanState
    actor: string
    rationale: string
  }) => PlanHostRuntimeSessionReplacementEvent
}

/**
 * Composes one host-owned current-run planning session from an active runtime
 * state holder plus replacement-plan events. The session records current-run
 * audit history only; it never executes tools or writes durable memory.
 */
export function createPlanHostRuntimeSession(params: {
  sessionId: string
  plan: PlanSpec
  initialState: PlanState
}): PlanHostRuntimeSessionController {
  const sessionId = params.sessionId.trim() || 'current-run-plan-session'
  const initialRuntime = createPlanHostRuntimeState({
    plan: params.plan,
    initialState: params.initialState,
  })
  const initialSnapshot = initialRuntime.getSnapshot()
  let activeRuntime: PlanHostRuntimeStateController = initialRuntime
  let generation = 1
  const history: PlanHostRuntimeSessionEvent[] = []

  return {
    getActiveRuntimeSnapshot: () => activeRuntime.getSnapshot(),
    getHistory: () => history.map(cloneSessionEvent),
    getSnapshot: () => buildSessionSnapshot({
      sessionId,
      generation,
      initialSnapshot,
      activeSnapshot: activeRuntime.getSnapshot(),
      history,
    }),
    transition: ({ proposal, hostDecision }) => {
      const transitionRecord = activeRuntime.transition({ proposal, hostDecision })
      const event: PlanHostRuntimeSessionTransitionEvent = {
        scope: 'current_run_plan_host_runtime_session_event',
        sequence: history.length + 1,
        generation,
        kind: 'transition',
        transitionRecord,
        snapshot: activeRuntime.getSnapshot(),
        mutatesPersistentState: false,
        mayExecute: false,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      }
      history.push(cloneSessionEvent(event))
      return cloneSessionEvent(event)
    },
    replacePlan: ({ recovery, replacementPlan, initialState, actor, rationale }) => {
      const previousSnapshot = activeRuntime.getSnapshot()
      const replacement = acceptHostSuppliedReplacementPlan({
        recovery,
        replacementPlan,
        initialState,
        actor,
        rationale,
      })
      if (replacement.runtime) {
        activeRuntime = replacement.runtime
        generation += 1
      }

      const event: PlanHostRuntimeSessionReplacementEvent = {
        scope: 'current_run_plan_host_runtime_session_event',
        sequence: history.length + 1,
        generation,
        kind: 'replacement',
        activeRuntimeReplaced: replacement.record.status === 'accepted',
        replacement: replacement.record,
        previousSnapshot,
        nextSnapshot: activeRuntime.getSnapshot(),
        mutatesPersistentState: false,
        mayExecute: false,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      }
      history.push(cloneSessionEvent(event))
      return cloneSessionEvent(event)
    },
  }
}

function buildSessionSnapshot(params: {
  sessionId: string
  generation: number
  initialSnapshot: PlanHostRuntimeStateSnapshot
  activeSnapshot: PlanHostRuntimeStateSnapshot
  history: PlanHostRuntimeSessionEvent[]
}): PlanHostRuntimeSessionSnapshot {
  return {
    scope: 'current_run_plan_host_runtime_session',
    sessionId: params.sessionId,
    generation: params.generation,
    initialSnapshot: cloneSnapshot(params.initialSnapshot),
    activeSnapshot: cloneSnapshot(params.activeSnapshot),
    eventCount: params.history.length,
    transitionCount: params.history.filter(event => event.kind === 'transition').length,
    replacementCount: params.history.filter(event => event.kind === 'replacement').length,
    history: params.history.map(cloneSessionEvent),
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function cloneSessionEvent<T extends PlanHostRuntimeSessionEvent>(event: T): T {
  if (event.kind === 'transition') {
    return {
      ...event,
      transitionRecord: cloneTransitionRecord(event.transitionRecord),
      snapshot: cloneSnapshot(event.snapshot),
    } as T
  }

  return {
    ...event,
    replacement: cloneReplacementRecord(event.replacement),
    previousSnapshot: cloneSnapshot(event.previousSnapshot),
    nextSnapshot: cloneSnapshot(event.nextSnapshot),
  } as T
}

function cloneReplacementRecord(record: PlanRuntimeReplacementRecord): PlanRuntimeReplacementRecord {
  return {
    ...record,
    ...(record.previousPlan ? { previousPlan: clonePlanSpec(record.previousPlan) } : {}),
    ...(record.previousState ? { previousState: clonePlanState(record.previousState) } : {}),
    ...(record.replacementSnapshot ? { replacementSnapshot: cloneSnapshot(record.replacementSnapshot) } : {}),
    problems: record.problems.map(problem => ({ ...problem })),
  }
}

function cloneSnapshot(snapshot: PlanHostRuntimeStateSnapshot): PlanHostRuntimeStateSnapshot {
  return {
    ...snapshot,
    plan: clonePlanSpec(snapshot.plan),
    state: clonePlanState(snapshot.state),
    ...(snapshot.lastTransition ? { lastTransition: cloneTransitionRecord(snapshot.lastTransition) } : {}),
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
