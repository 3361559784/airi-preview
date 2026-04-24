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
  ArchiveCandidate,
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
      archiveCandidates: [],
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

  // Only keep the most recent N compacted blocks; drop the rest entirely.
  // NOTICE: We must handle maxCompactedBlocks=0 explicitly because slice(-0)
  // is identical to slice(0) in JavaScript, which would return the full array
  // instead of an empty one. The explicit branch avoids this footgun.
  let droppedSourceBlocks: TranscriptBlock[]
  let compactedSourceBlocks: TranscriptBlock[]
  if (maxCompactedBlocks <= 0) {
    droppedSourceBlocks = blocksToCompact
    compactedSourceBlocks = []
  }
  else {
    droppedSourceBlocks = blocksToCompact.slice(0, -maxCompactedBlocks)
    compactedSourceBlocks = blocksToCompact.slice(-maxCompactedBlocks)
  }
  const compactedResults: CompactedBlock[] = compactedSourceBlocks.map(b => compactBlock(b))
  const finallyDroppedCount = droppedSourceBlocks.length

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

  // -----------------------------------------------------------------------
  // Step 8: Build archive candidates from compacted + dropped blocks
  // -----------------------------------------------------------------------
  const archiveCandidates = buildArchiveCandidates(compactedSourceBlocks, droppedSourceBlocks, compactedResults)

  return { system, messages, metadata, archiveCandidates }
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

/**
 * Coerce entry content to a string for archive persistence.
 * Unlike the compactor's snippet(), this preserves the full text.
 */
function contentToFullString(content: string | unknown[] | undefined): string {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text' && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return String(content)
}

/**
 * Produce the full normalized content of a transcript block for archive persistence.
 *
 * NOTICE: This is intentionally separate from compactor.ts snippet() which truncates
 * to 120 chars. Archive normalizedContent preserves the full text so humans can
 * read it and future retrieval systems can search it.
 */
function normalizeBlockContent(block: TranscriptBlock): string {
  switch (block.kind) {
    case 'tool_interaction': {
      const toolCalls = (block.assistant.toolCalls ?? [])
        .map((tc) => {
          let args = tc.function.arguments
          // Attempt to pretty-print JSON arguments, but don't fail
          try { args = JSON.stringify(JSON.parse(args), null, 2) } catch {}
          return `Tool: ${tc.function.name}\nArguments:\n${args}`
        })
        .join('\n\n')

      const results = block.toolResults
        .map((tr) => {
          const text = contentToFullString(tr.content)
          return `Result (${tr.toolCallId}):\n${text}`
        })
        .join('\n\n')

      return `${toolCalls}\n\n${results}`
    }
    case 'text':
    case 'user':
    case 'system':
      return contentToFullString(block.entry.content)
  }
}

/**
 * Extract tags from a transcript block for archive metadata.
 */
function extractBlockTags(block: TranscriptBlock): string[] {
  if (block.kind === 'tool_interaction') {
    return (block.assistant.toolCalls ?? []).map(tc => tc.function.name)
  }
  return []
}

/**
 * Get the earliest timestamp from a transcript block.
 */
function getBlockCreatedAt(block: TranscriptBlock): string {
  switch (block.kind) {
    case 'tool_interaction':
      return block.assistant.at
    case 'text':
    case 'user':
    case 'system':
      return block.entry.at
  }
}

/** Minimum normalized content length for text blocks to qualify for archiving. */
const ARCHIVE_TEXT_MIN_LENGTH = 200

/**
 * Build archive candidates from compacted and dropped source blocks.
 *
 * Eligibility filter (order matters):
 *   1. Skip system blocks
 *   2. Skip user blocks
 *   3. Skip orphan tool blocks (TextBlock wrapping a role:tool entry)
 *   4. Skip text blocks with normalizedContent < 200 chars
 *   5. Everything else → ArchiveCandidate
 */
function buildArchiveCandidates(
  compactedSourceBlocks: TranscriptBlock[],
  droppedSourceBlocks: TranscriptBlock[],
  compactedResults: CompactedBlock[],
): ArchiveCandidate[] {
  const candidates: ArchiveCandidate[] = []

  function tryAdd(block: TranscriptBlock, reason: 'compacted' | 'dropped', summary: string) {
    // Skip system and user blocks
    if (block.kind === 'system' || block.kind === 'user') return

    // Skip orphan tool blocks (defensive TextBlock wrapping a role:tool entry)
    if (block.kind === 'text' && block.entry.role === 'tool') return

    const normalizedContent = normalizeBlockContent(block)

    // Skip short text blocks
    if (block.kind === 'text' && normalizedContent.length < ARCHIVE_TEXT_MIN_LENGTH) return

    candidates.push({
      reason,
      originalKind: block.kind,
      entryIdRange: block.entryIdRange,
      summary,
      normalizedContent,
      createdAt: getBlockCreatedAt(block),
      tags: extractBlockTags(block),
    })
  }

  // Compacted blocks have matching CompactedBlock summaries
  for (let i = 0; i < compactedSourceBlocks.length; i++) {
    const summary = compactedResults[i]?.summary ?? '[no summary]'
    tryAdd(compactedSourceBlocks[i], 'compacted', summary)
  }

  // Dropped blocks need their own summary (generate via compactBlock)
  for (const block of droppedSourceBlocks) {
    const compact = compactBlock(block)
    tryAdd(block, 'dropped', compact.summary)
  }

  return candidates
}
