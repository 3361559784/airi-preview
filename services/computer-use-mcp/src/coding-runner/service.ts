import type { CodingRunner, CodingRunnerConfig, CodingRunnerDependencies, CodingRunnerResult, CodingRunnerTurnResult, RunCodingTaskParams } from './types'

import { randomUUID } from 'node:crypto'

import { errorMessageFrom } from '@moeru/std'
import { generateText } from '@xsai/generate-text'

import { createCodingRunnerEventEmitter } from './events'
import { buildReportStatusMemory, buildStepMemory, buildTaskStartMemory, syncCodingRunnerTaskMemory } from './memory'
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
            let parsedStatus: string | undefined
            try {
              const parsed = JSON.parse(lastContent)
              toolName = parsed.tool || 'unknown'
              toolArgs = parsed.args
              resultOk = parsed.ok !== false
              parsedStatus = parsed.status
            }
            catch {}

            turns.push({
              role: 'tool',
              toolName,
              toolArgs,
              resultOk,
              rawText: lastContent,
            })

            if (toolName === 'coding_report_status') {
              if (parsedStatus && ['completed', 'failed', 'blocked'].includes(parsedStatus)) {
                const status = parsedStatus as 'completed' | 'failed' | 'blocked'
                const reportArgs = isRecord(toolArgs) ? toolArgs : {}
                syncCodingRunnerTaskMemory({
                  runtime,
                  runId,
                  source: `report-${step + 1}`,
                  sourceIndex: (step + 1) * 10 + 1,
                  extraction: buildReportStatusMemory({
                    status,
                    summary: stringValue(reportArgs.summary),
                    filesTouched: stringArrayValue(reportArgs.filesTouched),
                    commandsRun: stringArrayValue(reportArgs.commandsRun),
                    checks: stringArrayValue(reportArgs.checks),
                    nextStep: stringValue(reportArgs.nextStep),
                  }),
                })
                await events.emit('report_status', {
                  status,
                  summary: stringValue(reportArgs.summary),
                })
                finalStatus = parsedStatus === 'completed' ? 'completed' : 'failed'
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
