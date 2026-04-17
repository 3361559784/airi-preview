/**
 * Runner-side message pruning for xsai / OpenAI-compatible providers.
 *
 * Purpose: keep `messagesCache` within a safe token window while strictly
 * preserving the structural invariants that providers enforce:
 *
 *   1. Every `ToolMessage` must have a preceding `AssistantMessage` that
 *      contains a matching `tool_call.id`. Orphan tool messages → API 400.
 *   2. Every `tool_call.id` in an `AssistantMessage` must have a corresponding
 *      `ToolMessage`. Missing response → API 400.
 *   3. The first user instruction must always be pinned at index 0 so the
 *      model never loses its original task goal.
 *
 * This module only operates on message array structure. It never reads or
 * writes `RunState`, `TaskMemory`, or `audit.jsonl`.
 *
 * The upstream `projectContext()` call (in src/projection/) is responsible
 * for re-injecting the operational trace summary into the system prompt,
 * compensating for whatever context is removed here.
 *
 * Assembly order (per step):
 *   1. projectContext(...)  → systemHeader  (system prompt slot)
 *   2. pruneMessageSequence(messagesCache, opts) → messages  (chat history slot)
 *   3. generateText({ system: systemHeader, messages })
 */

import type { AssistantMessage, Message, ToolMessage } from '@xsai/generate-text'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PruneOptions {
  /**
   * Maximum number of complete tool-interaction turns (assistant + its tool
   * results) to retain in the sliding window. Older complete turns are dropped.
   * @default 5
   */
  maxToolTurns?: number

  /**
   * Maximum number of plain assistant text turns (no tool calls) to retain.
   * These are dropped from the oldest end before tool turns are evaluated.
   * @default 3
   */
  maxTextTurns?: number
}

export interface PruneResult {
  messages: Message[]
  /** How many complete tool-interaction chunks were dropped. */
  droppedToolTurns: number
  /** How many plain assistant text chunks were dropped. */
  droppedTextTurns: number
}

/**
 * Segments and slides the message array to keep the most recent turns.
 *
 * - Pins the first UserMessage at position 0 permanently.
 * - Groups assistant messages + their matching tool responses into Chunks.
 * - Drops the oldest Chunks until within the configured limits.
 * - Never splits a Chunk (no orphan tool or tool-call messages).
 */
export function pruneMessageSequence(
  messages: Message[],
  opts: PruneOptions = {},
): PruneResult {
  const maxToolTurns = opts.maxToolTurns ?? 5
  const maxTextTurns = opts.maxTextTurns ?? 3

  if (messages.length === 0) {
    return { messages: [], droppedToolTurns: 0, droppedTextTurns: 0 }
  }

  // Pin the first UserMessage (index 0 by convention).
  // If somehow the first message is not a user, we still pin it — the caller
  // is responsible for building a valid initial array.
  const pinned = messages[0]
  const rest = messages.slice(1)

  // -------------------------------------------------------------------------
  // Partition `rest` into a sequence of Chunks.
  //
  // Chunk variants:
  //   - ToolTurnChunk:  AssistantMessage(tool_calls) + N ToolMessages
  //   - TextTurnChunk:  AssistantMessage(no tool_calls) (or lone user message)
  //   - SystemChunk:    SystemMessage (preserved as-is, not counted in limits)
  // -------------------------------------------------------------------------

  const chunks = buildChunks(rest)

  // Separate by kind for independent limit enforcement
  const toolTurnChunks = chunks.filter(c => c.kind === 'tool')
  const textTurnChunks = chunks.filter(c => c.kind === 'text')
  const systemChunks = chunks.filter(c => c.kind === 'system')

  // Drop oldest chunks to fit within limits
  const keptToolTurns = toolTurnChunks.slice(-maxToolTurns)
  const keptTextTurns = textTurnChunks.slice(-maxTextTurns)

  const droppedToolTurns = toolTurnChunks.length - keptToolTurns.length
  const droppedTextTurns = textTurnChunks.length - keptTextTurns.length

  // Re-interleave in original order: keep system chunks, kept tool turns, kept text turns
  // We rebuild by filtering the original chunk sequence to only kept ones.
  const keptToolSet = new Set(keptToolTurns)
  const keptTextSet = new Set(keptTextTurns)

  const finalChunks = chunks.filter((c) => {
    if (c.kind === 'system')
      return true
    if (c.kind === 'tool')
      return keptToolSet.has(c)
    if (c.kind === 'text')
      return keptTextSet.has(c)
    return false
  })

  const finalMessages: Message[] = [
    pinned,
    ...finalChunks.flatMap(c => c.messages),
  ]

  return { messages: finalMessages, droppedToolTurns, droppedTextTurns }
}

// ---------------------------------------------------------------------------
// Internal chunk representation
// ---------------------------------------------------------------------------

interface BaseChunk {
  messages: Message[]
}

interface ToolTurnChunk extends BaseChunk {
  kind: 'tool'
  /** The tool_call ids claimed by the lead assistant message. */
  toolCallIds: Set<string>
}

interface TextTurnChunk extends BaseChunk {
  kind: 'text'
}

interface SystemChunk extends BaseChunk {
  kind: 'system'
}

type Chunk = ToolTurnChunk | TextTurnChunk | SystemChunk

/**
 * Partitions a message array (everything after the pinned head) into Chunks.
 *
 * Walk forward through messages:
 *   - `role:system` → SystemChunk (standalone)
 *   - `role:user` (mid-conversation) → TextTurnChunk (standalone; these appear
 *     when the orchestrator injects follow-up user messages)
 *   - `role:assistant` with `tool_calls` present → open a ToolTurnChunk,
 *     consume subsequent `role:tool` messages that match any of the declared ids
 *   - `role:assistant` without `tool_calls` → TextTurnChunk
 *   - `role:tool` not preceded by a matching assistant message → treat as
 *     TextTurnChunk (defensive; should not appear in valid sequences)
 */
function buildChunks(messages: Message[]): Chunk[] {
  const chunks: Chunk[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]

    if (msg.role === 'system') {
      chunks.push({ kind: 'system', messages: [msg] })
      i++
      continue
    }

    if (msg.role === 'user') {
      // Mid-conversation user message — treat as text turn
      chunks.push({ kind: 'text', messages: [msg] })
      i++
      continue
    }

    if (msg.role === 'assistant') {
      const assistant = msg as AssistantMessage
      const toolCalls = assistant.tool_calls

      if (toolCalls && toolCalls.length > 0) {
        // Tool-interaction turn: collect all matching tool result messages
        const claimedIds = new Set<string>(toolCalls.map(tc => tc.id))
        const chunkMessages: Message[] = [assistant]
        i++

        // Consume adjacent tool messages that match any claimed id.
        // We stop as soon as we hit a message that is not a matching tool message.
        // NOTICE: providers require ALL tool_call_ids to be answered before the
        // next assistant turn. We collect them all greedily here.
        while (i < messages.length && messages[i].role === 'tool') {
          const toolMsg = messages[i] as ToolMessage
          if (claimedIds.has(toolMsg.tool_call_id)) {
            chunkMessages.push(toolMsg)
            i++
          }
          else {
            // Orphan tool message from a different assistant turn;
            // stop and let the outer loop handle it.
            break
          }
        }

        chunks.push({
          kind: 'tool',
          messages: chunkMessages,
          toolCallIds: claimedIds,
        })
      }
      else {
        // Plain assistant text response (no tool calls)
        chunks.push({ kind: 'text', messages: [assistant] })
        i++
      }
      continue
    }

    if (msg.role === 'tool') {
      // Defensive path: orphan tool message without a preceding matching
      // assistant message. Preserve it as a text chunk; the provider may
      // still accept it depending on leniency, but we do not drop it silently.
      chunks.push({ kind: 'text', messages: [msg] })
      i++
      continue
    }

    // Unknown role (e.g. 'developer') — pass through as system
    chunks.push({ kind: 'system', messages: [msg] })
    i++
  }

  return chunks
}
