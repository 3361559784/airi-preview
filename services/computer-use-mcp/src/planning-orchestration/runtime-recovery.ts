import type { PlanSpec, PlanState } from './contract'
import type { PlanHostWorkflowCallerResult } from './host-workflow-caller'

export type PlanRuntimeRecoveryStatus = 'not_required' | 'replan_required'

export type PlanRuntimeRecoveryTrigger
  = | 'blocked_transition'
    | 'host_requested_replan'

export interface PlanRuntimeRecoveryReplanInput {
  previousGoal: string
  previousPlan: PlanSpec
  currentState: PlanState
  trigger: PlanRuntimeRecoveryTrigger
  reason: string
  blockedSummaries: string[]
  boundaries: string[]
}

export interface PlanRuntimeRecoveryRequest {
  scope: 'current_run_plan_runtime_recovery_request'
  status: PlanRuntimeRecoveryStatus
  trigger?: PlanRuntimeRecoveryTrigger
  sourceStatus: PlanHostWorkflowCallerResult['status']
  reason: string
  replanInput?: PlanRuntimeRecoveryReplanInput
  mayCreatePlanSpec: false
  mayMutatePlanState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export const PLAN_RUNTIME_REPLAN_BOUNDARY_LINES: readonly string[] = Object.freeze([
  'Replan request is current-run runtime guidance, not authority.',
  'The recovery layer does not generate a new PlanSpec by itself.',
  'A host or planner must provide any replacement PlanSpec explicitly.',
  'Existing trusted tool evidence and verification gates remain higher authority than the new plan.',
  'Rejected, blocked, or stale plan state must not be exported to TaskMemory, Archive, Workspace Memory, or plast-mem.',
])

/**
 * Converts host workflow caller output into a bounded recovery request. It does
 * not generate a new plan and does not mutate the runtime state holder.
 */
export function derivePlanRuntimeRecoveryRequest(params: {
  result: PlanHostWorkflowCallerResult
}): PlanRuntimeRecoveryRequest {
  if (params.result.status === 'blocked') {
    return buildReplanRequired({
      result: params.result,
      trigger: 'blocked_transition',
      reason: summarizeProblems(params.result.problems)
        ?? summarizeTransitionProblems(params.result)
        ?? 'Host workflow transition was blocked.',
    })
  }

  if (params.result.status === 'replan_requested') {
    return buildReplanRequired({
      result: params.result,
      trigger: 'host_requested_replan',
      reason: params.result.transitionRecord?.transition.hostEntry.rationale
        || 'Host requested a new plan.',
    })
  }

  return {
    scope: 'current_run_plan_runtime_recovery_request',
    status: 'not_required',
    sourceStatus: params.result.status,
    reason: `No plan runtime recovery is required for host workflow caller status: ${params.result.status}`,
    mayCreatePlanSpec: false,
    mayMutatePlanState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function buildReplanRequired(params: {
  result: PlanHostWorkflowCallerResult
  trigger: PlanRuntimeRecoveryTrigger
  reason: string
}): PlanRuntimeRecoveryRequest {
  const currentState = params.result.snapshot.state
  return {
    scope: 'current_run_plan_runtime_recovery_request',
    status: 'replan_required',
    trigger: params.trigger,
    sourceStatus: params.result.status,
    reason: params.reason,
    replanInput: {
      previousGoal: params.result.snapshot.plan.goal,
      previousPlan: clonePlanSpec(params.result.snapshot.plan),
      currentState: clonePlanState(currentState),
      trigger: params.trigger,
      reason: params.reason,
      blockedSummaries: [
        ...params.result.problems.map(problem => problem.detail),
        ...transitionProblemDetails(params.result),
      ].filter(Boolean),
      boundaries: [...PLAN_RUNTIME_REPLAN_BOUNDARY_LINES],
    },
    mayCreatePlanSpec: false,
    mayMutatePlanState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function summarizeProblems(problems: PlanHostWorkflowCallerResult['problems']): string | undefined {
  return problems[0]?.detail
}

function summarizeTransitionProblems(result: PlanHostWorkflowCallerResult): string | undefined {
  return result.transitionRecord?.transition.problems[0]?.detail
}

function transitionProblemDetails(result: PlanHostWorkflowCallerResult): string[] {
  return result.transitionRecord?.transition.problems.map(problem => problem.detail) ?? []
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
