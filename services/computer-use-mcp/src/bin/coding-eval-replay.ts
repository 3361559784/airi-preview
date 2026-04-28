import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { CodingRunnerResult, CodingRunnerTurnResult } from '../coding-runner/types'

import { normalizeCodingLiveFailureReplay } from '../coding-runner/live-failure-replay'

export interface EvalTranscriptToolResult {
  entryId: number
  tool?: string
  args?: Record<string, unknown>
  ok?: boolean
  status?: string
  error?: string
  backend?: Record<string, unknown>
}

export interface CodingEvalReplaySource {
  label: string
  provider?: string
  model?: string
  logPath?: string
}

export interface BuildCodingEvalReplayRowInput {
  result?: CallToolResult
  transcriptTools?: readonly EvalTranscriptToolResult[]
  source: CodingEvalReplaySource
}

/**
 * Build a replay row from the live MCP eval surface without changing the
 * workflow_coding_runner public result schema. The transcript entries provide
 * bounded tool evidence; the MCP structured result provides run status.
 */
export function buildCodingEvalReplayRow(input: BuildCodingEvalReplayRowInput) {
  const structured = recordValue(input.result?.structuredContent)
  const runId = stringValue(structured?.runId)
  const status = runnerStatusValue(structured?.status)
  const totalSteps = numberValue(structured?.totalSteps)

  if (!runId || !status || totalSteps === undefined)
    return undefined

  const runnerResult: CodingRunnerResult = {
    runId,
    status,
    totalSteps,
    error: stringValue(structured?.lastError),
    turns: (input.transcriptTools ?? []).map(transcriptToolToTurn),
  }

  return normalizeCodingLiveFailureReplay({
    result: runnerResult,
    source: input.source,
  })
}

export function inferEvalProviderLabel(baseURL: string | undefined): string | undefined {
  if (!baseURL)
    return undefined

  try {
    return new URL(baseURL).hostname
  }
  catch {
    return baseURL
  }
}

function transcriptToolToTurn(entry: EvalTranscriptToolResult): CodingRunnerTurnResult {
  return {
    role: 'tool',
    toolName: entry.tool,
    toolArgs: entry.args,
    resultOk: entry.ok,
    rawText: JSON.stringify({
      tool: entry.tool,
      args: entry.args,
      ok: entry.ok,
      status: entry.status,
      error: entry.error,
      backend: entry.backend,
    }),
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function runnerStatusValue(value: unknown): CodingRunnerResult['status'] | undefined {
  return value === 'completed' || value === 'timeout' || value === 'failed' || value === 'crash'
    ? value
    : undefined
}
