import type {
  ToolInteractionBlock,
  TranscriptBlock,
  TranscriptEntry,
  UserBlock,
} from './types'

import { parseTranscriptBlocks } from './block-parser'

export interface TranscriptRetentionLimits {
  /** Maximum number of recent complete tool-interaction blocks to keep in full. */
  maxFullToolBlocks: number
  /** Maximum number of recent text-like blocks to keep in full. */
  maxFullTextBlocks: number
  /** Maximum number of removed blocks compacted into prompt history. */
  maxCompactedBlocks: number
}

export type TranscriptRetentionOptions = Partial<TranscriptRetentionLimits>

export const DEFAULT_TRANSCRIPT_RETENTION_LIMITS = {
  maxFullToolBlocks: 5,
  maxFullTextBlocks: 3,
  maxCompactedBlocks: 4,
} as const satisfies TranscriptRetentionLimits

export interface TranscriptRetentionPlan {
  allBlocks: readonly TranscriptBlock[]
  pinnedBlock: UserBlock | null
  candidateBlocks: readonly TranscriptBlock[]
  keptFullBlocks: readonly TranscriptBlock[]
  keptToolBlocks: readonly ToolInteractionBlock[]
  keptTextLikeBlocks: readonly TranscriptBlock[]
  compactedSourceBlocks: readonly TranscriptBlock[]
  droppedSourceBlocks: readonly TranscriptBlock[]
  metadata: {
    totalBlocks: number
    keptFullBlocks: number
    compactedBlocks: number
    droppedBlocks: number
  }
}

/**
 * Compute transcript retention decisions shared by prompt projection and
 * archive candidate generation.
 *
 * This is deliberately planning-only: it does not compact blocks, emit provider
 * messages, generate archive candidates, or apply archive eligibility filters.
 */
export function planTranscriptRetention(
  transcriptEntries: readonly TranscriptEntry[],
  opts: TranscriptRetentionOptions = {},
): TranscriptRetentionPlan {
  const limits = normalizeLimits(opts)
  const allBlocks = parseTranscriptBlocks(transcriptEntries)

  const firstUserBlockIdx = allBlocks.findIndex(block => block.kind === 'user')
  const pinnedBlock = firstUserBlockIdx >= 0 ? (allBlocks[firstUserBlockIdx] as UserBlock) : null
  const candidateBlocks = allBlocks.filter((_, idx) => idx !== firstUserBlockIdx)

  const toolBlocks: ToolInteractionBlock[] = []
  const textLikeBlocks: TranscriptBlock[] = []

  for (const block of candidateBlocks) {
    switch (block.kind) {
      case 'tool_interaction':
        toolBlocks.push(block)
        break
      case 'text':
      case 'system':
      case 'user':
        textLikeBlocks.push(block)
        break
    }
  }

  // Only complete tool interactions may be re-emitted as provider messages.
  // Incomplete interactions must be compacted or dropped so projected history
  // never contains assistant tool_calls without matching tool results.
  const completeToolBlocks = toolBlocks.filter(block => isCompleteToolInteraction(block))
  const keptToolBlocks = takeLast(completeToolBlocks, limits.maxFullToolBlocks)
  const keptTextLikeBlocks = takeLast(textLikeBlocks, limits.maxFullTextBlocks)

  const keptToolBlockSet: Set<TranscriptBlock> = new Set(keptToolBlocks)
  const keptTextLikeBlockSet: Set<TranscriptBlock> = new Set(keptTextLikeBlocks)

  const removedBlocks: TranscriptBlock[] = []
  for (const block of candidateBlocks) {
    if (keptToolBlockSet.has(block) || keptTextLikeBlockSet.has(block))
      continue
    removedBlocks.push(block)
  }

  const compactedSourceBlocks = takeLast(removedBlocks, limits.maxCompactedBlocks)
  const droppedSourceBlocks = removedBlocks.slice(0, removedBlocks.length - compactedSourceBlocks.length)
  const keptFullBlocks = orderBlocksByTranscript([
    ...(pinnedBlock ? [pinnedBlock] : []),
    ...keptToolBlocks,
    ...keptTextLikeBlocks,
  ])

  return {
    allBlocks,
    pinnedBlock,
    candidateBlocks,
    keptFullBlocks,
    keptToolBlocks,
    keptTextLikeBlocks,
    compactedSourceBlocks,
    droppedSourceBlocks,
    metadata: {
      totalBlocks: allBlocks.length,
      keptFullBlocks: keptFullBlocks.length,
      compactedBlocks: compactedSourceBlocks.length,
      droppedBlocks: droppedSourceBlocks.length,
    },
  }
}

function normalizeLimits(opts: TranscriptRetentionOptions): TranscriptRetentionLimits {
  return {
    maxFullToolBlocks: normalizeLimit(opts.maxFullToolBlocks, DEFAULT_TRANSCRIPT_RETENTION_LIMITS.maxFullToolBlocks),
    maxFullTextBlocks: normalizeLimit(opts.maxFullTextBlocks, DEFAULT_TRANSCRIPT_RETENTION_LIMITS.maxFullTextBlocks),
    maxCompactedBlocks: normalizeLimit(opts.maxCompactedBlocks, DEFAULT_TRANSCRIPT_RETENTION_LIMITS.maxCompactedBlocks),
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Math.max(0, value ?? fallback)
}

function isCompleteToolInteraction(block: ToolInteractionBlock): boolean {
  const toolCalls = block.assistant.toolCalls ?? []
  if (toolCalls.length === 0)
    return false

  const resultIds = new Set(
    block.toolResults
      .map(result => result.toolCallId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )

  return toolCalls.every(toolCall => resultIds.has(toolCall.id))
}

function takeLast<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0)
    return []
  return items.slice(-limit)
}

function orderBlocksByTranscript(blocks: readonly TranscriptBlock[]): TranscriptBlock[] {
  return [...blocks].sort((a, b) => a.entryIdRange[0] - b.entryIdRange[0])
}
