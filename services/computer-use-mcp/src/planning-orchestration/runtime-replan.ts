import type { PlanSpec, PlanState } from './contract'
import type {
  PlanHostRuntimeStateController,
  PlanHostRuntimeStateSnapshot,
} from './host-runtime-state'
import type { PlanRuntimeRecoveryRequest } from './runtime-recovery'

import { createPlanHostRuntimeState } from './host-runtime-state'

export type PlanRuntimeReplacementStatus = 'accepted' | 'blocked'

export type PlanRuntimeReplacementProblemReason
  = | 'recovery_not_replan_required'
    | 'empty_actor'
    | 'empty_rationale'
    | 'empty_goal'
    | 'empty_steps'
    | 'empty_step_id'
    | 'duplicate_step_id'
    | 'initial_state_step_missing'
    | 'initial_state_step_conflict'

export interface PlanRuntimeReplacementProblem {
  reason: PlanRuntimeReplacementProblemReason
  detail: string
  stepId?: string
}

export interface PlanRuntimeReplacementRecord {
  scope: 'current_run_plan_runtime_replacement'
  status: PlanRuntimeReplacementStatus
  actor: string
  rationale: string
  recoveryStatus: PlanRuntimeRecoveryRequest['status']
  recoveryTrigger?: PlanRuntimeRecoveryRequest['trigger']
  previousPlan?: PlanSpec
  previousState?: PlanState
  replacementSnapshot?: PlanHostRuntimeStateSnapshot
  problems: PlanRuntimeReplacementProblem[]
  acceptsHostSuppliedPlanSpecOnly: true
  mayCreatePlanSpec: false
  mayMutatePreviousPlanState: false
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanRuntimeReplacementResult {
  record: PlanRuntimeReplacementRecord
  runtime?: PlanHostRuntimeStateController
}

/**
 * Accepts a host-supplied replacement plan after a bounded recovery request.
 * The replacement PlanSpec must already exist; this function never generates
 * one and never mutates the previous runtime state.
 */
export function acceptHostSuppliedReplacementPlan(params: {
  recovery: PlanRuntimeRecoveryRequest
  replacementPlan: PlanSpec
  initialState: PlanState
  actor: string
  rationale: string
}): PlanRuntimeReplacementResult {
  const actor = params.actor.trim()
  const rationale = params.rationale.trim()
  const problems = [
    ...validateHostMetadata(actor, rationale),
    ...validateRecovery(params.recovery),
    ...validateReplacementPlan(params.replacementPlan),
    ...validateInitialState(params.initialState, params.replacementPlan),
  ]

  if (problems.length > 0) {
    return {
      record: buildRecord({
        status: 'blocked',
        actor,
        rationale,
        recovery: params.recovery,
        problems,
      }),
    }
  }

  const runtime = createPlanHostRuntimeState({
    plan: params.replacementPlan,
    initialState: params.initialState,
  })

  return {
    record: buildRecord({
      status: 'accepted',
      actor,
      rationale,
      recovery: params.recovery,
      replacementSnapshot: runtime.getSnapshot(),
      problems: [],
    }),
    runtime,
  }
}

function validateHostMetadata(actor: string, rationale: string): PlanRuntimeReplacementProblem[] {
  const problems: PlanRuntimeReplacementProblem[] = []
  if (!actor) {
    problems.push({
      reason: 'empty_actor',
      detail: 'Replacement plan acceptance requires a non-empty actor.',
    })
  }
  if (!rationale) {
    problems.push({
      reason: 'empty_rationale',
      detail: 'Replacement plan acceptance requires a non-empty rationale.',
    })
  }
  return problems
}

function validateRecovery(recovery: PlanRuntimeRecoveryRequest): PlanRuntimeReplacementProblem[] {
  if (recovery.status === 'replan_required')
    return []
  return [{
    reason: 'recovery_not_replan_required',
    detail: `Replacement PlanSpec requires replan_required recovery, received: ${recovery.status}`,
  }]
}

function validateReplacementPlan(plan: PlanSpec): PlanRuntimeReplacementProblem[] {
  const problems: PlanRuntimeReplacementProblem[] = []
  if (!plan.goal.trim()) {
    problems.push({
      reason: 'empty_goal',
      detail: 'Replacement PlanSpec requires a non-empty goal.',
    })
  }
  if (plan.steps.length === 0) {
    problems.push({
      reason: 'empty_steps',
      detail: 'Replacement PlanSpec requires at least one step.',
    })
  }

  const seen = new Set<string>()
  for (const step of plan.steps) {
    const stepId = step.id.trim()
    if (!stepId) {
      problems.push({
        reason: 'empty_step_id',
        detail: 'Replacement PlanSpec steps require non-empty ids.',
      })
      continue
    }
    if (seen.has(stepId)) {
      problems.push({
        reason: 'duplicate_step_id',
        stepId,
        detail: `Replacement PlanSpec contains duplicate step id: ${stepId}`,
      })
    }
    seen.add(stepId)
  }

  return problems
}

function validateInitialState(state: PlanState, plan: PlanSpec): PlanRuntimeReplacementProblem[] {
  const planStepIds = new Set(plan.steps.map(step => step.id))
  const problems: PlanRuntimeReplacementProblem[] = []
  const terminalStepIds = new Set([
    ...state.completedSteps,
    ...state.failedSteps,
    ...state.skippedSteps,
  ])

  for (const stepId of collectInitialStateStepIds(state)) {
    if (!planStepIds.has(stepId)) {
      problems.push({
        reason: 'initial_state_step_missing',
        stepId,
        detail: `Replacement initial PlanState references step outside replacement PlanSpec: ${stepId}`,
      })
    }
  }

  if (state.currentStepId && terminalStepIds.has(state.currentStepId)) {
    problems.push({
      reason: 'initial_state_step_conflict',
      stepId: state.currentStepId,
      detail: `Replacement initial PlanState cannot use terminal step as current step: ${state.currentStepId}`,
    })
  }

  const completed = new Set(state.completedSteps)
  for (const stepId of state.failedSteps) {
    if (completed.has(stepId)) {
      problems.push({
        reason: 'initial_state_step_conflict',
        stepId,
        detail: `Replacement initial PlanState cannot both complete and fail step: ${stepId}`,
      })
    }
  }

  return problems
}

function collectInitialStateStepIds(state: PlanState): string[] {
  return [
    ...(state.currentStepId ? [state.currentStepId] : []),
    ...state.completedSteps,
    ...state.failedSteps,
    ...state.skippedSteps,
    ...state.evidenceRefs.map(ref => ref.stepId),
  ].filter(Boolean)
}

function buildRecord(params: {
  status: PlanRuntimeReplacementStatus
  actor: string
  rationale: string
  recovery: PlanRuntimeRecoveryRequest
  replacementSnapshot?: PlanHostRuntimeStateSnapshot
  problems: PlanRuntimeReplacementProblem[]
}): PlanRuntimeReplacementRecord {
  return {
    scope: 'current_run_plan_runtime_replacement',
    status: params.status,
    actor: params.actor,
    rationale: params.rationale,
    recoveryStatus: params.recovery.status,
    ...(params.recovery.trigger ? { recoveryTrigger: params.recovery.trigger } : {}),
    ...(params.recovery.replanInput
      ? {
          previousPlan: clonePlanSpec(params.recovery.replanInput.previousPlan),
          previousState: clonePlanState(params.recovery.replanInput.currentState),
        }
      : {}),
    ...(params.replacementSnapshot ? { replacementSnapshot: cloneSnapshot(params.replacementSnapshot) } : {}),
    problems: params.problems.map(problem => ({ ...problem })),
    acceptsHostSuppliedPlanSpecOnly: true,
    mayCreatePlanSpec: false,
    mayMutatePreviousPlanState: false,
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function cloneSnapshot(snapshot: PlanHostRuntimeStateSnapshot): PlanHostRuntimeStateSnapshot {
  return {
    ...snapshot,
    plan: clonePlanSpec(snapshot.plan),
    state: clonePlanState(snapshot.state),
    ...(snapshot.lastTransition
      ? {
          lastTransition: {
            ...snapshot.lastTransition,
            previousState: clonePlanState(snapshot.lastTransition.previousState),
            nextState: clonePlanState(snapshot.lastTransition.nextState),
          },
        }
      : {}),
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
