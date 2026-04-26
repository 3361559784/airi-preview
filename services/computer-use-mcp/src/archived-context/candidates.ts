import type { CompactedBlock, ToolInteractionBlock, TranscriptBlock, TranscriptEntry } from '../transcript/types'
import type { ArchiveCandidate } from './types'

import { parseTranscriptBlocks } from '../transcript/block-parser'
import { compactBlock } from '../transcript/compactor'

export interface ArchiveCandidateOptions {
  /** Maximum number of recent complete tool-interaction blocks kept in prompt. */
  maxFullToolBlocks?: number
  /** Maximum number of recent text-like blocks kept in prompt. */
  maxFullTextBlocks?: number
  /** Maximum number of removed blocks compacted into prompt history. */
  maxCompactedBlocks?: number
}

const DEFAULTS = {
  maxFullToolBlocks: 5,
  maxFullTextBlocks: 3,
  maxCompactedBlocks: 4,
}

/** Minimum normalized content length for text blocks to qualify for archiving. */
const ARCHIVE_TEXT_MIN_LENGTH = 200

/**
 * Build archive candidates using the same retention policy as transcript
 * projection, without making transcript/projector own archive I/O concerns.
 */
export function buildArchiveCandidates(
  transcriptEntries: readonly TranscriptEntry[],
  opts: ArchiveCandidateOptions = {},
): ArchiveCandidate[] {
  const maxFullToolBlocks = opts.maxFullToolBlocks ?? DEFAULTS.maxFullToolBlocks
  const maxFullTextBlocks = opts.maxFullTextBlocks ?? DEFAULTS.maxFullTextBlocks
  const maxCompactedBlocks = opts.maxCompactedBlocks ?? DEFAULTS.maxCompactedBlocks

  const allBlocks = parseTranscriptBlocks(transcriptEntries)
  if (allBlocks.length === 0)
    return []

  const firstUserBlockIdx = allBlocks.findIndex(b => b.kind === 'user')
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

  const completeToolBlocks = toolBlocks.filter(block => isCompleteToolInteraction(block))
  const keptToolBlocks: Set<TranscriptBlock> = new Set(takeLast(completeToolBlocks, maxFullToolBlocks))
  const keptTextBlocks: Set<TranscriptBlock> = new Set(takeLast(textLikeBlocks, maxFullTextBlocks))

  const blocksToCompact: TranscriptBlock[] = []
  for (const block of candidateBlocks) {
    if (keptToolBlocks.has(block) || keptTextBlocks.has(block))
      continue
    blocksToCompact.push(block)
  }

  const compactedSourceBlocks = maxCompactedBlocks <= 0
    ? []
    : blocksToCompact.slice(-maxCompactedBlocks)
  const droppedSourceBlocks = blocksToCompact.slice(0, blocksToCompact.length - compactedSourceBlocks.length)
  const compactedResults: CompactedBlock[] = compactedSourceBlocks.map(block => compactBlock(block))

  return buildCandidatesFromRemovedBlocks(compactedSourceBlocks, droppedSourceBlocks, compactedResults)
}

function buildCandidatesFromRemovedBlocks(
  compactedSourceBlocks: TranscriptBlock[],
  droppedSourceBlocks: TranscriptBlock[],
  compactedResults: CompactedBlock[],
): ArchiveCandidate[] {
  const candidates: ArchiveCandidate[] = []

  function tryAdd(block: TranscriptBlock, reason: ArchiveCandidate['reason'], summary: string): void {
    if (block.kind === 'system' || block.kind === 'user')
      return

    // Orphan tool messages are represented as TextBlocks defensively. They are
    // structurally invalid history, so exclude them before any text length test.
    if (block.kind === 'text' && block.entry.role === 'tool')
      return

    const normalizedContent = normalizeBlockContent(block)
    if (block.kind === 'text' && normalizedContent.length < ARCHIVE_TEXT_MIN_LENGTH)
      return

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

  for (let i = 0; i < compactedSourceBlocks.length; i++) {
    const summary = compactedResults[i]?.summary ?? '[no summary]'
    tryAdd(compactedSourceBlocks[i], 'compacted', summary)
  }

  for (const block of droppedSourceBlocks) {
    tryAdd(block, 'dropped', compactBlock(block).summary)
  }

  return candidates
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

function normalizeBlockContent(block: TranscriptBlock): string {
  switch (block.kind) {
    case 'tool_interaction': {
      const toolCalls = (block.assistant.toolCalls ?? [])
        .map((tc) => {
          let args = tc.function.arguments
          try {
            args = JSON.stringify(JSON.parse(args), null, 2)
          }
          catch {
            // Keep original non-JSON arguments.
          }
          return `Tool: ${tc.function.name}\nArguments:\n${args}`
        })
        .join('\n\n')

      const results = block.toolResults
        .map((tr) => {
          const text = contentToFullString(tr.content)
          return `Result (${tr.toolCallId}):\n${text}`
        })
        .join('\n\n')

      return `${toolCalls}\n\n${results}`.trim()
    }
    case 'text':
    case 'user':
    case 'system':
      return contentToFullString(block.entry.content)
  }
}

function contentToFullString(content: string | unknown[] | undefined): string {
  if (content === undefined || content === null)
    return ''
  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string')
          return part
        if (isTextContentPart(part))
          return part.text
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return String(content)
}

function isTextContentPart(part: unknown): part is { type: 'text', text: string } {
  if (typeof part !== 'object' || part === null)
    return false
  const record = part as { type?: unknown, text?: unknown }
  return record.type === 'text' && typeof record.text === 'string'
}

function extractBlockTags(block: TranscriptBlock): string[] {
  if (block.kind === 'tool_interaction')
    return (block.assistant.toolCalls ?? []).map(tc => tc.function.name)
  return []
}

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
