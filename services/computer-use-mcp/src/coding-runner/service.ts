import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { CodingVerificationGateDecision } from '../coding/verification-gate'
import type { CodingRunnerEventEmitter } from './events'
import type { CodingRunner, CodingRunnerConfig, CodingRunnerDependencies, CodingRunnerResult, CodingRunnerTurnResult, RunCodingTaskParams } from './types'

import { randomUUID } from 'node:crypto'

import { errorMessageFrom } from '@moeru/std'
import { generateText } from '@xsai/generate-text'

import { evaluateCodingVerificationGate } from '../coding/verification-gate'
import { tryPreRetrievePlastMemContext } from '../workspace-memory/plast-mem-pre-retrieve'
import { createCodingRunnerEventEmitter } from './events'
import { buildArchiveRecallFinalizationMemory, buildBudgetExhaustedMemory, buildBudgetPressureMemory, buildReportStatusMemory, buildStepMemory, buildSuccessfulToolEvidenceMemory, buildTaskStartMemory, buildTextOnlyReportRequiredMemory, buildToolFailureMemory, buildVerificationGateFailureMemory, syncCodingRunnerTaskMemory } from './memory'
import { buildXsaiCodingTools } from './tool-runtime'
import { createTranscriptRuntime, projectForCodingTurn } from './transcript-runtime'

export function buildProviderCompatibleGenerateTextInput(params: {
  baseURL: string
  system: string
  messages: any[]
}): { system?: string, messages: any[], projectedMessageCount: number } {
  if (!isGithubModelsBaseURL(params.baseURL)) {
    return {
      system: params.system,
      messages: params.messages,
      projectedMessageCount: params.messages.length,
    }
  }

  return {
    system: undefined,
    messages: [
      { role: 'system', content: params.system },
      ...params.messages,
    ],
    projectedMessageCount: params.messages.length + 1,
  }
}

function isGithubModelsBaseURL(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === 'models.github.ai'
  }
  catch {
    return false
  }
}

const MAX_FAILURE_SUMMARY_CHARS = 500
const MAX_FINAL_REPORT_CORRECTION_ATTEMPTS = 2
const ARCHIVE_RECALL_DENIED = 'ARCHIVE_RECALL_DENIED'

export class CodingRunnerImpl implements CodingRunner {
  constructor(
    private readonly config: CodingRunnerConfig,
    private readonly deps: CodingRunnerDependencies,
  ) {}

  async runCodingTask(params: RunCodingTaskParams): Promise<CodingRunnerResult> {
    const { workspacePath, taskGoal, taskKind = 'edit', maxSteps, stepTimeoutMs, planWorkflowExecutionMode = 'disabled' } = params
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
    const plastMemPreRetrieve = await tryPreRetrievePlastMemContext(
      taskGoal,
      runtime.config.workspaceMemoryPlastMemPreRetrieve,
    )
    const plastMemContext = plastMemPreRetrieve.status === 'included'
      ? plastMemPreRetrieve.context
      : ''
    const xsaiTools = await buildXsaiCodingTools(runtime, executeAction, {
      events,
      archiveStore,
      runId,
      workspaceMemoryStore,
      planWorkflowExecutionMode,
    })
    const reportOnlyXsaiTools = xsaiTools.filter((tool: any) => getXsaiToolName(tool) === 'coding_report_status')
    const analysisArchiveRecallCorrectionXsaiTools = xsaiTools.filter((tool: any) => {
      const name = getXsaiToolName(tool)
      return name === 'coding_compress_context' || name === 'coding_report_status'
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
    let finalReportCorrectionAttempts = 0
    let archiveRecallFinalizationPending = false
    let archiveRecallFinalizationAttempts = 0
    const turns: CodingRunnerTurnResult[] = []
    const queueFinalReportCorrection = (sourceStep: number, summary: string | undefined): boolean => {
      if (reportOnlyXsaiTools.length === 0 || finalReportCorrectionAttempts >= MAX_FINAL_REPORT_CORRECTION_ATTEMPTS)
        return false

      lastFailureSummary = summary
      finalReportCorrectionPending = true
      syncCodingRunnerTaskMemory({
        runtime,
        runId,
        source: `text-only-report-required-${sourceStep}`,
        sourceIndex: sourceStep * 10 + 2,
        extraction: buildTextOnlyReportRequiredMemory(summary ?? 'missing terminal report'),
      })
      return true
    }
    const queueArchiveRecallFinalization = (sourceStep: number, summary: string | undefined): boolean => {
      if (taskKind !== 'analysis_report' || analysisArchiveRecallCorrectionXsaiTools.length < 2 || archiveRecallFinalizationAttempts >= 1)
        return false

      lastFailureSummary = summary
      archiveRecallFinalizationPending = true
      syncCodingRunnerTaskMemory({
        runtime,
        runId,
        source: `archive-recall-finalization-${sourceStep}`,
        sourceIndex: sourceStep * 10 + 5,
        extraction: buildArchiveRecallFinalizationMemory(summary ?? 'archive recall denied'),
      })
      return true
    }

    try {
      for (let step = 0; step < actualMaxSteps || finalReportCorrectionPending || archiveRecallFinalizationPending; step++) {
        const isReportCorrectionStep = finalReportCorrectionPending
        const isArchiveRecallFinalizationStep = archiveRecallFinalizationPending
        finalReportCorrectionPending = false
        archiveRecallFinalizationPending = false
        if (isReportCorrectionStep)
          finalReportCorrectionAttempts += 1
        if (isArchiveRecallFinalizationStep)
          archiveRecallFinalizationAttempts += 1
        totalSteps = step + 1
        let messages: any[]
        let newMessages: any[] = []
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(new Error('STEP_TIMEOUT')), actualStepTimeoutMs)
        await events.emit('step_started', { stepIndex: step + 1, maxSteps: actualMaxSteps })
        if (!isReportCorrectionStep && !isArchiveRecallFinalizationStep) {
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
          plastMemContext,
          plastMemContextStatus: plastMemPreRetrieve.status,
        })
        const providerInput = buildProviderCompatibleGenerateTextInput({
          baseURL: this.config.baseURL,
          system: projection.system,
          messages: projection.messages as any,
        })
        const projectedLength = providerInput.projectedMessageCount

        // Write archive candidates from this projection turn (deduped)
        await archiveStore.writeCandidates(projection.archiveCandidates, runId, taskId)

        try {
          const result = await generateText({
            model: this.config.model,
            baseURL: this.config.baseURL,
            apiKey: this.config.apiKey,
            tools: getToolsForCodingRunnerStep({
              isReportCorrectionStep,
              isArchiveRecallFinalizationStep,
              reportOnlyXsaiTools,
              analysisArchiveRecallCorrectionXsaiTools,
              xsaiTools,
            }) as any,
            system: providerInput.system,
            messages: providerInput.messages,
            abortSignal: controller.signal as any,
          })
          messages = result.messages

          // Delta append
          newMessages = messages.slice(projectedLength)
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
          const error = errorMessageFrom(stepErr) || String(stepErr)
          if (isReportCorrectionStep && isUnavailableReportCorrectionToolError(error)) {
            const summary = clampFailureSummary(error)
            if (queueFinalReportCorrection(step + 1, summary))
              continue

            finalStatus = 'failed'
            finalError = `TEXT_ONLY_FINAL: report-only correction requested an unavailable tool.${summary ? ` lastError=${summary}` : ''}`
            exitReason = 'text_only_failure'
            break
          }
          if (isArchiveRecallFinalizationStep && isUnavailableReportCorrectionToolError(error)) {
            const summary = clampFailureSummary(error)
            finalStatus = 'failed'
            finalError = `ARCHIVE_RECALL_FINALIZATION_FAILED: correction requested unavailable tool.${summary ? ` lastError=${summary}` : ''}`
            exitReason = 'archive_recall_failure'
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
          const failedArchiveRecallCorrectionTool = isArchiveRecallFinalizationStep
            ? findFailedToolResult(newMessages)
            : undefined

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

            if (failedArchiveRecallCorrectionTool) {
              lastFailureSummary = failedArchiveRecallCorrectionTool.summary
              finalStatus = 'failed'
              finalError = `ARCHIVE_RECALL_FINALIZATION_FAILED: correction tool ${failedArchiveRecallCorrectionTool.toolName} failed.${lastFailureSummary ? ` lastToolError=${lastFailureSummary}` : ''}`
              exitReason = 'archive_recall_failure'
              break
            }

            if (isReportCorrectionStep && toolName !== 'coding_report_status') {
              const summary = clampFailureSummary(`report-only correction must call coding_report_status, got ${toolName}.`)
              if (queueFinalReportCorrection(step + 1, summary))
                continue

              finalStatus = 'failed'
              finalError = `TEXT_ONLY_FINAL: report-only correction must call coding_report_status, got ${toolName}.`
              exitReason = 'text_only_failure'
              break
            }

            if (isArchiveRecallFinalizationStep && toolName !== 'coding_report_status') {
              const summary = clampFailureSummary(`archive recall finalization must end with coding_report_status, got ${toolName}.`)
              finalStatus = 'failed'
              finalError = `ARCHIVE_RECALL_FINALIZATION_FAILED: ${summary}`
              exitReason = 'archive_recall_failure'
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
              if (shouldQueueArchiveRecallFinalization({
                taskKind,
                acceptedReportSeen,
                stepIndex: step,
                maxSteps: actualMaxSteps,
                toolName,
                failureSummary: lastFailureSummary,
                isCorrectionStep: isReportCorrectionStep || isArchiveRecallFinalizationStep,
              }) && queueArchiveRecallFinalization(step + 1, lastFailureSummary)) {
                continue
              }
              if (isArchiveRecallFinalizationStep && toolName === 'coding_report_status') {
                finalStatus = 'failed'
                finalError = `ARCHIVE_RECALL_FINALIZATION_FAILED: correction report failed.${lastFailureSummary ? ` lastToolError=${lastFailureSummary}` : ''}`
                exitReason = 'archive_recall_failure'
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
          if (isArchiveRecallFinalizationStep) {
            finalStatus = 'failed'
            finalError = `ARCHIVE_RECALL_FINALIZATION_FAILED: correction ended without coding_report_status.${summary ? ` lastAssistant=${summary}` : ''}`
            exitReason = 'archive_recall_failure'
            break
          }
          if (isReportCorrectionStep) {
            if (queueFinalReportCorrection(step + 1, summary))
              continue

            finalStatus = 'failed'
            finalError = `TEXT_ONLY_FINAL: report-only correction ended without an accepted terminal report.${summary ? ` lastAssistant=${summary}` : ''}`
            exitReason = 'text_only_failure'
            break
          }
          if (step + 1 >= actualMaxSteps) {
            if (queueFinalReportCorrection(step + 1, summary))
              continue

            // If the final report-only correction is unavailable or exhausted,
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
        plastMemContext,
        plastMemContextStatus: plastMemPreRetrieve.status,
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
    | 'archive_recall_failure'
    | 'budget_exhausted'
    | 'crash'

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

function getToolsForCodingRunnerStep(params: {
  isReportCorrectionStep: boolean
  isArchiveRecallFinalizationStep: boolean
  reportOnlyXsaiTools: unknown[]
  analysisArchiveRecallCorrectionXsaiTools: unknown[]
  xsaiTools: unknown[]
}) {
  if (params.isArchiveRecallFinalizationStep)
    return params.analysisArchiveRecallCorrectionXsaiTools

  if (params.isReportCorrectionStep)
    return params.reportOnlyXsaiTools

  return params.xsaiTools
}

function findFailedToolResult(messages: unknown[]): { toolName: string, summary: string | undefined } | undefined {
  for (const msg of messages) {
    if (!isRecord(msg) || msg.role !== 'tool' || typeof msg.content !== 'string')
      continue

    try {
      const parsed = JSON.parse(msg.content)
      if (!isRecord(parsed) || parsed.ok !== false)
        continue

      return {
        toolName: typeof parsed.tool === 'string' ? parsed.tool : 'unknown',
        summary: clampFailureSummary(parseToolFailureSummary(parsed) ?? msg.content),
      }
    }
    catch {}
  }

  return undefined
}

function shouldQueueArchiveRecallFinalization(params: {
  taskKind: string
  acceptedReportSeen: boolean
  stepIndex: number
  maxSteps: number
  toolName: string
  failureSummary?: string
  isCorrectionStep: boolean
}): boolean {
  return params.taskKind === 'analysis_report'
    && !params.acceptedReportSeen
    && !params.isCorrectionStep
    && params.stepIndex + 1 >= params.maxSteps
    && params.toolName === 'coding_read_archived_context'
    && Boolean(params.failureSummary?.includes(ARCHIVE_RECALL_DENIED))
}

function isUnavailableReportCorrectionToolError(value: string): boolean {
  return value.includes('tried to call unavailable tool')
    && value.includes('Available tools:')
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
    const recheckCwd = params.workspacePath

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
