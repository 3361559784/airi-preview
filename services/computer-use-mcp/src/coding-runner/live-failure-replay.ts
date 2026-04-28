import type { CodingVerificationGateDecisionKind, CodingVerificationGateReasonCode } from '../coding/verification-gate'
import type { CodingLiveFailureClass, CodingLiveFailureDisposition } from './live-failure-corpus'
import type { CodingRunnerEventEnvelope, CodingRunnerResult, CodingRunnerTurnResult } from './types'

import { classifyCodingLiveFailureText } from './live-failure-corpus'

const MAX_FAILURE_SEARCH_TEXT_CHARS = 8_000
const MAX_PREVIEW_CHARS = 500

export interface CodingLiveFailureReplaySource {
  label?: string
  provider?: string
  model?: string
  logPath?: string
}

export interface CodingLiveFailureReplayToolEntry {
  index: number
  role: CodingRunnerTurnResult['role']
  toolName?: string
  resultOk?: boolean
  status?: string
  argsPreview?: string
  summary?: string
  error?: string
}

export interface CodingLiveFailureTerminalEvidence {
  turnIndex: number
  command?: string
  effectiveCwd?: string
  terminalStateEffectiveCwd?: string
  exitCode?: number
  timedOut?: boolean
  stdoutPreview?: string
  stderrPreview?: string
}

export interface CodingLiveFailureVerificationGateEvidence {
  reportedStatus: 'completed' | 'failed' | 'blocked'
  gateDecision: CodingVerificationGateDecisionKind
  reasonCode: CodingVerificationGateReasonCode
  runnerFinalStatus: 'completed' | 'failed'
  explanation: string
  recheckAttempted: boolean
}

export interface CodingLiveFailureReplayRow {
  runId: string
  source?: CodingLiveFailureReplaySource
  status: CodingRunnerResult['status']
  totalSteps: number
  failureClass: CodingLiveFailureClass
  disposition: CodingLiveFailureDisposition
  classificationSummary: string
  failureSignal: string
  eventKinds: CodingRunnerEventEnvelope['kind'][]
  toolHistory: CodingLiveFailureReplayToolEntry[]
  terminalEvidence: CodingLiveFailureTerminalEvidence[]
  verificationGate?: CodingLiveFailureVerificationGateEvidence
}

export interface NormalizeCodingLiveFailureReplayInput {
  result: CodingRunnerResult
  events?: readonly CodingRunnerEventEnvelope[]
  source?: CodingLiveFailureReplaySource
}

/**
 * Normalize a coding-runner result plus optional events into a bounded eval row.
 * This is for local replay/eval triage only; runner completion logic must keep
 * using real reports, gate decisions, and tool results directly.
 */
export function normalizeCodingLiveFailureReplay(input: NormalizeCodingLiveFailureReplayInput): CodingLiveFailureReplayRow {
  const events = [...(input.events ?? [])]
  const toolHistory = input.result.turns.map(normalizeToolHistoryEntry)
  const terminalEvidence = input.result.turns.flatMap((turn, index) => normalizeTerminalEvidence(turn, index))
  const searchText = buildFailureSearchText(input.result, events)
  const classification = classifyCodingLiveFailureText(searchText)

  return {
    runId: input.result.runId,
    source: input.source,
    status: input.result.status,
    totalSteps: input.result.totalSteps,
    failureClass: classification.failureClass,
    disposition: classification.disposition,
    classificationSummary: classification.summary,
    failureSignal: selectFailureSignal(input.result, toolHistory, searchText),
    eventKinds: events.map(event => event.kind),
    toolHistory,
    terminalEvidence,
    verificationGate: findLatestVerificationGate(events),
  }
}

function normalizeToolHistoryEntry(turn: CodingRunnerTurnResult, index: number): CodingLiveFailureReplayToolEntry {
  const parsed = parseToolResult(turn.rawText)

  return {
    index,
    role: turn.role,
    toolName: turn.toolName ?? stringValue(parsed?.tool),
    resultOk: turn.resultOk ?? booleanValue(parsed?.ok),
    status: stringValue(parsed?.status),
    argsPreview: previewValue(turn.toolArgs ?? parsed?.args),
    summary: previewString(stringValue(parsed?.summary)),
    error: previewString(stringValue(parsed?.error)),
  }
}

function normalizeTerminalEvidence(turn: CodingRunnerTurnResult, index: number): CodingLiveFailureTerminalEvidence[] {
  const parsed = parseToolResult(turn.rawText)
  const toolName = turn.toolName ?? stringValue(parsed?.tool)
  if (toolName !== 'terminal_exec')
    return []

  const backend = recordValue(parsed?.backend)
  const args = recordValue(turn.toolArgs ?? parsed?.args)
  const terminalState = recordValue(backend?.terminalState)

  return [{
    turnIndex: index,
    command: stringValue(backend?.command) ?? stringValue(args?.command),
    effectiveCwd: stringValue(backend?.effectiveCwd),
    terminalStateEffectiveCwd: stringValue(terminalState?.effectiveCwd),
    exitCode: numberValue(backend?.exitCode),
    timedOut: booleanValue(backend?.timedOut),
    stdoutPreview: previewString(stringValue(backend?.stdout)),
    stderrPreview: previewString(stringValue(backend?.stderr)),
  }]
}

function buildFailureSearchText(result: CodingRunnerResult, events: CodingRunnerEventEnvelope[]): string {
  return [
    result.error,
    ...result.turns.map(turn => turn.rawText),
    ...events.map(event => `${event.kind} ${safeJsonStringify(event.payload)}`),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .slice(0, MAX_FAILURE_SEARCH_TEXT_CHARS)
}

function selectFailureSignal(
  result: CodingRunnerResult,
  toolHistory: CodingLiveFailureReplayToolEntry[],
  searchText: string,
): string {
  if (result.error)
    return previewString(result.error) ?? ''

  const failedTool = findLastEntry(toolHistory, entry => entry.resultOk === false)
  if (failedTool?.error)
    return failedTool.error
  if (failedTool?.summary)
    return failedTool.summary

  return previewString(searchText) ?? `status=${result.status}`
}

function findLatestVerificationGate(events: CodingRunnerEventEnvelope[]): CodingLiveFailureVerificationGateEvidence | undefined {
  const event = findLastEntry(events, event => event.kind === 'verification_gate_evaluated')
  if (!event || event.kind !== 'verification_gate_evaluated')
    return undefined
  return event.payload
}

function parseToolResult(rawText: string | undefined): Record<string, unknown> | undefined {
  if (!rawText)
    return undefined
  try {
    return recordValue(JSON.parse(rawText))
  }
  catch {
    return undefined
  }
}

function previewValue(value: unknown): string | undefined {
  if (value === undefined)
    return undefined
  return previewString(typeof value === 'string' ? value : safeJsonStringify(value))
}

function previewString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed)
    return undefined
  return trimmed.length > MAX_PREVIEW_CHARS ? trimmed.slice(0, MAX_PREVIEW_CHARS) : trimmed
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function findLastEntry<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (predicate(value))
      return value
  }

  return undefined
}
