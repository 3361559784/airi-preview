/**
 * Context Projection & Runtime Pruning Architecture Contract
 *
 * This module defines the strict, read-only boundary between the persistent
 * truth sources (Run State, Task Memory, Session Trace) and the ephemeral
 * message array projected to the LLM.
 *
 * @see implementation_plan.md "Architecture Contract: Context Projection & Runtime Pruning"
 */

import type { RunState } from '../state'
import type { SessionTraceEntry } from '../types'

// ---------------------------------------------------------------------------
// 1. Truth Source Contract
// ---------------------------------------------------------------------------

/**
 * The immutable input sources for a single projection operation.
 * The Projection Layer has strictly READ-ONLY access to these sources.
 */
export interface ProjectionInput {
  /**
   * The persistent audit trail of the current session.
   * Represents the objective, immutable history of actions and results.
   */
  trace: SessionTraceEntry[]

  /**
   * The ephemeral "dashboard" of the current executing task, serialized to string.
   * Typically generated via `TaskMemoryManager.toContextString()`.
   */
  taskMemoryString?: string

  /**
   * The dynamic engine cursor.
   * Used for resolving budgets, UI bounds, and active app requirements.
   */
  runState: RunState

  /**
   * Optional system prompt overrides (e.g. for specific tools or surfaces).
   */
  systemPromptBase?: string
}

// ---------------------------------------------------------------------------
// 2. Pruning Policy Configuration
// ---------------------------------------------------------------------------

export interface RuntimePruningPolicy {
  /**
   * How many completely un-pruned `SessionTraceEntry` payloads to keep.
   * Everything older than this limit will undergo payload trimming.
   */
  intactTraceEventLimit: number

  /**
   * Maximum length (in chars) for a single trace event result before it undergoes
   * soft-truncation even if it's within the intact limit.
   */
  maxResultLengthBeforeSoftTruncation: number

  /**
   * Whether to pin the `taskMemory` summary and the `systemPromptBase`
   * at the top.
   */
  pinSystemHeader: boolean
}

const DEFAULT_PRUNING_POLICY: RuntimePruningPolicy = {
  intactTraceEventLimit: 8,
  maxResultLengthBeforeSoftTruncation: 12000,
  pinSystemHeader: true,
}

// ---------------------------------------------------------------------------
// 3. Projected Output Contract
// ---------------------------------------------------------------------------

/**
 * A single operational trace item projected from a SessionTraceEntry.
 * Represents an execution event (requested/executed/failed/etc.), NOT an LLM
 * conversational turn. The full conversational LLM transcript is stored separately
 * in the TranscriptStore (transcript.jsonl) and merged during final prompting.
 */
export interface ProjectedOperationalTrace {
  /** The sequence index or order */
  index: number
  /** The trace event type (e.g. 'requested', 'executed', 'failed') */
  event: string
  /** The target tool name */
  toolName?: string
  /** The action parameters (if exposed and not pruned) */
  actionPayload?: Record<string, unknown>
  /** The operation result or error (if exposed and not pruned) */
  resultPayload?: Record<string, unknown>
  /** Summary message for pruned events */
  summary?: string
  /** Whether this event was modified by the pruning algorithm. */
  pruned: boolean
}

/**
 * The final output of the projection layer.
 * A purely ephemeral container that MUST be discarded after the LLM call.
 * NEVER writes back to `RunState`, `TaskMemory`, or the JSONL trace.
 */
export interface ProjectedContext {
  /**
   * The pinned system header text, combining prompt overriding,
   * run state, and task memory summary.
   */
  systemHeader: string

  /**
   * The formatted, pruned operational sequence from the `audit` trace.
   */
  prunedTrace: ProjectedOperationalTrace[]

  /**
   * Metadata describing how the pruning algorithm behaved.
   * Useful for debugging and transparency.
   */
  metadata: {
    originalTraceLength: number
    prunedTraceEvents: number
    estimatedTokens?: number
  }
}

// ---------------------------------------------------------------------------
// 4. Projection Pipeline Definition
// ---------------------------------------------------------------------------

/**
 * The core contract signature for the Projection Pipeline.
 * Takes the raw Truth Sources and purely transforms them into an LLM-ready Context.
 */
export type ContextProjector = (
  input: ProjectionInput,
  policy?: Partial<RuntimePruningPolicy>
) => ProjectedContext
