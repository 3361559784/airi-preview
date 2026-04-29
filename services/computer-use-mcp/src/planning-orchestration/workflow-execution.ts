import type { ExecuteAction } from '../server/action-executor'
import type { RunStateManager } from '../state'
import type {
  AcquirePtyForStep,
  ExecutePrepTool,
  WorkflowExecutionResult,
} from '../workflows/engine'
import type { PlanWorkflowMappingResult } from './workflow-mapping'

import { executeWorkflow } from '../workflows'

export type PlanWorkflowExecutionStatus = WorkflowExecutionResult['status'] | 'blocked'

export interface PlanWorkflowExecutionProblem {
  reason: 'mapping_not_mapped' | 'missing_workflow' | 'empty_workflow'
  detail: string
}

export interface PlanWorkflowExecutionResult {
  scope: 'current_run_plan_workflow_execution'
  status: PlanWorkflowExecutionStatus
  executed: boolean
  workflowResult?: WorkflowExecutionResult
  problems: PlanWorkflowExecutionProblem[]
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Executes a previously mapped plan workflow through the existing workflow
 * engine. This is the first planning-to-workflow runtime boundary: it refuses
 * unmapped plans and does not infer workflow params or bypass engine approval.
 */
export async function executeMappedPlanWorkflow(params: {
  mapping: PlanWorkflowMappingResult
  executeAction: ExecuteAction
  executePrepTool?: ExecutePrepTool
  stateManager: RunStateManager
  refreshState?: () => Promise<void>
  overrides?: Record<string, unknown>
  autoApproveSteps?: boolean
  acquirePty?: AcquirePtyForStep
}): Promise<PlanWorkflowExecutionResult> {
  const problems = getExecutionProblems(params.mapping)

  if (problems.length > 0) {
    return {
      scope: 'current_run_plan_workflow_execution',
      status: 'blocked',
      executed: false,
      problems,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    }
  }

  const workflowResult = await executeWorkflow({
    workflow: params.mapping.workflow!,
    executeAction: params.executeAction,
    executePrepTool: params.executePrepTool,
    stateManager: params.stateManager,
    refreshState: params.refreshState,
    overrides: params.overrides,
    autoApproveSteps: params.autoApproveSteps ?? false,
    acquirePty: params.acquirePty,
  })

  return {
    scope: 'current_run_plan_workflow_execution',
    status: workflowResult.status,
    executed: true,
    workflowResult,
    problems: [],
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function getExecutionProblems(mapping: PlanWorkflowMappingResult): PlanWorkflowExecutionProblem[] {
  const problems: PlanWorkflowExecutionProblem[] = []

  if (mapping.status !== 'mapped') {
    problems.push({
      reason: 'mapping_not_mapped',
      detail: `Plan workflow mapping status is ${mapping.status}.`,
    })
  }

  if (!mapping.workflow) {
    problems.push({
      reason: 'missing_workflow',
      detail: 'Plan workflow mapping did not include a WorkflowDefinition.',
    })
  }
  else if (mapping.workflow.steps.length === 0) {
    problems.push({
      reason: 'empty_workflow',
      detail: 'Mapped plan workflow must contain at least one step before execution.',
    })
  }

  return problems
}
