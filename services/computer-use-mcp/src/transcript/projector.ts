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
 *   - `system`: pinned header (system prompt + task memory + run state + operational trace)
 *   - `messages`: provider-safe message array with compacted summaries in middle
 *   - `metadata`: observability data
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
  /** Maximum number of compacted summary blocks to include in the middle. */
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
 *   5. Compact oldest non-pinned blocks into summaries.
 *   6. Assemble the final messages array in correct chronological order.
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
  const droppedBlocks: TranscriptBlock[] = []

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
  // Step 5: Assemble in chronological order
  // -----------------------------------------------------------------------
  // Build a map of entryIdRange[0] → what to emit for each candidate block
  type EmitItem = { sortKey: number } & (
    | { type: 'full', block: TranscriptBlock }
    | { type: 'compacted', compacted: CompactedBlock }
  )

  const emitItems: EmitItem[] = []

  // Pinned block first
  if (pinnedBlock) {
    emitItems.push({ type: 'full', block: pinnedBlock, sortKey: pinnedBlock.entryIdRange[0] })
  }

  // Build a Set of compacted entryIdRange starts for lookup
  const compactedRangeStarts = new Set(compactedResults.map(c => c.entryIdRange[0]))

  for (const block of candidateBlocks) {
    if (alwaysKept.has(block) || keptToolBlocks.has(block) || keptTextBlocks.has(block)) {
      emitItems.push({ type: 'full', block, sortKey: block.entryIdRange[0] })
    }
  }

  for (const compacted of compactedResults) {
    emitItems.push({ type: 'compacted', compacted, sortKey: compacted.entryIdRange[0] })
  }

  // Sort by original chronological order
  emitItems.sort((a, b) => a.sortKey - b.sortKey)

  // Convert to messages
  const messages: TranscriptProjectedMessage[] = []

  for (const item of emitItems) {
    if (item.type === 'full') {
      const block = item.block
      switch (block.kind) {
        case 'user':
        case 'system':
        case 'text':
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
    else {
      // Compacted → inject as a system message with the summary
      messages.push({
        role: 'user',
        content: item.compacted.summary,
      })
    }
  }

  // -----------------------------------------------------------------------
  // Step 6: Build metadata
  // -----------------------------------------------------------------------
  const keptFullCount = (pinnedBlock ? 1 : 0)
    + keptToolBlocks.size
    + keptTextBlocks.size
    + alwaysKept.size

  const estimatedChars = system.length
    + messages.reduce((acc, m) => acc + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? []).length, 0)

  const metadata: TranscriptProjectionMetadata = {
    totalTranscriptEntries: transcriptEntries.length,
    totalBlocks: allBlocks.length,
    keptFullBlocks: keptFullCount,
    compactedBlocks: compactedResults.length,
    droppedBlocks: finallyDroppedCount,
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
