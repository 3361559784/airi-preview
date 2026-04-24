import type { CodingRunnerConfig, CodingRunnerDependencies, CodingRunnerResult, CodingRunnerTurnResult, RunCodingTaskParams, CodingRunner } from './types'

import { randomUUID } from 'node:crypto'

import { generateText } from '@xsai/generate-text'

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
    const xsaiTools = await buildXsaiCodingTools(runtime, executeAction)
    const { store: transcriptStore, archiveStore } = await createTranscriptRuntime(
      runtime,
      runId,
      this.deps.useInMemoryTranscript ?? false,
    )

    // Preflight 1: Review Workspace
    const reviewResult = await executeAction(
      {
        kind: 'coding_review_workspace',
        input: { workspacePath },
      } as any,
      'coding_review_workspace'
    )

    if (reviewResult.isError) {
      return {
        status: 'failed',
        totalSteps: 0,
        turns: [],
        error: `Bootstrap Failed: coding_review_workspace returned error.\n\n${JSON.stringify(reviewResult.content)}`,
      }
    }

    // Preflight 2: Capture Validation Baseline
    const baselineResult = await executeAction(
      {
        kind: 'coding_capture_validation_baseline',
        input: { workspacePath, createTemporaryWorktree: true },
      } as any,
      'coding_capture_validation_baseline'
    )

    if (baselineResult.isError) {
      return {
        status: 'failed',
        totalSteps: 0,
        turns: [],
        error: `Bootstrap Failed: coding_capture_validation_baseline returned error.\n\n${JSON.stringify(baselineResult.content)}`,
      }
    }

    await transcriptStore.appendUser(taskGoal)

    let totalSteps = 0
    let finalStatus: CodingRunnerResult['status'] = 'timeout'
    const turns: CodingRunnerTurnResult[] = []

    const actualMaxSteps = maxSteps ?? this.config.maxSteps
    const actualStepTimeoutMs = stepTimeoutMs ?? this.config.stepTimeoutMs

    try {
      for (let step = 0; step < actualMaxSteps; step++) {
        totalSteps = step + 1
        let messages: any[]
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(new Error('STEP_TIMEOUT')), actualStepTimeoutMs)

        const projection = projectForCodingTurn(transcriptStore, this.config.systemPromptBase, runtime)
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
    catch (err: any) {
      finalStatus = 'crash'
      return {
        status: finalStatus,
        totalSteps,
        turns,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    return {
      status: finalStatus,
      totalSteps,
      transcriptMetadata: projectForCodingTurn(transcriptStore, this.config.systemPromptBase, runtime).metadata,
      turns,
    }
  }
}

export function createCodingRunner(config: CodingRunnerConfig, deps: CodingRunnerDependencies): CodingRunner {
  return new CodingRunnerImpl(config, deps)
}
