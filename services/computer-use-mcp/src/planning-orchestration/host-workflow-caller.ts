import type { PlanHostOrchestrationDecisionInput } from './host-entrypoint'
import type { PlanHostRuntimeTransitionStatus } from './host-runtime'
import type {
  PlanHostRuntimeStateController,
  PlanHostRuntimeStateSnapshot,
  PlanHostRuntimeTransitionRecord,
} from './host-runtime-state'
import type { PlanWorkflowReconciliationResult } from './workflow-reconciliation'

export type PlanHostWorkflowCallerStatus = PlanHostRuntimeTransitionStatus | 'skipped'

export type PlanHostWorkflowCallerSkippedReason
  = | 'reconciliation_not_included'
    | 'missing_transition_proposal'

export interface PlanHostWorkflowCallerProblem {
  reason: PlanHostWorkflowCallerSkippedReason
  detail: string
}

export interface PlanHostWorkflowCallerResult {
  scope: 'current_run_plan_host_workflow_reconciliation_caller'
  status: PlanHostWorkflowCallerStatus
  skippedReason?: PlanHostWorkflowCallerSkippedReason
  transitionRecord?: PlanHostRuntimeTransitionRecord
  snapshot: PlanHostRuntimeStateSnapshot
  problems: PlanHostWorkflowCallerProblem[]
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Explicit host caller for workflow reconciliation results. It updates only the
 * supplied host runtime state holder and only when reconciliation produced a
 * transition proposal plus an explicit host decision.
 */
export function applyWorkflowReconciliationTransitionForHost(params: {
  runtime: PlanHostRuntimeStateController
  reconciliation: PlanWorkflowReconciliationResult
  hostDecision: PlanHostOrchestrationDecisionInput
}): PlanHostWorkflowCallerResult {
  if (!params.reconciliation.included) {
    return buildSkippedResult({
      runtime: params.runtime,
      skippedReason: 'reconciliation_not_included',
      detail: params.reconciliation.skippedReason
        ? `Workflow reconciliation was skipped: ${params.reconciliation.skippedReason}`
        : 'Workflow reconciliation was not included.',
    })
  }

  if (!params.reconciliation.transitionProposal) {
    return buildSkippedResult({
      runtime: params.runtime,
      skippedReason: 'missing_transition_proposal',
      detail: 'Workflow reconciliation did not produce a transition proposal.',
    })
  }

  const transitionRecord = params.runtime.transition({
    proposal: params.reconciliation.transitionProposal,
    hostDecision: params.hostDecision,
  })

  return {
    scope: 'current_run_plan_host_workflow_reconciliation_caller',
    status: transitionRecord.transition.status,
    transitionRecord,
    snapshot: params.runtime.getSnapshot(),
    problems: [],
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function buildSkippedResult(params: {
  runtime: PlanHostRuntimeStateController
  skippedReason: PlanHostWorkflowCallerSkippedReason
  detail: string
}): PlanHostWorkflowCallerResult {
  return {
    scope: 'current_run_plan_host_workflow_reconciliation_caller',
    status: 'skipped',
    skippedReason: params.skippedReason,
    snapshot: params.runtime.getSnapshot(),
    problems: [{
      reason: params.skippedReason,
      detail: params.detail,
    }],
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}
