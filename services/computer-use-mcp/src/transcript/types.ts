/**
 * Transcript Truth Source — types for the LLM conversation transcript store.
 *
 * This is SEPARATE from `SessionTraceEntry` / `audit.jsonl`.
 * `audit.jsonl` records operational events (requested, executed, failed, etc.).
 * `transcript.jsonl` records the actual LLM conversation messages.
 *
 * The transcript store is append-only. Prompt pruning never deletes entries;
 * it only controls which entries get projected into the next LLM request.
 */

// ---------------------------------------------------------------------------
// 1. Transcript Entry — the atomic unit persisted to transcript.jsonl
// ---------------------------------------------------------------------------

/**
 * A single entry in the transcript truth source.
 * Preserves the xsai/OpenAI message shape needed for faithful replay.
 */
export interface TranscriptEntry {
  /** Unique monotonic ID within this session. */
  id: number
  /** ISO timestamp of when this entry was recorded. */
  at: string
  /** The message role. */
  role: 'user' | 'assistant' | 'tool' | 'system'
  /**
   * Message content. Accepts the same forms xsai / OpenAI wire format uses:
   * - `string` for plain text
   * - `unknown[]` for structured content parts (TextContentPart[], etc.)
   * - `undefined` for assistant messages that only contain tool_calls
   */
  content?: string | unknown[]
  /**
   * For assistant messages that invoke tools.
   * Preserved in xsai/OpenAI wire format.
   */
  toolCalls?: TranscriptToolCall[]
  /**
   * For tool result messages — the id of the tool_call this responds to.
   */
  toolCallId?: string
}

export interface TranscriptToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// ---------------------------------------------------------------------------
// 2. Transcript Block — logical grouping of transcript entries
// ---------------------------------------------------------------------------

/**
 * A "block" is the atomic unit of prompt projection.
 * You never split a block — either the full block appears in the prompt
 * or it is compacted / dropped entirely.
 */
export type TranscriptBlock =
  | ToolInteractionBlock
  | TextBlock
  | SystemBlock
  | UserBlock

export interface ToolInteractionBlock {
  kind: 'tool_interaction'
  /** The assistant message containing tool_calls. */
  assistant: TranscriptEntry
  /** All tool result messages matching the assistant's tool_call ids. */
  toolResults: TranscriptEntry[]
  /** Inclusive entry id range [first, last] for ordering. */
  entryIdRange: [number, number]
}

export interface TextBlock {
  kind: 'text'
  /** A single assistant text-only message (no tool_calls). */
  entry: TranscriptEntry
  entryIdRange: [number, number]
}

export interface SystemBlock {
  kind: 'system'
  entry: TranscriptEntry
  entryIdRange: [number, number]
}

export interface UserBlock {
  kind: 'user'
  entry: TranscriptEntry
  entryIdRange: [number, number]
}

// ---------------------------------------------------------------------------
// 3. Compacted Block — deterministic summary of a dropped block
// ---------------------------------------------------------------------------

/**
 * A compacted summary of a transcript block that was removed from the prompt.
 * Explicitly tagged so it cannot be confused with original transcript.
 */
export interface CompactedBlock {
  kind: 'compacted'
  /** Which original block kind this summarizes. */
  originalKind: TranscriptBlock['kind']
  /** Human-readable deterministic summary. */
  summary: string
  /** Entry id range of the original block. */
  entryIdRange: [number, number]
}

// ---------------------------------------------------------------------------
// 4. Archive Candidate — a block removed from prompt eligible for archiving
// ---------------------------------------------------------------------------

/**
 * Describes a transcript block that was removed from the active prompt
 * (compacted or dropped) and is eligible for persistence to the archive layer.
 *
 * Produced by the projector as a pure data structure — no I/O happens inside
 * the projector. The call site decides whether and where to persist.
 */
export interface ArchiveCandidate {
  /** Why this block was removed from the prompt. */
  reason: 'compacted' | 'dropped'
  /** Original block kind before removal. */
  originalKind: TranscriptBlock['kind']
  /** Entry id range of the source block. */
  entryIdRange: [number, number]
  /** Deterministic short summary (same as what goes into system prompt). */
  summary: string
  /** Full normalized content for archive persistence (NOT truncated). */
  normalizedContent: string
  /** ISO timestamp of the earliest entry in the block. */
  createdAt: string
  /** Tags derived from block content (tool names, etc). */
  tags: string[]
}

// ---------------------------------------------------------------------------
// 5. Projection Output — what the projection layer produces
// ---------------------------------------------------------------------------

export type ProjectedBlock = TranscriptBlock | CompactedBlock

export interface TranscriptProjectionResult {
  /**
   * The system prompt header (pinned: system prompt base + task memory + run state).
   */
  system: string
  /**
   * The projected messages array, ready to pass to generateText().
   * Provider-safe: no orphan tool messages, no broken tool_call pairs.
   */
  messages: TranscriptProjectedMessage[]
  /** Projection metadata for observability. */
  metadata: TranscriptProjectionMetadata
  /**
   * Blocks removed from the prompt that are eligible for archive persistence.
   * Produced deterministically — the projector does no I/O.
   */
  archiveCandidates: ArchiveCandidate[]
}

export interface TranscriptProjectedMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content?: string | unknown[]
  tool_calls?: TranscriptToolCall[]
  tool_call_id?: string
}

export interface TranscriptProjectionMetadata {
  /** Total transcript entries in the truth source. */
  totalTranscriptEntries: number
  /** Number of blocks identified. */
  totalBlocks: number
  /** Number of blocks kept in full. */
  keptFullBlocks: number
  /** Number of blocks compacted into summaries. */
  compactedBlocks: number
  /** Number of blocks dropped entirely (neither kept nor compacted). */
  droppedBlocks: number
  /** Number of projected messages in the output array. */
  projectedMessageCount: number
  /** Rough character count of the projected messages. */
  estimatedCharacters: number
}
