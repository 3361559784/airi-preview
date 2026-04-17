import { describe, expect, it } from 'vitest'

import type { Message } from '@xsai/generate-text'

import { pruneMessageSequence } from './message-pruning'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function user(content: string): Message {
  return { role: 'user', content }
}

function assistant(content: string): Message {
  return { role: 'assistant', content }
}

function assistantWithCalls(ids: string[]): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: ids.map(id => ({
      id,
      type: 'function' as const,
      function: { name: 'some_tool', arguments: '{}' },
    })),
  }
}

function toolResult(tool_call_id: string): Message {
  return { role: 'tool', tool_call_id, content: `result for ${tool_call_id}` }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pruneMessageSequence', () => {
  it('returns empty array unchanged', () => {
    const { messages, droppedToolTurns, droppedTextTurns } = pruneMessageSequence([])
    expect(messages).toEqual([])
    expect(droppedToolTurns).toBe(0)
    expect(droppedTextTurns).toBe(0)
  })

  it('pins the first user message and never drops it', () => {
    const msgs: Message[] = [
      user('initial task'),
      assistantWithCalls(['tc1']),
      toolResult('tc1'),
      assistantWithCalls(['tc2']),
      toolResult('tc2'),
      assistantWithCalls(['tc3']),
      toolResult('tc3'),
      assistantWithCalls(['tc4']),
      toolResult('tc4'),
      assistantWithCalls(['tc5']),
      toolResult('tc5'),
      assistantWithCalls(['tc6']),
      toolResult('tc6'),
    ]

    // maxToolTurns=5 → should keep tc2..tc6, drop tc1 turn
    const { messages, droppedToolTurns } = pruneMessageSequence(msgs, { maxToolTurns: 5 })

    expect(messages[0]).toEqual(user('initial task'))
    expect(droppedToolTurns).toBe(1)
    // tc1 turn pruned; tc2..tc6 turn kept
    expect(messages).toHaveLength(1 + 5 * 2) // pinned + 5 turns × (assistant + tool)
  })

  it('keeps a single assistant with a single tool_call as an indivisible chunk', () => {
    const msgs: Message[] = [
      user('do it'),
      assistantWithCalls(['tc1']),
      toolResult('tc1'),
    ]

    const { messages, droppedToolTurns } = pruneMessageSequence(msgs, { maxToolTurns: 5 })
    expect(messages).toHaveLength(3)
    expect(droppedToolTurns).toBe(0)
  })

  it('keeps assistant with multiple tool_calls and all tool results as one chunk', () => {
    const msgs: Message[] = [
      user('do it'),
      assistantWithCalls(['tc1', 'tc2', 'tc3']),
      toolResult('tc1'),
      toolResult('tc2'),
      toolResult('tc3'),
    ]

    const { messages, droppedToolTurns } = pruneMessageSequence(msgs, { maxToolTurns: 5 })
    expect(messages).toHaveLength(5)
    expect(droppedToolTurns).toBe(0)
  })

  it('drops the oldest tool turn as a complete chunk when limit is exceeded', () => {
    // 3 tool turns, maxToolTurns=2 → oldest (tc1) dropped
    const msgs: Message[] = [
      user('initial task'),
      assistantWithCalls(['tc1']),
      toolResult('tc1'),
      assistantWithCalls(['tc2']),
      toolResult('tc2'),
      assistantWithCalls(['tc3']),
      toolResult('tc3'),
    ]

    const { messages, droppedToolTurns } = pruneMessageSequence(msgs, { maxToolTurns: 2 })
    expect(droppedToolTurns).toBe(1)
    // Remaining: pinned user + tc2 turn + tc3 turn
    expect(messages).toHaveLength(1 + 2 * 2)
    expect(messages[0]).toEqual(user('initial task'))
    // tc1 messages must NOT appear
    const allIds = messages
      .filter(m => m.role === 'tool')
      .map(m => (m as any).tool_call_id)
    expect(allIds).not.toContain('tc1')
  })

  it('no orphan tool message exists after pruning', () => {
    const msgs: Message[] = [
      user('task'),
      assistantWithCalls(['tc1']),
      toolResult('tc1'),
      assistantWithCalls(['tc2']),
      toolResult('tc2'),
      assistantWithCalls(['tc3']),
      toolResult('tc3'),
    ]

    const { messages } = pruneMessageSequence(msgs, { maxToolTurns: 2 })

    // Collect all tool_call ids declared in assistant messages
    const declaredIds = new Set<string>()
    for (const m of messages) {
      if (m.role === 'assistant') {
        const a = m as any
        if (a.tool_calls) {
          for (const tc of a.tool_calls) declaredIds.add(tc.id)
        }
      }
    }

    // Every tool result must have a declared id
    for (const m of messages) {
      if (m.role === 'tool') {
        const t = m as any
        expect(declaredIds.has(t.tool_call_id)).toBe(true)
      }
    }
  })

  it('keeps most recent tool turns when many exceed limit', () => {
    // 6 tool turns, keep last 2
    const turns = ['a', 'b', 'c', 'd', 'e', 'f']
    const msgs: Message[] = [
      user('task'),
      ...turns.flatMap(id => [assistantWithCalls([id]), toolResult(id)]),
    ]

    const { messages, droppedToolTurns } = pruneMessageSequence(msgs, { maxToolTurns: 2 })
    expect(droppedToolTurns).toBe(4)

    const keptIds = messages
      .filter(m => m.role === 'tool')
      .map(m => (m as any).tool_call_id)
    expect(keptIds).toEqual(['e', 'f'])
  })

  it('handles plain assistant text turns independently from tool turns', () => {
    const msgs: Message[] = [
      user('task'),
      assistant('thinking...'),
      assistant('still thinking...'),
      assistant('final thought'),
    ]

    const { messages, droppedTextTurns } = pruneMessageSequence(msgs, { maxToolTurns: 5, maxTextTurns: 2 })
    expect(droppedTextTurns).toBe(1)
    // Pinned + 2 kept text turns
    expect(messages).toHaveLength(3)
  })

  it('does not drop tool turns just because text turns exceed limit', () => {
    const msgs: Message[] = [
      user('task'),
      assistant('thinking 1'),
      assistant('thinking 2'),
      assistant('thinking 3'),
      assistantWithCalls(['tc1']),
      toolResult('tc1'),
    ]

    const { messages, droppedToolTurns, droppedTextTurns } = pruneMessageSequence(msgs, {
      maxToolTurns: 5,
      maxTextTurns: 1,
    })

    // Only 1 text turn kept (latest), 2 dropped
    expect(droppedTextTurns).toBe(2)
    expect(droppedToolTurns).toBe(0)
    // Pinned + 1 text + tool turn (assistant + tool)
    expect(messages).toHaveLength(1 + 1 + 2)
  })

  it('handles an assistant with multi-tool_calls followed by partial results gracefully', () => {
    // Defensive: some provider bugs may emit fewer tool results than declared.
    // The pruning should not crash; it collects what it finds contiguously.
    const msgs: Message[] = [
      user('task'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          { id: 'tc2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
        ],
      },
      toolResult('tc1'),
      // tc2 result is missing — treat the whole chunk as one unit still
      assistantWithCalls(['tc3']),
      toolResult('tc3'),
    ]

    const { messages, droppedToolTurns } = pruneMessageSequence(msgs, { maxToolTurns: 5 })
    // Both TC1 chunk and TC3 chunk should be present
    expect(droppedToolTurns).toBe(0)
    const ids = messages
      .filter(m => m.role === 'tool')
      .map(m => (m as any).tool_call_id)
    expect(ids).toContain('tc1')
    expect(ids).toContain('tc3')
  })

  it('a mix of tool turns and text turns respects independent limits', () => {
    // 4 tool turns + 4 text turns, keep last 2 of each
    const msgs: Message[] = [
      user('task'),
      assistant('text 1'),
      assistantWithCalls(['tc1']),
      toolResult('tc1'),
      assistant('text 2'),
      assistantWithCalls(['tc2']),
      toolResult('tc2'),
      assistant('text 3'),
      assistantWithCalls(['tc3']),
      toolResult('tc3'),
      assistant('text 4'),
      assistantWithCalls(['tc4']),
      toolResult('tc4'),
    ]

    const { messages, droppedToolTurns, droppedTextTurns } = pruneMessageSequence(msgs, {
      maxToolTurns: 2,
      maxTextTurns: 2,
    })

    expect(droppedToolTurns).toBe(2) // tc1, tc2 dropped
    expect(droppedTextTurns).toBe(2) // text 1, text 2 dropped

    const keptIds = messages
      .filter(m => m.role === 'tool')
      .map(m => (m as any).tool_call_id)
    expect(keptIds).toEqual(['tc3', 'tc4'])
  })
})
