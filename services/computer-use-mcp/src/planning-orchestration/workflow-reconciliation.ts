import type { PlanSpec, PlanState } from './contract'
import type { PlanEvidenceObservation, PlanEvidenceReconciliationResult } from './reconciliation'
import type { PlanStateTransitionProposal } from './state-transition'
import type { PlanWorkflowExecutionResult } from './workflow-execution'
import type { PlanWorkflowMappingResult } from './workflow-mapping'

import { reconcilePlanEvidence } from './reconciliation'
import { derivePlanStateTransitionProposal } from './state-transition'
import { buildPlanEvidenceObservationsFromWorkflowExecution } from './workflow-evidence'

export type PlanWorkflowReconciliationSkippedReason
  = | 'missing_plan_state'
    | 'workflow_execution_not_available'

export interface PlanWorkflowReconciliationResult {
  scope: 'current_run_plan_workflow_reconciliation'
  included: boolean
  skippedReason?: PlanWorkflowReconciliationSkippedReason
  evidenceObservations: PlanEvidenceObservation[]
  reconciliation?: PlanEvidenceReconciliationResult
  transitionProposal?: PlanStateTransitionProposal
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Reconciles mapped workflow execution evidence against an explicit current-run
 * plan state. This never updates PlanState and never turns workflow success
 * into final runner completion.
 */
export function reconcilePlanWorkflowExecution(params: {
  plan: PlanSpec
  state?: PlanState
  mapping: PlanWorkflowMappingResult
  execution: PlanWorkflowExecutionResult
}): PlanWorkflowReconciliationResult {
  const evidenceObservations = buildPlanEvidenceObservationsFromWorkflowExecution({
    mapping: params.mapping,
    execution: params.execution,
  })

  if (!params.state) {
    return {
      scope: 'current_run_plan_workflow_reconciliation',
      included: false,
      skippedReason: 'missing_plan_state',
      evidenceObservations,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    }
  }

  if (!params.execution.executed || !params.execution.workflowResult) {
    return {
      scope: 'current_run_plan_workflow_reconciliation',
      included: false,
      skippedReason: 'workflow_execution_not_available',
      evidenceObservations,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    }
  }

  const reconciliation = reconcilePlanEvidence({
    plan: params.plan,
    state: params.state,
    observations: evidenceObservations,
  })

  return {
    scope: 'current_run_plan_workflow_reconciliation',
    included: true,
    evidenceObservations,
    reconciliation,
    transitionProposal: derivePlanStateTransitionProposal({
      plan: params.plan,
      state: params.state,
      reconciliation,
    }),
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}
