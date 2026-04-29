import type { WorkflowDefinition, WorkflowStepKind, WorkflowStepTemplate } from '../workflows'
import type { PlanRouteWorkflowHandoff } from './workflow-handoff'

export type PlanWorkflowMappingStatus = 'mapped' | 'blocked'

export interface PlanWorkflowStepMappingInput {
  stepId: string
  kind: WorkflowStepKind
  params: Record<string, unknown>
  label?: string
  description?: string
  critical?: boolean
  skippable?: boolean
  terminal?: WorkflowStepTemplate['terminal']
}

export interface PlanWorkflowMappingProblem {
  reason:
    | 'handoff_not_ready'
    | 'missing_mapping_for_ready_step'
    | 'mapping_for_non_ready_step'
    | 'mapping_for_unknown_step'
    | 'duplicate_mapping_for_step'
    | 'incompatible_workflow_step_kind'
  stepId?: string
  detail: string
}

export interface PlanWorkflowMappedStepRef {
  stepId: string
  workflowStepIndex: number
  workflowStepLabel: string
  workflowStepKind: WorkflowStepKind
}

export interface PlanWorkflowMappingResult {
  scope: 'current_run_plan_workflow_mapping'
  status: PlanWorkflowMappingStatus
  workflow?: WorkflowDefinition
  mappedSteps: PlanWorkflowMappedStepRef[]
  problems: PlanWorkflowMappingProblem[]
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

const TOOL_TO_WORKFLOW_STEP_KINDS: ReadonlyMap<string, readonly WorkflowStepKind[]> = new Map([
  ['coding_review_workspace', ['coding_review_workspace']],
  ['coding_read_file', ['coding_read_file']],
  ['coding_apply_patch', ['coding_apply_patch']],
  ['coding_compress_context', ['coding_compress_context']],
  ['coding_report_status', ['coding_report_status']],
  ['coding_search_text', ['coding_search_text']],
  ['coding_search_symbol', ['coding_search_symbol']],
  ['coding_find_references', ['coding_find_references']],
  ['coding_analyze_impact', ['coding_analyze_impact']],
  ['coding_validate_hypothesis', ['coding_validate_hypothesis']],
  ['coding_select_target', ['coding_select_target']],
  ['coding_plan_changes', ['coding_plan_changes']],
  ['coding_review_changes', ['coding_review_changes']],
  ['coding_diagnose_changes', ['coding_diagnose_changes']],
  ['coding_capture_validation_baseline', ['coding_capture_validation_baseline']],
  ['terminal_exec', ['run_command', 'run_command_read_result']],
  ['pty_send_input', ['pty_send_input']],
  ['pty_read_screen', ['pty_read_screen', 'pty_wait_for_output']],
  ['pty_destroy', ['pty_destroy_session']],
  ['desktop_observe_windows', ['observe_windows']],
  ['desktop_screenshot', ['take_screenshot']],
  ['desktop_focus_app', ['ensure_app']],
  ['desktop_open_app', ['ensure_app']],
  ['desktop_click', ['click_element']],
  ['desktop_type_text', ['type_into']],
  ['desktop_press_keys', ['press_shortcut']],
  ['desktop_wait', ['wait']],
])

/**
 * Converts ready handoff steps into a WorkflowDefinition only when the caller
 * provides explicit workflow kinds and params. This function never executes the
 * workflow and never infers params from natural-language plan intent.
 */
export function mapPlanHandoffToWorkflowDefinition(params: {
  handoff: PlanRouteWorkflowHandoff
  mappings: readonly PlanWorkflowStepMappingInput[]
  workflowId: string
  name: string
  description?: string
  maxRetries?: number
}): PlanWorkflowMappingResult {
  const problems = findMappingProblems(params.handoff, params.mappings)
  if (params.handoff.status !== 'ready_for_mapping') {
    problems.push({
      reason: 'handoff_not_ready',
      detail: `Plan route handoff status is ${params.handoff.status}.`,
    })
  }

  if (problems.length > 0) {
    return {
      scope: 'current_run_plan_workflow_mapping',
      status: 'blocked',
      mappedSteps: [],
      problems,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    }
  }

  const mappingByStepId = new Map(params.mappings.map(mapping => [mapping.stepId, mapping]))
  const readySteps = params.handoff.steps.filter(step => step.handoffStatus === 'ready_for_mapping')
  const steps = readySteps
    .map((step): WorkflowStepTemplate => {
      const mapping = mappingByStepId.get(step.stepId)!
      return {
        label: mapping.label ?? step.stepId,
        kind: mapping.kind,
        description: mapping.description ?? `Mapped plan step ${step.stepId}.`,
        params: { ...mapping.params },
        ...(mapping.critical !== undefined ? { critical: mapping.critical } : {}),
        ...(mapping.skippable !== undefined ? { skippable: mapping.skippable } : {}),
        ...(mapping.terminal ? { terminal: { ...mapping.terminal } } : {}),
      }
    })
  const mappedSteps = readySteps.map((step, workflowStepIndex): PlanWorkflowMappedStepRef => {
    const mapping = mappingByStepId.get(step.stepId)!
    return {
      stepId: step.stepId,
      workflowStepIndex,
      workflowStepLabel: mapping.label ?? step.stepId,
      workflowStepKind: mapping.kind,
    }
  })

  return {
    scope: 'current_run_plan_workflow_mapping',
    status: 'mapped',
    workflow: {
      id: params.workflowId,
      name: params.name,
      description: params.description ?? `Mapped workflow for ${params.name}.`,
      steps,
      maxRetries: params.maxRetries ?? 2,
    },
    mappedSteps,
    problems: [],
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function findMappingProblems(
  handoff: PlanRouteWorkflowHandoff,
  mappings: readonly PlanWorkflowStepMappingInput[],
): PlanWorkflowMappingProblem[] {
  const problems: PlanWorkflowMappingProblem[] = []
  const readyStepIds = new Set(handoff.readyForMappingStepIds)
  const knownStepIds = new Set(handoff.steps.map(step => step.stepId))
  const mappingCounts = new Map<string, number>()

  for (const mapping of mappings)
    mappingCounts.set(mapping.stepId, (mappingCounts.get(mapping.stepId) ?? 0) + 1)

  for (const stepId of readyStepIds) {
    if (!mappingCounts.has(stepId)) {
      problems.push({
        reason: 'missing_mapping_for_ready_step',
        stepId,
        detail: `Ready handoff step ${stepId} has no explicit workflow mapping.`,
      })
    }
  }

  for (const mapping of mappings) {
    if (!knownStepIds.has(mapping.stepId)) {
      problems.push({
        reason: 'mapping_for_unknown_step',
        stepId: mapping.stepId,
        detail: `Workflow mapping references unknown plan step: ${mapping.stepId}`,
      })
      continue
    }

    if (!readyStepIds.has(mapping.stepId)) {
      problems.push({
        reason: 'mapping_for_non_ready_step',
        stepId: mapping.stepId,
        detail: `Workflow mapping references non-ready handoff step: ${mapping.stepId}`,
      })
      continue
    }

    const candidate = handoff.steps.find(step => step.stepId === mapping.stepId)
    if (candidate && !isWorkflowKindCompatible(candidate.candidateToolNames, mapping.kind)) {
      problems.push({
        reason: 'incompatible_workflow_step_kind',
        stepId: mapping.stepId,
        detail: `Workflow kind ${mapping.kind} is not compatible with candidate tools: ${candidate.candidateToolNames.join(', ') || 'none'}`,
      })
    }
  }

  for (const [stepId, count] of mappingCounts) {
    if (count > 1) {
      problems.push({
        reason: 'duplicate_mapping_for_step',
        stepId,
        detail: `Workflow mapping contains ${count} entries for step: ${stepId}`,
      })
    }
  }

  return problems
}

function isWorkflowKindCompatible(candidateToolNames: readonly string[], kind: WorkflowStepKind): boolean {
  return candidateToolNames.some((toolName) => {
    const compatibleKinds = TOOL_TO_WORKFLOW_STEP_KINDS.get(toolName)
    return compatibleKinds?.includes(kind) ?? false
  })
}
