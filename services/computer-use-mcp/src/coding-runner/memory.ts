import type { ComputerUseServerRuntime } from '../server/runtime'
import type { CodingTaskKind, RunState } from '../state'
import type { TaskMemoryExtraction } from '../task-memory/types'

const MAX_EVIDENCE_PIN_CHARS = 240
const EVIDENCE_PIN_CONTROL_CHARS_RE = /[\u0000-\u0008\v\f\u000E-\u001F\u007F]/g
const EVIDENCE_PIN_WHITESPACE_RE = /\s+/g
const PATCH_APPLIED_SUMMARY_RE = /^Patch applied successfully to (.+)\. Readback verified\.$/

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
    evidencePins: [
      formatEvidencePin(
        `budget_exhausted:maxSteps=${params.maxSteps}`,
        params.lastToolName ? `lastTool=${params.lastToolName}` : '',
      ),
    ],
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
    evidencePins: [
      formatEvidencePin(`tool_failure:${params.toolName}`, params.summary),
    ],
  }
}

export function buildVerificationGateFailureMemory(params: {
  reasonCode?: string
  summary: string
}): TaskMemoryExtraction {
  return {
    status: 'active',
    currentStep: 'Recover from verification gate failure',
    recentFailureReason: params.summary,
    nextStep: 'Use the verification gate reason to gather missing runtime evidence before reporting completed again.',
    evidencePins: [
      formatEvidencePin(`verification_gate_failed:${params.reasonCode ?? 'unknown'}`, params.summary),
    ],
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

export function buildArchiveRecallFinalizationMemory(summary: string): TaskMemoryExtraction {
  const reason = `Archive recall was denied while finalizing analysis/report: ${summary}`.slice(0, 800)
  return {
    status: 'active',
    currentStep: 'Finalize analysis/report after denied archive recall',
    recentFailureReason: reason,
    nextStep: 'Do not retry archive search/read. Synthesize from visible current context and prior read evidence, call coding_compress_context, then call coding_report_status with filesTouched empty.',
    evidencePins: [
      formatEvidencePin('archive_recall_denied', summary),
    ],
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
    evidencePins: [
      formatEvidencePin(`reported_status:${params.status}`, params.summary ?? ''),
    ],
  }
}

export function buildSuccessfulToolEvidenceMemory(params: {
  toolName: string
  toolArgs: unknown
  toolBackend: unknown
  state: RunState
}): TaskMemoryExtraction | undefined {
  switch (params.toolName) {
    case 'coding_apply_patch':
      return buildApplyPatchEvidenceMemory(params.toolArgs, params.toolBackend, params.state)
    case 'terminal_exec':
      return buildTerminalExecEvidenceMemory(params.toolArgs, params.state)
    case 'coding_review_changes':
      return buildReviewChangesEvidenceMemory(params.toolBackend, params.state)
    default:
      return undefined
  }
}

export function formatEvidencePin(prefix: string, body: string, maxChars = MAX_EVIDENCE_PIN_CHARS): string {
  const cleaned = `${prefix}${body.trim() ? `: ${body}` : ''}`
    .replace(EVIDENCE_PIN_CONTROL_CHARS_RE, ' ')
    .replace(EVIDENCE_PIN_WHITESPACE_RE, ' ')
    .trim()

  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
}

function buildApplyPatchEvidenceMemory(
  toolArgs: unknown,
  toolBackend: unknown,
  state: RunState,
): TaskMemoryExtraction | undefined {
  const candidatePaths = extractApplyPatchTargetPathCandidates(toolArgs, toolBackend)
  if (candidatePaths.length === 0)
    return undefined

  const edit = [...(state.coding?.recentEdits ?? [])]
    .reverse()
    .find(edit => candidatePaths.includes(edit.path))
  const proof = edit?.mutationProof

  if (!proof?.readbackVerified || proof.beforeHash === proof.afterHash)
    return undefined

  return {
    evidencePins: [
      formatEvidencePin(
        `edit_proof:${edit.path}`,
        `readbackVerified=${proof.readbackVerified} beforeHash!=afterHash summary=${edit.summary ?? 'patch applied'}`,
      ),
    ],
  }
}

function buildTerminalExecEvidenceMemory(toolArgs: unknown, state: RunState): TaskMemoryExtraction | undefined {
  const command = stringProp(toolArgs, 'command')
  const result = state.lastTerminalResult
  if (!command || !result || result.command !== command)
    return undefined

  return {
    evidencePins: [
      formatEvidencePin(
        `terminal_result:${command}`,
        `exitCode=${result.exitCode} timedOut=${result.timedOut}`,
      ),
    ],
  }
}

function buildReviewChangesEvidenceMemory(toolBackend: unknown, state: RunState): TaskMemoryExtraction | undefined {
  const review = state.coding?.lastChangeReview
  if (!review)
    return undefined

  const backendStatus = stringProp(toolBackend, 'status')
  if (!backendStatus || backendStatus !== review.status)
    return undefined

  const validation = review.validationCommand || review.validationSummary
  return {
    evidencePins: [
      formatEvidencePin(
        `change_review:${review.status}`,
        `validation=${validation} unresolved=${review.unresolvedIssues.length}`,
      ),
    ],
  }
}

function extractApplyPatchTargetPathCandidates(toolArgs: unknown, toolBackend: unknown): string[] {
  return [
    stringProp(toolArgs, 'filePath'),
    stringProp(toolBackend, 'file'),
    extractPatchAppliedPath(stringProp(toolBackend, 'diff')),
  ].filter((path): path is string => Boolean(path) && path !== 'auto')
}

function extractPatchAppliedPath(summary: string | undefined): string | undefined {
  const match = summary?.match(PATCH_APPLIED_SUMMARY_RE)
  return match?.[1]
}

function stringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object')
    return undefined
  const prop = (value as Record<string, unknown>)[key]
  return typeof prop === 'string' && prop.trim().length > 0 ? prop.trim() : undefined
}
