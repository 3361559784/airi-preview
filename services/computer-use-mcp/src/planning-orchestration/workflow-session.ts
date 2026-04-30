import type { ExecuteAction } from '../server/action-executor'
import type { RunStateManager } from '../state'
import type {
  AcquirePtyForStep,
  ExecutePrepTool,
} from '../workflows/engine'
import type { PlanHostOrchestrationDecisionInput } from './host-entrypoint'
import type {
  PlanHostRuntimeSessionController,
  PlanHostRuntimeSessionEvent,
  PlanHostRuntimeSessionSnapshot,
} from './runtime-session'
import type { PlanWorkflowExecutionResult } from './workflow-execution'
import type { PlanWorkflowMappingResult } from './workflow-mapping'
import type { PlanWorkflowReconciliationResult } from './workflow-reconciliation'

import { executeMappedPlanWorkflow } from './workflow-execution'
import { reconcilePlanWorkflowExecution } from './workflow-reconciliation'

export type PlanHostSessionWorkflowRunStatus
  = | 'applied'
    | 'rejected'
    | 'replan_requested'
    | 'blocked'
    | 'skipped'

export type PlanHostSessionWorkflowRunSkippedReason
  = | 'reconciliation_not_included'
    | 'missing_transition_proposal'

export interface PlanHostSessionWorkflowRunProblem {
  reason: PlanHostSessionWorkflowRunSkippedReason
  detail: string
}

export interface PlanHostSessionWorkflowRunResult {
  scope: 'current_run_plan_host_session_workflow_run'
  status: PlanHostSessionWorkflowRunStatus
  execution: PlanWorkflowExecutionResult
  reconciliation: PlanWorkflowReconciliationResult
  transitionEvent?: PlanHostRuntimeSessionEvent
  beforeSessionSnapshot: PlanHostRuntimeSessionSnapshot
  afterSessionSnapshot: PlanHostRuntimeSessionSnapshot
  problems: PlanHostSessionWorkflowRunProblem[]
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Executes a mapped workflow against the active host-owned plan session,
 * reconciles workflow evidence, and applies the resulting transition only when
 * a host decision accepts it. This is still current-run only and never turns
 * workflow success into completion proof.
 */
export async function executeMappedPlanWorkflowForHostSession(params: {
  session: PlanHostRuntimeSessionController
  mapping: PlanWorkflowMappingResult
  hostDecision: PlanHostOrchestrationDecisionInput
  executeAction: ExecuteAction
  executePrepTool?: ExecutePrepTool
  stateManager: RunStateManager
  refreshState?: () => Promise<void>
  overrides?: Record<string, unknown>
  autoApproveSteps?: boolean
  acquirePty?: AcquirePtyForStep
}): Promise<PlanHostSessionWorkflowRunResult> {
  const beforeSessionSnapshot = params.session.getSnapshot()
  const activeRuntimeSnapshot = params.session.getActiveRuntimeSnapshot()
  const execution = await executeMappedPlanWorkflow({
    mapping: params.mapping,
    executeAction: params.executeAction,
    executePrepTool: params.executePrepTool,
    stateManager: params.stateManager,
    refreshState: params.refreshState,
    overrides: params.overrides,
    autoApproveSteps: params.autoApproveSteps ?? false,
    acquirePty: params.acquirePty,
  })
  const reconciliation = reconcilePlanWorkflowExecution({
    plan: activeRuntimeSnapshot.plan,
    state: activeRuntimeSnapshot.state,
    mapping: params.mapping,
    execution,
  })

  if (!reconciliation.included) {
    return buildSkippedResult({
      status: 'skipped',
      skippedReason: 'reconciliation_not_included',
      detail: reconciliation.skippedReason
        ? `Workflow reconciliation was skipped: ${reconciliation.skippedReason}`
        : 'Workflow reconciliation was not included.',
      execution,
      reconciliation,
      beforeSessionSnapshot,
      afterSessionSnapshot: params.session.getSnapshot(),
    })
  }

  if (!reconciliation.transitionProposal) {
    return buildSkippedResult({
      status: 'skipped',
      skippedReason: 'missing_transition_proposal',
      detail: 'Workflow reconciliation did not produce a transition proposal.',
      execution,
      reconciliation,
      beforeSessionSnapshot,
      afterSessionSnapshot: params.session.getSnapshot(),
    })
  }

  const transitionEvent = params.session.transition({
    proposal: reconciliation.transitionProposal,
    hostDecision: params.hostDecision,
  })

  return {
    scope: 'current_run_plan_host_session_workflow_run',
    status: transitionEvent.transitionRecord.transition.status,
    execution,
    reconciliation,
    transitionEvent,
    beforeSessionSnapshot,
    afterSessionSnapshot: params.session.getSnapshot(),
    problems: [],
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function buildSkippedResult(params: {
  status: 'skipped'
  skippedReason: PlanHostSessionWorkflowRunSkippedReason
  detail: string
  execution: PlanWorkflowExecutionResult
  reconciliation: PlanWorkflowReconciliationResult
  beforeSessionSnapshot: PlanHostRuntimeSessionSnapshot
  afterSessionSnapshot: PlanHostRuntimeSessionSnapshot
}): PlanHostSessionWorkflowRunResult {
  return {
    scope: 'current_run_plan_host_session_workflow_run',
    status: params.status,
    execution: params.execution,
    reconciliation: params.reconciliation,
    beforeSessionSnapshot: params.beforeSessionSnapshot,
    afterSessionSnapshot: params.afterSessionSnapshot,
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
