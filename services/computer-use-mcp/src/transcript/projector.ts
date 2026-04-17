/**
 * Transcript Projector — assembles the final LLM request from truth sources.
 *
 * Consumes:
 *   1. Transcript entries (from TranscriptStore)
 *   2. Operational trace (from audit.jsonl / session.getRecentTrace())
 *   3. Task memory string
 *   4. Run state + system prompt base
 *
 * Produces:
 *   - `system`: pinned header (system prompt + task memory + run state +
 *               operational trace + compacted transcript summaries)
 *   - `messages`: provider-safe message array containing ONLY original
 *                 transcript-derived messages (no synthetic entries)
 *   - `metadata`: observability data
 *
 * Compacted summaries are projection artifacts. They appear in the `system`
 * prompt under a dedicated section, never as synthetic user/assistant messages
 * in the `messages` array. This preserves role fidelity.
 *
 * Assembly order at call site:
 *   1. projectTranscript(...)  → { system, messages, metadata }
 *   2. generateText({ system, messages })
 */

import type { SessionTraceEntry } from '../types'
import type {
  CompactedBlock,
  TranscriptBlock,
  TranscriptEntry,
  TranscriptProjectedMessage,
  TranscriptProjectionMetadata,
  TranscriptProjectionResult,
} from './types'

import { projectContext } from '../projection/context-projector'
import type { ProjectionInput } from '../projection/types'
import type { RunState } from '../state'
import { parseTranscriptBlocks } from './block-parser'
import { compactBlock } from './compactor'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TranscriptProjectionOptions {
  /** System prompt base text. */
  systemPromptBase?: string
  /** Task memory serialized string. */
  taskMemoryString?: string
  /** Current run state. */
  runState: RunState
  /** Recent operational trace entries (from audit.jsonl). */
  operationalTrace: SessionTraceEntry[]

  /** Maximum number of recent tool-interaction blocks to keep in full. */
  maxFullToolBlocks?: number
  /** Maximum number of recent text blocks to keep in full. */
  maxFullTextBlocks?: number
  /** Maximum number of compacted summary blocks to include in the system prompt. */
  maxCompactedBlocks?: number
}

const DEFAULTS = {
  maxFullToolBlocks: 5,
  maxFullTextBlocks: 3,
  maxCompactedBlocks: 4,
}

/**
 * Project the full transcript into a provider-safe LLM request.
 *
 * Steps:
 *   1. Build the system header (system prompt + task memory + run state + operational trace)
 *      using the existing operational trace projector.
 *   2. Parse transcript entries into blocks.
 *   3. Pin the first user block permanently.
 *   4. Keep the most recent N tool/text blocks in full.
 *   5. Compact oldest non-pinned blocks into deterministic summaries.
 *   6. Merge compacted summaries into the system prompt (NOT into messages).
 *   7. Assemble the final messages array from kept blocks only.
 */
export function projectTranscript(
  transcriptEntries: readonly TranscriptEntry[],
  opts: TranscriptProjectionOptions,
): TranscriptProjectionResult {
  const maxFullToolBlocks = opts.maxFullToolBlocks ?? DEFAULTS.maxFullToolBlocks
  const maxFullTextBlocks = opts.maxFullTextBlocks ?? DEFAULTS.maxFullTextBlocks
  const maxCompactedBlocks = opts.maxCompactedBlocks ?? DEFAULTS.maxCompactedBlocks

  // -----------------------------------------------------------------------
  // Step 1: Build system header via existing operational trace projector
  // -----------------------------------------------------------------------
  const projectionInput: ProjectionInput = {
    trace: opts.operationalTrace,
    runState: opts.runState,
    systemPromptBase: opts.systemPromptBase,
    taskMemoryString: opts.taskMemoryString,
  }
  const { systemHeader, prunedTrace } = projectContext(projectionInput)

  let system = systemHeader
  if (prunedTrace.length > 0) {
    const traceJSON = JSON.stringify(prunedTrace, null, 2)
    system += `\n\n【Recent Operational Trace】\n${traceJSON}`
  }

  // -----------------------------------------------------------------------
  // Step 2: Parse transcript into blocks
  // -----------------------------------------------------------------------
  const allBlocks = parseTranscriptBlocks(transcriptEntries)

  if (allBlocks.length === 0) {
    return {
      system,
      messages: [],
      metadata: {
        totalTranscriptEntries: transcriptEntries.length,
        totalBlocks: 0,
        keptFullBlocks: 0,
        compactedBlocks: 0,
        droppedBlocks: 0,
        projectedMessageCount: 0,
        estimatedCharacters: system.length,
      },
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Pin first user block
  // -----------------------------------------------------------------------
  const firstUserBlockIdx = allBlocks.findIndex(b => b.kind === 'user')
  const pinnedBlock = firstUserBlockIdx >= 0 ? allBlocks[firstUserBlockIdx] : null

  // All blocks except the pinned one, in original order
  const candidateBlocks = allBlocks.filter((_, idx) => idx !== firstUserBlockIdx)

  // -----------------------------------------------------------------------
  // Step 4: Classify candidate blocks and apply limits
  // -----------------------------------------------------------------------
  const toolBlocks = candidateBlocks.filter(b => b.kind === 'tool_interaction')
  const textBlocks = candidateBlocks.filter(b => b.kind === 'text')
  const systemBlocks = candidateBlocks.filter(b => b.kind === 'system')
  const userBlocks = candidateBlocks.filter(b => b.kind === 'user')

  // Keep the most recent N of each category
  const keptToolBlocks: Set<TranscriptBlock> = new Set(toolBlocks.slice(-maxFullToolBlocks))
  const keptTextBlocks: Set<TranscriptBlock> = new Set(textBlocks.slice(-maxFullTextBlocks))

  // System blocks and additional user blocks are always kept
  const alwaysKept = new Set<TranscriptBlock>([...systemBlocks, ...userBlocks])

  // Identify blocks to compact vs drop
  const blocksToCompact: TranscriptBlock[] = []

  for (const block of candidateBlocks) {
    if (alwaysKept.has(block) || keptToolBlocks.has(block) || keptTextBlocks.has(block)) {
      continue // Kept in full
    }
    // This block is not kept → candidate for compaction
    blocksToCompact.push(block)
  }

  // Only keep the most recent N compacted blocks; drop the rest entirely
  const compactedResults: CompactedBlock[] = blocksToCompact
    .slice(-maxCompactedBlocks)
    .map(b => compactBlock(b))
  const finallyDroppedCount = blocksToCompact.length - compactedResults.length

  // -----------------------------------------------------------------------
  // Step 5: Merge compacted summaries into system prompt
  // Compacted summaries are projection artifacts, NOT chat messages.
  // They go into a dedicated system prompt section so the model has
  // context about what happened in the middle of the conversation
  // without corrupting the message role stream.
  // -----------------------------------------------------------------------
  if (compactedResults.length > 0) {
    const summaryLines = compactedResults.map(c => c.summary)
    system += `\n\n【Compacted Transcript Summary (${compactedResults.length} blocks)】\n${summaryLines.join('\n')}`
  }

  // -----------------------------------------------------------------------
  // Step 6: Assemble messages from kept blocks only (chronological order)
  // Only original transcript-derived messages appear here.
  // -----------------------------------------------------------------------
  type EmitItem = { sortKey: number, block: TranscriptBlock }

  const emitItems: EmitItem[] = []

  // Pinned block first
  if (pinnedBlock) {
    emitItems.push({ block: pinnedBlock, sortKey: pinnedBlock.entryIdRange[0] })
  }

  for (const block of candidateBlocks) {
    if (alwaysKept.has(block) || keptToolBlocks.has(block) || keptTextBlocks.has(block)) {
      emitItems.push({ block, sortKey: block.entryIdRange[0] })
    }
  }

  // Sort by original chronological order
  emitItems.sort((a, b) => a.sortKey - b.sortKey)

  // Convert to messages
  const messages: TranscriptProjectedMessage[] = []

  for (const item of emitItems) {
    const block = item.block
    switch (block.kind) {
      case 'user':
      case 'system':
        messages.push(entryToMessage(block.entry))
        break
      case 'text':
        // NOTICE: Orphan tool messages are wrapped as TextBlocks by the parser
        // as a defensive measure. Emitting them with role:tool without a
        // matching assistant tool_call would trigger a provider 400 error.
        // Skip them in projection — they are structurally invalid.
        if (block.entry.role === 'tool') {
          break
        }
        messages.push(entryToMessage(block.entry))
        break
      case 'tool_interaction':
        messages.push(entryToMessage(block.assistant))
        for (const tr of block.toolResults) {
          messages.push(entryToMessage(tr))
        }
        break
    }
  }

  // -----------------------------------------------------------------------
  // Step 7: Build metadata
  // -----------------------------------------------------------------------
  const keptFullCount = (pinnedBlock ? 1 : 0)
    + keptToolBlocks.size
    + keptTextBlocks.size
    + alwaysKept.size

  const estimatedChars = system.length
    + messages.reduce((acc, m) => {
      const contentLen = typeof m.content === 'string'
        ? m.content.length
        : JSON.stringify(m.content ?? '').length
      return acc + contentLen + JSON.stringify(m.tool_calls ?? []).length
    }, 0)

  const metadata: TranscriptProjectionMetadata = {
    totalTranscriptEntries: transcriptEntries.length,
    totalBlocks: allBlocks.length,
    keptFullBlocks: keptFullCount,
    compactedBlocks: compactedResults.length,
    droppedBlocks: finallyDroppedCount,
    projectedMessageCount: messages.length,
    estimatedCharacters: estimatedChars,
  }

  return { system, messages, metadata }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryToMessage(entry: TranscriptEntry): TranscriptProjectedMessage {
  const msg: TranscriptProjectedMessage = {
    role: entry.role,
    content: entry.content,
  }
  if (entry.toolCalls && entry.toolCalls.length > 0) {
    msg.tool_calls = entry.toolCalls
  }
  if (entry.toolCallId) {
    msg.tool_call_id = entry.toolCallId
  }
  return msg
}
