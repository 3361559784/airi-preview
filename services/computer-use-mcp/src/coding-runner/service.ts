import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { CodingVerificationGateDecision } from '../coding/verification-gate'
import type { CodingRunnerEventEmitter } from './events'
import type { CodingRunner, CodingRunnerConfig, CodingRunnerDependencies, CodingRunnerResult, CodingRunnerTurnResult, RunCodingTaskParams } from './types'

import { randomUUID } from 'node:crypto'

import { errorMessageFrom } from '@moeru/std'
import { generateText } from '@xsai/generate-text'

import { evaluateCodingVerificationGate } from '../coding/verification-gate'
import { createCodingRunnerEventEmitter } from './events'
import { buildBudgetExhaustedMemory, buildBudgetPressureMemory, buildReportStatusMemory, buildStepMemory, buildSuccessfulToolEvidenceMemory, buildTaskStartMemory, buildTextOnlyReportRequiredMemory, buildToolFailureMemory, buildVerificationGateFailureMemory, syncCodingRunnerTaskMemory } from './memory'
import { buildXsaiCodingTools } from './tool-runtime'
import { createTranscriptRuntime, projectForCodingTurn } from './transcript-runtime'

export class CodingRunnerImpl implements CodingRunner {
  constructor(
    private readonly config: CodingRunnerConfig,
    private readonly deps: CodingRunnerDependencies,
  ) {}

  async runCodingTask(params: RunCodingTaskParams): Promise<CodingRunnerResult> {
    const { workspacePath, taskGoal, taskKind = 'edit', maxSteps, stepTimeoutMs } = params
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
      taskKind,
      maxSteps: actualMaxSteps,
      stepTimeoutMs: actualStepTimeoutMs,
    })

    // TaskMemory is per-run recovery context. Reset it before preflight so stale
    // evidence pins from a previous workflow_coding_runner call cannot leak.
    runtime.taskMemory.clear()
    runtime.stateManager.clearTaskMemory()

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
    const reportOnlyXsaiTools = xsaiTools.filter((tool: any) => getXsaiToolName(tool) === 'coding_report_status')

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
    runtime.stateManager.updateCodingState({ taskKind })

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
      extraction: buildTaskStartMemory(taskGoal, workspacePath, taskKind),
    })

    await transcriptStore.appendUser(taskGoal)

    let totalSteps = 0
    let finalStatus: CodingRunnerResult['status'] = 'timeout'
    let finalError: string | undefined
    let exitReason: CodingRunnerExitReason = 'none'
    let acceptedReportSeen = false
    let lastToolName: string | undefined
    let lastFailureSummary: string | undefined
    let finalReportCorrectionPending = false
    let finalReportCorrectionUsed = false
    const turns: CodingRunnerTurnResult[] = []

    try {
      for (let step = 0; step < actualMaxSteps || finalReportCorrectionPending; step++) {
        const isReportCorrectionStep = finalReportCorrectionPending
        finalReportCorrectionPending = false
        totalSteps = step + 1
        let messages: any[]
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(new Error('STEP_TIMEOUT')), actualStepTimeoutMs)
        await events.emit('step_started', { stepIndex: step + 1, maxSteps: actualMaxSteps })
        if (!isReportCorrectionStep) {
          syncCodingRunnerTaskMemory({
            runtime,
            runId,
            source: `step-${step + 1}`,
            sourceIndex: (step + 1) * 10,
            extraction: buildStepMemory(step + 1, actualMaxSteps),
          })
          if (actualMaxSteps - step <= 2) {
            syncCodingRunnerTaskMemory({
              runtime,
              runId,
              source: `budget-pressure-${step + 1}`,
              sourceIndex: (step + 1) * 10 + 1,
              extraction: buildBudgetPressureMemory(step, actualMaxSteps),
            })
          }
        }

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
            tools: (isReportCorrectionStep ? reportOnlyXsaiTools : xsaiTools) as any,
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
            exitReason = 'step_timeout'
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
            let parsedToolResult: Record<string, unknown> | undefined
            try {
              const parsed = JSON.parse(lastContent)
              if (isRecord(parsed)) {
                parsedToolResult = parsed
                toolName = typeof parsed.tool === 'string' ? parsed.tool : 'unknown'
                toolArgs = parsed.args
                resultOk = parsed.ok !== false
                reportStatus = parseReportStatus(parsed)
                failureSummary = parseToolFailureSummary(parsed)
              }
            }
            catch {}

            turns.push({
              role: 'tool',
              toolName,
              toolArgs,
              resultOk,
              rawText: lastContent,
            })
            lastToolName = toolName

            if (isReportCorrectionStep && toolName !== 'coding_report_status') {
              finalStatus = 'failed'
              finalError = `TEXT_ONLY_FINAL: report-only correction must call coding_report_status, got ${toolName}.`
              exitReason = 'text_only_failure'
              break
            }

            if (!resultOk) {
              lastFailureSummary = clampFailureSummary(failureSummary ?? lastContent)
              syncCodingRunnerTaskMemory({
                runtime,
                runId,
                source: `tool-failure-${step + 1}`,
                sourceIndex: (step + 1) * 10 + 2,
                extraction: buildToolFailureMemory({
                  toolName,
                  summary: lastFailureSummary,
                }),
              })
              if (isReportCorrectionStep && toolName === 'coding_report_status') {
                finalStatus = 'failed'
                finalError = `TEXT_ONLY_FINAL: report-only correction failed.${lastFailureSummary ? ` lastToolError=${lastFailureSummary}` : ''}`
                exitReason = 'text_only_failure'
                break
              }
            }
            else if (toolName !== 'coding_report_status') {
              const evidenceMemory = buildSuccessfulToolEvidenceMemory({
                toolName,
                toolArgs,
                toolBackend: parsedToolResult?.backend,
                state: runtime.stateManager.getState(),
              })
              if (evidenceMemory) {
                syncCodingRunnerTaskMemory({
                  runtime,
                  runId,
                  source: `tool-success-evidence-${step + 1}`,
                  sourceIndex: (step + 1) * 10 + 4,
                  extraction: evidenceMemory,
                })
              }
            }

            if (toolName === 'coding_report_status') {
              if (resultOk && reportStatus) {
                acceptedReportSeen = true
                exitReason = 'accepted_report'
                const reportArgs = isRecord(toolArgs) ? toolArgs : {}
                syncCodingRunnerTaskMemory({
                  runtime,
                  runId,
                  source: `report-${step + 1}`,
                  sourceIndex: (step + 1) * 10 + 2,
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
                      sourceIndex: (step + 1) * 10 + 3,
                      extraction: buildVerificationGateFailureMemory({
                        reasonCode: gateOutcome.decision.reasonCode,
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
              if (isReportCorrectionStep) {
                finalStatus = 'failed'
                finalError = 'TEXT_ONLY_FINAL: report-only correction did not produce an accepted terminal report.'
                exitReason = 'text_only_failure'
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
          const summary = clampFailureSummary(lastFailureSummary ?? String(turns.at(-1)?.rawText ?? 'text-only assistant response'))
          if (isReportCorrectionStep) {
            finalStatus = 'failed'
            finalError = `TEXT_ONLY_FINAL: report-only correction ended without an accepted terminal report.${summary ? ` lastAssistant=${summary}` : ''}`
            exitReason = 'text_only_failure'
            break
          }
          if (step + 1 >= actualMaxSteps) {
            if (!finalReportCorrectionUsed && reportOnlyXsaiTools.length > 0) {
              lastFailureSummary = summary
              finalReportCorrectionUsed = true
              finalReportCorrectionPending = true
              syncCodingRunnerTaskMemory({
                runtime,
                runId,
                source: `text-only-report-required-${step + 1}`,
                sourceIndex: (step + 1) * 10 + 2,
                extraction: buildTextOnlyReportRequiredMemory(summary ?? 'missing terminal report'),
              })
              continue
            }

            // If the final report-only correction is unavailable or already used,
            // text-only output without a terminal report remains a failure.
            finalStatus = 'failed'
            finalError = `TEXT_ONLY_FINAL: coding runner ended without an accepted terminal report.${summary ? ` lastAssistant=${summary}` : ''}`
            exitReason = 'text_only_failure'
            break
          }

          lastFailureSummary = summary
          syncCodingRunnerTaskMemory({
            runtime,
            runId,
            source: `text-only-report-required-${step + 1}`,
            sourceIndex: (step + 1) * 10 + 2,
            extraction: buildTextOnlyReportRequiredMemory(summary ?? 'missing terminal report'),
          })
          // Keep the loop alive so the next turn can issue the required report tool call.
          continue
        }
      }
    }
    catch (err: unknown) {
      finalStatus = 'crash'
      exitReason = 'crash'
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

    if (exitReason === 'none' && !acceptedReportSeen) {
      exitReason = 'budget_exhausted'
      finalStatus = 'failed'
      finalError = buildBudgetExhaustedError({
        maxSteps: actualMaxSteps,
        lastToolName,
        lastFailureSummary,
      })
      await events.emit('budget_exhausted', {
        maxSteps: actualMaxSteps,
        totalSteps,
        acceptedReportSeen: false,
        lastToolName,
        lastFailureSummary,
      })
      syncCodingRunnerTaskMemory({
        runtime,
        runId,
        source: 'budget-exhausted',
        sourceIndex: actualMaxSteps * 10 + 9,
        extraction: buildBudgetExhaustedMemory({
          maxSteps: actualMaxSteps,
          lastToolName,
          lastFailureSummary,
        }),
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

type CodingRunnerExitReason
  = | 'none'
    | 'step_timeout'
    | 'accepted_report'
    | 'text_only_failure'
    | 'budget_exhausted'
    | 'crash'

const MAX_FAILURE_SUMMARY_CHARS = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getXsaiToolName(tool: unknown) {
  if (!isRecord(tool))
    return undefined

  if (typeof tool.name === 'string')
    return tool.name

  const fn = tool.function
  return isRecord(fn) && typeof fn.name === 'string'
    ? fn.name
    : undefined
}

function clampFailureSummary(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed)
    return undefined
  return trimmed.slice(0, MAX_FAILURE_SUMMARY_CHARS)
}

function buildBudgetExhaustedError(params: {
  maxSteps: number
  lastToolName?: string
  lastFailureSummary?: string
}): string {
  return [
    `BUDGET_EXHAUSTED: coding runner reached maxSteps=${params.maxSteps} without an accepted terminal report.`,
    params.lastToolName ? `lastTool=${params.lastToolName}` : undefined,
    params.lastFailureSummary ? `lastFailure=${params.lastFailureSummary}` : undefined,
  ].filter(Boolean).join(' ')
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

  const shouldAttemptRecheck = shouldAttemptBoundedVerificationRecheck(decision)
  if (!shouldAttemptRecheck) {
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
    runValidation: decision.decision === 'recheck_once'
      || !decision.verificationEvidenceSummary.hasTerminalResult,
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

function shouldAttemptBoundedVerificationRecheck(decision: CodingVerificationGateDecision): boolean {
  return decision.decision === 'recheck_once'
    || decision.reasonCode === 'review_missing'
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
  runValidation: boolean
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

    if (params.runValidation) {
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
      explanation: params.runValidation
        ? 'bounded verification recheck executed auto validation and coding_review_changes.'
        : 'bounded verification recheck executed coding_review_changes.',
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
