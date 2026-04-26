import type {
  CodingVerificationGateDecisionKind,
  CodingVerificationGateReasonCode,
} from '../coding/verification-gate'
import type { ExecuteAction } from '../server/action-executor'
import type { ComputerUseServerRuntime } from '../server/runtime'
import type { CodingTaskKind } from '../state'
import type { TranscriptProjectionMetadata } from '../transcript/types'

export interface CodingRunnerConfig {
  model: string
  baseURL: string
  apiKey: string
  systemPromptBase: string
  maxSteps: number
  stepTimeoutMs: number
}

export interface CodingRunnerDependencies {
  runtime: ComputerUseServerRuntime
  executeAction: ExecuteAction
  useInMemoryTranscript?: boolean
}

export interface RunCodingTaskParams {
  workspacePath: string
  taskGoal: string
  taskKind?: CodingTaskKind
  maxSteps?: number
  stepTimeoutMs?: number
  /**
   * Explicit run identifier for archive deduplication.
   * Generated via crypto.randomUUID() if omitted.
   */
  runId?: string
  /** Optional in-process event sink for CLI/UI adapters. */
  onEvent?: CodingRunnerEventHandler
}

export interface CodingRunnerTurnResult {
  role: 'tool' | 'assistant' | 'timeout'
  toolName?: string
  toolArgs?: unknown
  resultOk?: boolean
  rawText?: string
}

export interface CodingRunnerResult {
  runId: string
  status: 'completed' | 'timeout' | 'failed' | 'crash'
  totalSteps: number
  transcriptMetadata?: TranscriptProjectionMetadata
  turns: CodingRunnerTurnResult[]
  error?: string
}

export interface CodingRunner {
  runCodingTask: (params: RunCodingTaskParams) => Promise<CodingRunnerResult>
}

export type CodingRunnerEventHandler = (event: CodingRunnerEventEnvelope) => void | Promise<void>

export type CodingRunnerEventEnvelope
  = | RunnerEvent<'run_started', {
    workspacePath: string
    taskGoal: string
    taskKind: CodingTaskKind
    maxSteps: number
    stepTimeoutMs: number
  }>
  | RunnerEvent<'preflight_started', {
    name: 'coding_review_workspace' | 'coding_capture_validation_baseline'
  }>
  | RunnerEvent<'preflight_completed', {
    name: 'coding_review_workspace' | 'coding_capture_validation_baseline'
    ok: boolean
    error?: string
  }>
  | RunnerEvent<'step_started', {
    stepIndex: number
    maxSteps: number
  }>
  | RunnerEvent<'tool_call_started', {
    toolName: string
    argsSummary: string
  }>
  | RunnerEvent<'tool_call_completed', {
    toolName: string
    ok: boolean
    status: string
    summary: string
    error?: string
  }>
  | RunnerEvent<'assistant_message', {
    text: string
  }>
  | RunnerEvent<'step_timeout', {
    stepIndex: number
    timeoutMs: number
  }>
  | RunnerEvent<'budget_exhausted', {
    maxSteps: number
    totalSteps: number
    acceptedReportSeen: false
    lastToolName?: string
    lastFailureSummary?: string
  }>
  | RunnerEvent<'report_status', {
    status: 'completed' | 'failed' | 'blocked'
    summary?: string
  }>
  | RunnerEvent<'verification_gate_evaluated', {
    reportedStatus: 'completed' | 'failed' | 'blocked'
    gateDecision: CodingVerificationGateDecisionKind
    reasonCode: CodingVerificationGateReasonCode
    runnerFinalStatus: 'completed' | 'failed'
    explanation: string
    recheckAttempted: boolean
  }>
  | RunnerEvent<'verification_recheck_started', {
    reportedStatus: 'completed'
    reasonCode: CodingVerificationGateReasonCode
    explanation: string
  }>
  | RunnerEvent<'verification_recheck_completed', {
    ok: boolean
    explanation: string
  }>
  | RunnerEvent<'run_finished', {
    finalStatus: CodingRunnerResult['status']
    totalSteps: number
    error?: string
  }>
  | RunnerEvent<'run_crashed', {
    totalSteps: number
    error: string
  }>

export interface RunnerEvent<TKind extends string, TPayload> {
  runId: string
  seq: number
  at: string
  kind: TKind
  payload: TPayload
}
