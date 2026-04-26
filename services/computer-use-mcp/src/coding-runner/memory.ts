import type { ComputerUseServerRuntime } from '../server/runtime'
import type { CodingTaskKind } from '../state'
import type { TaskMemoryExtraction } from '../task-memory/types'

export function syncCodingRunnerTaskMemory(params: {
  runtime: ComputerUseServerRuntime
  runId: string
  source: string
  sourceIndex: number
  extraction: TaskMemoryExtraction
}): void {
  const result = params.runtime.taskMemory.update(params.extraction, {
    sourceTurnId: `${params.runId}:${params.source}`,
    sourceTurnIndex: params.sourceIndex,
  })

  if (result.status === 'updated')
    params.runtime.stateManager.updateTaskMemory(result.taskMemory)
}

export function buildTaskStartMemory(taskGoal: string, workspacePath: string, taskKind: CodingTaskKind = 'edit'): TaskMemoryExtraction {
  const isAnalysisReport = taskKind === 'analysis_report'

  return {
    status: 'active',
    goal: taskGoal,
    confirmedFacts: [
      `Workspace root: ${workspacePath}`,
      'coding_review_workspace and coding_capture_validation_baseline already completed before the model loop.',
    ],
    currentStep: isAnalysisReport ? 'Bootstrap and inspect workspace for analysis/report' : 'Bootstrap and inspect workspace',
    completionCriteria: isAnalysisReport
      ? [
          'For analysis/report tasks, do not edit files and do not call coding_apply_patch.',
          'Read or search source files, create a structured analysis artifact with coding_compress_context or impact/investigation evidence, then call coding_report_status(completed) with filesTouched empty.',
          'Do not call coding_report_status(completed) until the report summary is source-backed and substantive.',
        ]
      : [
          'For edit tasks, complete by applying changes with coding_apply_patch, running a relevant validation command, calling coding_review_changes, then calling coding_report_status.',
          'Do not call coding_report_status(completed) until validation and coding_review_changes both support completion.',
        ],
    nextStep: isAnalysisReport
      ? 'Use coding search/read/analysis tools inside the reviewed workspace; do not edit files, re-review, or switch workspace roots.'
      : 'Use coding search/read/edit tools inside the reviewed workspace; do not re-review or switch workspace roots.',
  }
}

export function buildStepMemory(stepIndex: number, maxSteps: number): TaskMemoryExtraction {
  return {
    status: 'active',
    currentStep: `Coding runner step ${stepIndex}/${maxSteps}`,
  }
}

export function buildBudgetPressureMemory(stepIndex: number, maxSteps: number): TaskMemoryExtraction {
  const remainingStepsIncludingCurrent = maxSteps - stepIndex

  if (remainingStepsIncludingCurrent <= 1) {
    return {
      status: 'active',
      currentStep: `Final coding runner step ${stepIndex + 1}/${maxSteps}`,
      recentFailureReason: 'Runner step budget is at the final step; broad exploration can no longer be recovered within this run.',
      nextStep: 'Do not start new exploration. Call coding_report_status(completed) only if runtime evidence supports it; otherwise report failed or blocked.',
    }
  }

  return {
    status: 'active',
    currentStep: `Coding runner budget pressure: step ${stepIndex + 1}/${maxSteps}`,
    recentFailureReason: `Only ${remainingStepsIncludingCurrent} runner steps remain, so repeated exploration risks budget exhaustion.`,
    nextStep: 'Stop broad exploration. If evidence is missing, perform at most one high-value validation or final check; otherwise prepare the final report.',
  }
}

export function buildBudgetExhaustedMemory(params: {
  maxSteps: number
  lastToolName?: string
  lastFailureSummary?: string
}): TaskMemoryExtraction {
  const suffix = params.lastToolName
    ? ` Last tool: ${params.lastToolName}${params.lastFailureSummary ? ` — ${params.lastFailureSummary}` : ''}`
    : ''

  return {
    status: 'blocked',
    currentStep: 'Coding runner stopped after exhausting its step budget',
    blockers: [`BUDGET_EXHAUSTED: runner reached maxSteps=${params.maxSteps} without an accepted terminal report.${suffix}`],
    recentFailureReason: `BUDGET_EXHAUSTED: maxSteps=${params.maxSteps}.${suffix}`,
    nextStep: 'Start a fresh run with narrower scope or report failed/blocked earlier when evidence is insufficient.',
  }
}

export function buildToolFailureMemory(params: {
  toolName: string
  summary: string
}): TaskMemoryExtraction {
  const reason = `${params.toolName} failed: ${params.summary}`.slice(0, 800)
  return {
    status: 'active',
    currentStep: `Recover from failed ${params.toolName}`,
    recentFailureReason: reason,
    nextStep: 'Use the failure details to adjust the next action instead of repeating the same call.',
  }
}

export function buildTextOnlyReportRequiredMemory(summary: string): TaskMemoryExtraction {
  const reason = `Assistant produced a text-only response instead of calling coding_report_status: ${summary}`.slice(0, 800)
  return {
    status: 'active',
    currentStep: 'Recover from missing terminal report',
    recentFailureReason: reason,
    nextStep: 'Do not answer with text only. Call coding_report_status(completed) if runtime evidence supports completion; otherwise call coding_report_status(failed) or coding_report_status(blocked).',
  }
}

export function buildReportStatusMemory(params: {
  status: 'completed' | 'failed' | 'blocked'
  summary?: string
  filesTouched?: string[]
  commandsRun?: string[]
  checks?: string[]
  nextStep?: string
}): TaskMemoryExtraction {
  const taskStatus = params.status === 'completed'
    ? 'done'
    : 'blocked'

  return {
    status: taskStatus,
    currentStep: params.status === 'completed' ? 'Task reported complete' : 'Task reported blocked or failed',
    confirmedFacts: params.checks,
    artifacts: [
      ...(params.filesTouched ?? []).map(file => ({
        label: file,
        value: file,
        kind: 'file' as const,
      })),
      ...(params.commandsRun ?? []).map(command => ({
        label: command,
        value: command,
        kind: 'tool' as const,
      })),
    ],
    blockers: params.status === 'completed' || !params.summary ? undefined : [params.summary],
    nextStep: params.status === 'completed' ? null : params.nextStep,
    recentFailureReason: params.status === 'completed' ? null : params.summary,
  }
}
