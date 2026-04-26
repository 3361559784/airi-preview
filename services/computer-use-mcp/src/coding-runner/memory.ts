import type { ComputerUseServerRuntime } from '../server/runtime'
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

export function buildTaskStartMemory(taskGoal: string): TaskMemoryExtraction {
  return {
    status: 'active',
    goal: taskGoal,
    currentStep: 'Bootstrap and inspect workspace',
    nextStep: 'Run deterministic coding preflight checks',
  }
}

export function buildStepMemory(stepIndex: number, maxSteps: number): TaskMemoryExtraction {
  return {
    status: 'active',
    currentStep: `Coding runner step ${stepIndex}/${maxSteps}`,
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
