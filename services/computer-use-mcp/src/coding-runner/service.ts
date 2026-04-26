import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { CodingVerificationGateDecision } from '../coding/verification-gate'
import type { CodingRunnerEventEmitter } from './events'
import type { CodingRunner, CodingRunnerConfig, CodingRunnerDependencies, CodingRunnerResult, CodingRunnerTurnResult, RunCodingTaskParams } from './types'

import { randomUUID } from 'node:crypto'

import { errorMessageFrom } from '@moeru/std'
import { generateText } from '@xsai/generate-text'

import { evaluateCodingVerificationGate } from '../coding/verification-gate'
import { createCodingRunnerEventEmitter } from './events'
import { buildReportStatusMemory, buildStepMemory, buildTaskStartMemory, buildToolFailureMemory, syncCodingRunnerTaskMemory } from './memory'
import { buildXsaiCodingTools } from './tool-runtime'
import { createTranscriptRuntime, projectForCodingTurn } from './transcript-runtime'

export class CodingRunnerImpl implements CodingRunner {
  constructor(
    private readonly config: CodingRunnerConfig,
    private readonly deps: CodingRunnerDependencies,
  ) {}

  async runCodingTask(params: RunCodingTaskParams): Promise<CodingRunnerResult> {
    const { workspacePath, taskGoal, maxSteps, stepTimeoutMs } = params
    // V1: task_id = run_id; single task per invocation
    const runId = params.runId ?? randomUUID()
    const taskId = runId
    const { runtime, executeAction } = this.deps
    const actualMaxSteps = maxSteps ?? this.config.maxSteps
    const actualStepTimeoutMs = stepTimeoutMs ?? this.config.stepTimeoutMs
    const events = createCodingRunnerEventEmitter(runId, params.onEvent)
    const finish = async (result: CodingRunnerResult): Promise<CodingRunnerResult> => {
      await events.emit('run_finished', {
        finalStatus: result.status,
        totalSteps: result.totalSteps,
        error: result.error,
      })
      return result
    }

    await events.emit('run_started', {
      workspacePath,
      taskGoal,
      maxSteps: actualMaxSteps,
      stepTimeoutMs: actualStepTimeoutMs,
    })

    const { store: transcriptStore, archiveStore, workspaceMemoryStore } = await createTranscriptRuntime(
      runtime,
      runId,
      workspacePath,
      this.deps.useInMemoryTranscript ?? false,
    )
    const xsaiTools = await buildXsaiCodingTools(runtime, executeAction, {
      events,
      archiveStore,
      runId,
      workspaceMemoryStore,
    })

    // Preflight 1: Review Workspace
    await events.emit('preflight_started', { name: 'coding_review_workspace' })
    const reviewResult = await executeAction(
      {
        kind: 'coding_review_workspace',
        input: { workspacePath },
      } as any,
      'coding_review_workspace',
    )
    await events.emit('preflight_completed', {
      name: 'coding_review_workspace',
      ok: !reviewResult.isError,
      error: reviewResult.isError ? JSON.stringify(reviewResult.content) : undefined,
    })

    if (reviewResult.isError) {
      return finish({
        runId,
        status: 'failed',
        totalSteps: 0,
        turns: [],
        error: `Bootstrap Failed: coding_review_workspace returned error.\n\n${JSON.stringify(reviewResult.content)}`,
      })
    }

    // Preflight 2: Capture Validation Baseline
    await events.emit('preflight_started', { name: 'coding_capture_validation_baseline' })
    const baselineResult = await executeAction(
      {
        kind: 'coding_capture_validation_baseline',
        input: { workspacePath, createTemporaryWorktree: true },
      } as any,
      'coding_capture_validation_baseline',
    )
    await events.emit('preflight_completed', {
      name: 'coding_capture_validation_baseline',
      ok: !baselineResult.isError,
      error: baselineResult.isError ? JSON.stringify(baselineResult.content) : undefined,
    })

    if (baselineResult.isError) {
      return finish({
        runId,
        status: 'failed',
        totalSteps: 0,
        turns: [],
        error: `Bootstrap Failed: coding_capture_validation_baseline returned error.\n\n${JSON.stringify(baselineResult.content)}`,
      })
    }

    syncCodingRunnerTaskMemory({
      runtime,
      runId,
      source: 'task-start',
      sourceIndex: 0,
      extraction: buildTaskStartMemory(taskGoal),
    })

    await transcriptStore.appendUser(taskGoal)

    let totalSteps = 0
    let finalStatus: CodingRunnerResult['status'] = 'timeout'
    let finalError: string | undefined
    const turns: CodingRunnerTurnResult[] = []

    try {
      for (let step = 0; step < actualMaxSteps; step++) {
        totalSteps = step + 1
        let messages: any[]
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(new Error('STEP_TIMEOUT')), actualStepTimeoutMs)
        await events.emit('step_started', { stepIndex: step + 1, maxSteps: actualMaxSteps })
        syncCodingRunnerTaskMemory({
          runtime,
          runId,
          source: `step-${step + 1}`,
          sourceIndex: (step + 1) * 10,
          extraction: buildStepMemory(step + 1, actualMaxSteps),
        })

        const workspaceMemoryContext = workspaceMemoryStore.toContextString(taskGoal)
        const projection = projectForCodingTurn(transcriptStore, this.config.systemPromptBase, runtime, {
          workspaceMemoryContext,
        })
        const projectedLength = projection.messages.length

        // Write archive candidates from this projection turn (deduped)
        await archiveStore.writeCandidates(projection.archiveCandidates, runId, taskId)

        try {
          const result = await generateText({
            model: this.config.model,
            baseURL: this.config.baseURL,
            apiKey: this.config.apiKey,
            tools: xsaiTools as any,
            system: projection.system,
            messages: projection.messages as any,
            abortSignal: controller.signal as any,
          })
          messages = result.messages

          // Delta append
          const newMessages = messages.slice(projectedLength)
          for (const msg of newMessages) {
            await transcriptStore.appendRawMessage(msg as any)
          }
        }
        catch (stepErr: any) {
          clearTimeout(timeoutId)
          if (stepErr?.message?.includes('STEP_TIMEOUT') || stepErr?.name === 'AbortError') {
            finalStatus = 'timeout'
            turns.push({ role: 'timeout' })
            await events.emit('step_timeout', { stepIndex: step + 1, timeoutMs: actualStepTimeoutMs })
            break
          }
          throw stepErr
        }
        finally {
          clearTimeout(timeoutId)
        }

        if (messages.length > 0) {
          const lastMsg = messages.at(-1)
          const lastContent = typeof lastMsg.content === 'string'
            ? lastMsg.content
            : JSON.stringify(lastMsg.content || '')

          if (lastMsg.role === 'tool') {
            let toolName = 'unknown'
            let toolArgs: any
            let resultOk = true
            let reportStatus: 'completed' | 'failed' | 'blocked' | undefined
            let failureSummary: string | undefined
            try {
              const parsed = JSON.parse(lastContent)
              toolName = parsed.tool || 'unknown'
              toolArgs = parsed.args
              resultOk = parsed.ok !== false
              reportStatus = parseReportStatus(parsed)
              failureSummary = parseToolFailureSummary(parsed)
            }
            catch {}

            turns.push({
              role: 'tool',
              toolName,
              toolArgs,
              resultOk,
              rawText: lastContent,
            })

            if (!resultOk) {
              syncCodingRunnerTaskMemory({
                runtime,
                runId,
                source: `tool-failure-${step + 1}`,
                sourceIndex: (step + 1) * 10 + 1,
                extraction: buildToolFailureMemory({
                  toolName,
                  summary: failureSummary ?? lastContent.slice(0, 500),
                }),
              })
            }

            if (toolName === 'coding_report_status') {
              if (resultOk && reportStatus) {
                const reportArgs = isRecord(toolArgs) ? toolArgs : {}
                syncCodingRunnerTaskMemory({
                  runtime,
                  runId,
                  source: `report-${step + 1}`,
                  sourceIndex: (step + 1) * 10 + 1,
                  extraction: buildReportStatusMemory({
                    status: reportStatus,
                    summary: stringValue(reportArgs.summary),
                    filesTouched: stringArrayValue(reportArgs.filesTouched),
                    commandsRun: stringArrayValue(reportArgs.commandsRun),
                    checks: stringArrayValue(reportArgs.checks),
                    nextStep: stringValue(reportArgs.nextStep),
                  }),
                })
                await events.emit('report_status', {
                  status: reportStatus,
                  summary: stringValue(reportArgs.summary),
                })
                if (reportStatus === 'completed') {
                  const gateOutcome = await applyCodingRunnerVerificationGate({
                    runtime,
                    executeAction,
                    workspacePath,
                    events,
                    reportedStatus: reportStatus,
                  })

                  if (gateOutcome.passed) {
                    finalStatus = 'completed'
                  }
                  else {
                    finalStatus = 'failed'
                    finalError = buildVerificationGateFailureMessage(
                      gateOutcome.decision,
                      'recheckExplanation' in gateOutcome ? gateOutcome.recheckExplanation : undefined,
                    )
                    syncCodingRunnerTaskMemory({
                      runtime,
                      runId,
                      source: `verification-gate-${step + 1}`,
                      sourceIndex: (step + 1) * 10 + 2,
                      extraction: buildToolFailureMemory({
                        toolName: 'coding_report_status',
                        summary: finalError,
                      }),
                    })
                  }
                }
                else {
                  finalStatus = 'failed'
                }
                break
              }
            }
          }
          else if (lastMsg.role === 'assistant') {
            turns.push({
              role: 'assistant',
              rawText: lastContent,
            })
            await events.emit('assistant_message', { text: lastContent })
          }
        }

        // Stop condition: assistant gives text without tool_calls
        if (messages.length > 0 && messages.at(-1).role !== 'tool') {
          // If we exit on text-only without a terminal report, it is a failure
          finalStatus = 'failed'
          break
        }
      }
    }
    catch (err: unknown) {
      finalStatus = 'crash'
      const error = errorMessageFrom(err) || String(err)
      await events.emit('run_crashed', { totalSteps, error })
      return finish({
        runId,
        status: finalStatus,
        totalSteps,
        turns,
        error,
      })
    }

    return finish({
      runId,
      status: finalStatus,
      totalSteps,
      transcriptMetadata: projectForCodingTurn(transcriptStore, this.config.systemPromptBase, runtime, {
        workspaceMemoryContext: workspaceMemoryStore.toContextString(taskGoal),
      }).metadata,
      turns,
      error: finalError,
    })
  }
}

export function createCodingRunner(config: CodingRunnerConfig, deps: CodingRunnerDependencies): CodingRunner {
  return new CodingRunnerImpl(config, deps)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return strings.length > 0 ? strings : undefined
}

function parseReportStatus(parsed: unknown): 'completed' | 'failed' | 'blocked' | undefined {
  if (!isRecord(parsed))
    return undefined

  const backend = parsed.backend
  if (isRecord(backend) && isTerminalReportStatus(backend.status))
    return backend.status

  if (isTerminalReportStatus(parsed.status))
    return parsed.status

  return undefined
}

function isTerminalReportStatus(value: unknown): value is 'completed' | 'failed' | 'blocked' {
  return value === 'completed' || value === 'failed' || value === 'blocked'
}

function parseToolFailureSummary(parsed: unknown): string | undefined {
  if (!isRecord(parsed))
    return undefined

  if (typeof parsed.error === 'string' && parsed.error.trim().length > 0)
    return parsed.error.trim().slice(0, 500)
  if (typeof parsed.summary === 'string' && parsed.summary.trim().length > 0)
    return parsed.summary.trim().slice(0, 500)

  const backend = parsed.backend
  if (isRecord(backend) && typeof backend.error === 'string' && backend.error.trim().length > 0)
    return backend.error.trim().slice(0, 500)

  return undefined
}

function getCodingGateTerminalEvidence(runtime: CodingRunnerDependencies['runtime']) {
  const state = runtime.stateManager.getState()
  return {
    hasTerminalResult: Boolean(state.lastTerminalResult),
    terminalCommand: state.lastTerminalResult?.command,
    terminalExitCode: state.lastTerminalResult?.exitCode,
  }
}

function gateDecisionFinalStatus(decision: CodingVerificationGateDecision): 'completed' | 'failed' {
  return decision.decision === 'pass' ? 'completed' : 'failed'
}

async function emitVerificationGateDecision(params: {
  events: CodingRunnerEventEmitter
  reportedStatus: 'completed' | 'failed' | 'blocked'
  decision: CodingVerificationGateDecision
  recheckAttempted: boolean
}) {
  await params.events.emit('verification_gate_evaluated', {
    reportedStatus: params.reportedStatus,
    gateDecision: params.decision.decision,
    reasonCode: params.decision.reasonCode,
    runnerFinalStatus: gateDecisionFinalStatus(params.decision),
    explanation: params.decision.explanation,
    recheckAttempted: params.recheckAttempted,
  })
}

async function applyCodingRunnerVerificationGate(params: {
  runtime: CodingRunnerDependencies['runtime']
  executeAction: CodingRunnerDependencies['executeAction']
  workspacePath: string
  events: CodingRunnerEventEmitter
  reportedStatus: 'completed'
}): Promise<{
  passed: true
  decision: CodingVerificationGateDecision
} | {
  passed: false
  decision: CodingVerificationGateDecision
  recheckExplanation?: string
}> {
  let decision = evaluateCodingVerificationGate({
    codingState: params.runtime.stateManager.getState().coding,
    workflowKind: 'coding_agentic_loop',
    terminalEvidence: getCodingGateTerminalEvidence(params.runtime),
  })

  await emitVerificationGateDecision({
    events: params.events,
    reportedStatus: params.reportedStatus,
    decision,
    recheckAttempted: false,
  })

  if (decision.decision === 'pass') {
    return { passed: true, decision }
  }

  if (decision.decision !== 'recheck_once') {
    return { passed: false, decision }
  }

  await params.events.emit('verification_recheck_started', {
    reportedStatus: params.reportedStatus,
    reasonCode: decision.reasonCode,
    explanation: decision.explanation,
  })

  const recheck = await runBoundedCodingRunnerVerificationRecheck({
    runtime: params.runtime,
    executeAction: params.executeAction,
    workspacePath: params.workspacePath,
  })

  await params.events.emit('verification_recheck_completed', {
    ok: recheck.succeeded,
    explanation: recheck.explanation,
  })

  if (!recheck.succeeded) {
    return {
      passed: false,
      decision,
      recheckExplanation: recheck.explanation,
    }
  }

  decision = evaluateCodingVerificationGate({
    codingState: params.runtime.stateManager.getState().coding,
    workflowKind: 'coding_agentic_loop',
    recheckAttempted: true,
    terminalEvidence: getCodingGateTerminalEvidence(params.runtime),
  })

  await emitVerificationGateDecision({
    events: params.events,
    reportedStatus: params.reportedStatus,
    decision,
    recheckAttempted: true,
  })

  if (decision.decision === 'pass') {
    return { passed: true, decision }
  }

  return {
    passed: false,
    decision,
    recheckExplanation: recheck.explanation,
  }
}

function isBoundedRecheckActionExecuted(result: CallToolResult) {
  if (result.isError === true)
    return false

  const structured = result.structuredContent as Record<string, unknown> | undefined
  if (!structured || typeof structured.status !== 'string')
    return true

  return structured.status === 'executed' || structured.status === 'ok'
}

async function runBoundedCodingRunnerVerificationRecheck(params: {
  runtime: CodingRunnerDependencies['runtime']
  executeAction: CodingRunnerDependencies['executeAction']
  workspacePath: string
}): Promise<{ succeeded: boolean, explanation: string }> {
  try {
    const codingState = params.runtime.stateManager.getState().coding
    if (!codingState?.workspacePath) {
      return {
        succeeded: false,
        explanation: 'bounded verification recheck aborted: coding workspace context is unavailable.',
      }
    }

    const currentFilePath = codingState.lastTargetSelection?.selectedFile
    const recheckCwd = codingState.validationBaseline?.workspacePath
      || codingState.workspacePath
      || params.workspacePath

    const validationResult = await params.executeAction({
      kind: 'terminal_exec',
      input: {
        command: 'auto',
        cwd: recheckCwd,
        timeoutMs: 60_000,
      },
    }, 'workflow_coding_runner_verification_recheck_terminal_exec')

    if (!isBoundedRecheckActionExecuted(validationResult)) {
      return {
        succeeded: false,
        explanation: 'bounded verification recheck failed while executing auto validation command.',
      }
    }

    const reviewResult = await params.executeAction({
      kind: 'coding_review_changes',
      input: currentFilePath ? { currentFilePath } : {},
    }, 'workflow_coding_runner_verification_recheck_review_changes')

    if (!isBoundedRecheckActionExecuted(reviewResult)) {
      return {
        succeeded: false,
        explanation: 'bounded verification recheck failed while running coding_review_changes.',
      }
    }

    return {
      succeeded: true,
      explanation: 'bounded verification recheck executed auto validation and coding_review_changes.',
    }
  }
  catch (err: unknown) {
    return {
      succeeded: false,
      explanation: `bounded verification recheck failed: ${errorMessageFrom(err) || String(err)}`,
    }
  }
}

function buildVerificationGateFailureMessage(
  decision: CodingVerificationGateDecision,
  recheckExplanation?: string,
) {
  return [
    `Verification Gate blocked completion: ${decision.explanation}`,
    `reason=${decision.reasonCode}`,
    recheckExplanation ? `recheck=${recheckExplanation}` : undefined,
  ].filter(Boolean).join(' ')
}
