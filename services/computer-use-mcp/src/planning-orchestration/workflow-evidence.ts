import type { WorkflowStepResult } from '../workflows/engine'
import type { PlanEvidenceObservation } from './reconciliation'
import type { PlanWorkflowExecutionResult } from './workflow-execution'
import type { PlanWorkflowMappedStepRef, PlanWorkflowMappingResult } from './workflow-mapping'

import { resolveStepAction } from '../workflows'

const DEFAULT_MAX_SUMMARY_CHARS = 500

export interface BuildPlanEvidenceObservationsFromWorkflowExecutionParams {
  mapping: PlanWorkflowMappingResult
  execution: PlanWorkflowExecutionResult
  maxSummaryChars?: number
}

/**
 * Converts mapped workflow step results back into current-run plan evidence.
 * This bridge is deliberately weaker than verification: it emits only
 * `tool_result` observations and never manufactures gate or approval evidence.
 */
export function buildPlanEvidenceObservationsFromWorkflowExecution(
  params: BuildPlanEvidenceObservationsFromWorkflowExecutionParams,
): PlanEvidenceObservation[] {
  if (params.mapping.status !== 'mapped' || !params.mapping.workflow)
    return []
  if (!params.execution.executed || !params.execution.workflowResult)
    return []

  const maxSummaryChars = params.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS
  return params.mapping.mappedSteps.map((mappedStep) => {
    const stepResult = params.execution.workflowResult!.stepResults[mappedStep.workflowStepIndex]
    if (!stepResult) {
      return {
        id: buildObservationId(params.mapping.workflow!.id, mappedStep.workflowStepIndex),
        stepId: mappedStep.stepId,
        source: 'tool_result',
        status: 'failed',
        summary: truncateSummary(
          `Workflow step ${mappedStep.workflowStepIndex + 1} (${mappedStep.workflowStepKind}) produced no step result.`,
          maxSummaryChars,
        ),
        toolName: mappedStep.workflowStepKind,
        reasonCode: 'workflow_step_missing_result',
      }
    }

    return {
      id: buildObservationId(params.mapping.workflow!.id, mappedStep.workflowStepIndex),
      stepId: mappedStep.stepId,
      source: 'tool_result',
      status: stepResult.succeeded ? 'satisfied' : 'failed',
      summary: truncateSummary(buildStepResultSummary(mappedStep, stepResult), maxSummaryChars),
      toolName: resolveWorkflowStepToolName(stepResult),
      reasonCode: `workflow_step_${stepResult.status}`,
    }
  })
}

function buildObservationId(workflowId: string, workflowStepIndex: number): string {
  return `workflow:${workflowId}:step:${workflowStepIndex + 1}`
}

function buildStepResultSummary(
  mappedStep: PlanWorkflowMappedStepRef,
  stepResult: WorkflowStepResult,
): string {
  return [
    `Workflow step ${mappedStep.workflowStepIndex + 1}`,
    `planStep=${mappedStep.stepId}`,
    `kind=${stepResult.step.kind}`,
    `status=${stepResult.status}`,
    stepResult.explanation,
  ].filter(Boolean).join(' | ')
}

function resolveWorkflowStepToolName(stepResult: WorkflowStepResult): string {
  return resolveStepAction(stepResult.step)?.kind ?? stepResult.step.kind
}

function truncateSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars)
    return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}...`
}
