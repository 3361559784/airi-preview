import type { ExecuteAction } from '../server/action-executor'
import type { ComputerUseServerRuntime } from '../server/runtime'
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
  maxSteps?: number
  stepTimeoutMs?: number
  /**
   * Explicit run identifier for archive deduplication.
   * Generated via crypto.randomUUID() if omitted.
   */
  runId?: string
}

export interface CodingRunnerTurnResult {
  role: 'tool' | 'assistant' | 'timeout'
  toolName?: string
  toolArgs?: unknown
  resultOk?: boolean
  rawText?: string
}

export interface CodingRunnerResult {
  status: 'completed' | 'timeout' | 'failed' | 'crash'
  totalSteps: number
  transcriptMetadata?: TranscriptProjectionMetadata
  turns: CodingRunnerTurnResult[]
  error?: string
}

export interface CodingRunner {
  runCodingTask(params: RunCodingTaskParams): Promise<CodingRunnerResult>
}
