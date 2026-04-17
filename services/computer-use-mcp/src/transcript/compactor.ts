/**
 * Deterministic Compactor — summarizes transcript blocks without LLM calls.
 *
 * When a transcript block is removed from the prompt, the compactor generates
 * a lightweight, deterministic summary so the model doesn't experience a
 * complete context blackout in the middle of the conversation.
 *
 * Rules:
 *   - Tool interaction blocks: tool name, success/failure, key param/result hints
 *   - Text blocks: truncated first N chars of the assistant text
 *   - User blocks: truncated first N chars
 *   - System blocks: "[system message]"
 *   - Compacted blocks are explicitly tagged — they cannot be confused with
 *     original transcript entries.
 */

import type { CompactedBlock, TranscriptBlock } from './types'

/** Maximum characters for content snippets in compacted summaries. */
const SUMMARY_SNIPPET_LENGTH = 120

/**
 * Generate a deterministic compacted summary for a transcript block.
 */
export function compactBlock(block: TranscriptBlock): CompactedBlock {
  switch (block.kind) {
    case 'tool_interaction': {
      const toolNames = (block.assistant.toolCalls ?? [])
        .map(tc => tc.function.name)
        .join(', ')

      const resultSummaries = block.toolResults.map((tr) => {
        const content = tr.content ?? ''
        const snippet = content.slice(0, SUMMARY_SNIPPET_LENGTH)
        const isError = content.toLowerCase().includes('error')
          || content.toLowerCase().includes('failed')
        return `${tr.toolCallId}: ${isError ? 'FAILED' : 'ok'} — ${snippet}${content.length > SUMMARY_SNIPPET_LENGTH ? '…' : ''}`
      })

      const summary = [
        `[Compacted tool interaction] Tools: ${toolNames}`,
        ...resultSummaries.map(r => `  ${r}`),
      ].join('\n')

      return {
        kind: 'compacted',
        originalKind: 'tool_interaction',
        summary,
        entryIdRange: block.entryIdRange,
      }
    }

    case 'text': {
      const content = block.entry.content ?? ''
      const snippet = content.slice(0, SUMMARY_SNIPPET_LENGTH)
      return {
        kind: 'compacted',
        originalKind: 'text',
        summary: `[Compacted ${block.entry.role} text] ${snippet}${content.length > SUMMARY_SNIPPET_LENGTH ? '…' : ''}`,
        entryIdRange: block.entryIdRange,
      }
    }

    case 'user': {
      const content = block.entry.content ?? ''
      const snippet = content.slice(0, SUMMARY_SNIPPET_LENGTH)
      return {
        kind: 'compacted',
        originalKind: 'user',
        summary: `[Compacted user message] ${snippet}${content.length > SUMMARY_SNIPPET_LENGTH ? '…' : ''}`,
        entryIdRange: block.entryIdRange,
      }
    }

    case 'system': {
      return {
        kind: 'compacted',
        originalKind: 'system',
        summary: '[Compacted system message]',
        entryIdRange: block.entryIdRange,
      }
    }
  }
}
