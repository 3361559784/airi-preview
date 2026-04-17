import { describe, expect, it } from 'vitest'

import type { TranscriptEntry } from './types'

import { parseTranscriptBlocks } from './block-parser'
import { compactBlock } from './compactor'
import { InMemoryTranscriptStore } from './store'
import { projectTranscript } from './projector'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0
function resetIds() { idCounter = 0 }

function entry(role: TranscriptEntry['role'], content: string, extra?: Partial<TranscriptEntry>): TranscriptEntry {
  const id = idCounter++
  return { id, at: new Date().toISOString(), role, content, ...extra }
}

function userEntry(content: string) {
  return entry('user', content)
}

function assistantText(content: string) {
  return entry('assistant', content)
}

function assistantWithTools(toolIds: string[], content = '') {
  return entry('assistant', content, {
    toolCalls: toolIds.map(id => ({
      id,
      type: 'function' as const,
      function: { name: `tool_${id}`, arguments: '{}' },
    })),
  })
}

function toolResult(toolCallId: string, content = `result for ${toolCallId}`) {
  return entry('tool', content, { toolCallId })
}

function systemEntry(content: string) {
  return entry('system', content)
}

// ---------------------------------------------------------------------------
// TranscriptStore
// ---------------------------------------------------------------------------

describe('transcriptStore', () => {
  it('append and readback preserve order', async () => {
    const store = new InMemoryTranscriptStore()
    await store.init()

    await store.appendUser('task')
    await store.appendAssistantText('thinking')
    await store.appendAssistantToolCalls(
      [{ id: 'tc1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      '',
    )
    await store.appendToolResult('tc1', 'file content')

    const all = store.getAll()
    expect(all).toHaveLength(4)
    expect(all[0].role).toBe('user')
    expect(all[1].role).toBe('assistant')
    expect(all[2].role).toBe('assistant')
    expect(all[2].toolCalls).toHaveLength(1)
    expect(all[3].role).toBe('tool')
    expect(all[3].toolCallId).toBe('tc1')

    // IDs are monotonically increasing
    for (let i = 1; i < all.length; i++) {
      expect(all[i].id).toBeGreaterThan(all[i - 1].id)
    }
  })

  it('length reflects total entries', async () => {
    const store = new InMemoryTranscriptStore()
    await store.init()

    expect(store.length).toBe(0)
    await store.appendUser('a')
    await store.appendUser('b')
    expect(store.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Block Parser
// ---------------------------------------------------------------------------

describe('parseTranscriptBlocks', () => {
  it('groups assistant + tool_calls + tool results into a ToolInteractionBlock', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantWithTools(['tc1', 'tc2']),
      toolResult('tc1'),
      toolResult('tc2'),
    ]

    const blocks = parseTranscriptBlocks(entries)
    expect(blocks).toHaveLength(2) // user + tool_interaction
    expect(blocks[0].kind).toBe('user')
    expect(blocks[1].kind).toBe('tool_interaction')

    if (blocks[1].kind === 'tool_interaction') {
      expect(blocks[1].toolResults).toHaveLength(2)
      expect(blocks[1].assistant.toolCalls).toHaveLength(2)
    }
  })

  it('plain assistant text becomes a TextBlock', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantText('thinking out loud'),
    ]

    const blocks = parseTranscriptBlocks(entries)
    expect(blocks).toHaveLength(2)
    expect(blocks[1].kind).toBe('text')
  })

  it('orphan tool message becomes defensive TextBlock', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      toolResult('orphan_id', 'stray result'),
    ]

    const blocks = parseTranscriptBlocks(entries)
    expect(blocks).toHaveLength(2)
    expect(blocks[1].kind).toBe('text')
  })

  it('handles interleaved tool interactions and text blocks', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantText('step 1 thought'),
      assistantWithTools(['tc1']),
      toolResult('tc1'),
      assistantText('step 2 thought'),
      assistantWithTools(['tc2', 'tc3']),
      toolResult('tc2'),
      toolResult('tc3'),
    ]

    const blocks = parseTranscriptBlocks(entries)
    expect(blocks).toHaveLength(5)
    expect(blocks.map(b => b.kind)).toEqual([
      'user',
      'text',
      'tool_interaction',
      'text',
      'tool_interaction',
    ])
  })

  it('system messages become SystemBlocks', () => {
    resetIds()
    const entries = [
      systemEntry('you are a helper'),
      userEntry('task'),
    ]

    const blocks = parseTranscriptBlocks(entries)
    expect(blocks[0].kind).toBe('system')
    expect(blocks[1].kind).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// Compactor
// ---------------------------------------------------------------------------

describe('compactBlock', () => {
  it('compacts a tool interaction block with tool names and results', () => {
    resetIds()
    const block = parseTranscriptBlocks([
      assistantWithTools(['tc1']),
      toolResult('tc1', 'success data here'),
    ])[0]

    expect(block.kind).toBe('tool_interaction')
    const compacted = compactBlock(block)
    expect(compacted.kind).toBe('compacted')
    expect(compacted.originalKind).toBe('tool_interaction')
    expect(compacted.summary).toContain('tool_tc1')
    expect(compacted.summary).toContain('ok')
  })

  it('marks failed tool results in compacted summary', () => {
    resetIds()
    const block = parseTranscriptBlocks([
      assistantWithTools(['tc1']),
      toolResult('tc1', 'Error: file not found'),
    ])[0]

    const compacted = compactBlock(block)
    expect(compacted.summary).toContain('FAILED')
  })

  it('compacts text blocks with truncated content', () => {
    resetIds()
    const longText = 'A'.repeat(200)
    const block = parseTranscriptBlocks([assistantText(longText)])[0]

    const compacted = compactBlock(block)
    expect(compacted.kind).toBe('compacted')
    expect(compacted.originalKind).toBe('text')
    expect(compacted.summary.length).toBeLessThan(200)
    expect(compacted.summary).toContain('…')
  })

  it('compacted block entryIdRange matches original', () => {
    resetIds()
    const block = parseTranscriptBlocks([
      assistantWithTools(['tc1', 'tc2']),
      toolResult('tc1'),
      toolResult('tc2'),
    ])[0]

    const compacted = compactBlock(block)
    expect(compacted.entryIdRange).toEqual(block.entryIdRange)
  })
})

// ---------------------------------------------------------------------------
// Transcript Projector (end-to-end)
// ---------------------------------------------------------------------------

describe('projectTranscript', () => {
  const baseOpts = {
    runState: {} as any,
    operationalTrace: [],
    systemPromptBase: 'You are a coding assistant.',
  }

  it('pins the first user message permanently', () => {
    resetIds()
    const entries = [
      userEntry('initial task'),
      ...Array.from({ length: 10 }).flatMap((_, i) => [
        assistantWithTools([`tc${i}`]),
        toolResult(`tc${i}`),
      ]),
    ]

    const result = projectTranscript(entries, {
      ...baseOpts,
      maxFullToolBlocks: 2,
      maxFullTextBlocks: 1,
      maxCompactedBlocks: 2,
    })

    // First message must always be the pinned user task
    expect(result.messages[0].role).toBe('user')
    expect(result.messages[0].content).toBe('initial task')
  })

  it('keeps recent tool blocks in full', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantWithTools(['tc1']),
      toolResult('tc1', 'result 1'),
      assistantWithTools(['tc2']),
      toolResult('tc2', 'result 2'),
      assistantWithTools(['tc3']),
      toolResult('tc3', 'result 3'),
    ]

    const result = projectTranscript(entries, {
      ...baseOpts,
      maxFullToolBlocks: 2,
      maxCompactedBlocks: 0,
    })

    // tc1 should be dropped/compacted, tc2 and tc3 kept in full
    const toolCallIds = result.messages
      .filter(m => m.role === 'tool')
      .map(m => m.tool_call_id)

    expect(toolCallIds).toContain('tc2')
    expect(toolCallIds).toContain('tc3')
  })

  it('no orphan tool messages after projection', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      ...Array.from({ length: 8 }).flatMap((_, i) => [
        assistantWithTools([`tc${i}`]),
        toolResult(`tc${i}`),
      ]),
    ]

    const result = projectTranscript(entries, {
      ...baseOpts,
      maxFullToolBlocks: 3,
      maxCompactedBlocks: 2,
    })

    // Collect all tool_call ids declared in assistant messages
    const declaredIds = new Set<string>()
    for (const m of result.messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) declaredIds.add(tc.id)
      }
    }

    // Every tool message must reference a declared id
    for (const m of result.messages) {
      if (m.role === 'tool') {
        expect(declaredIds.has(m.tool_call_id!)).toBe(true)
      }
    }
  })

  it('compacted blocks are distinguishable from original transcript', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantWithTools(['tc1']),
      toolResult('tc1', 'old result'),
      assistantWithTools(['tc2']),
      toolResult('tc2', 'recent result'),
    ]

    const result = projectTranscript(entries, {
      ...baseOpts,
      maxFullToolBlocks: 1,
      maxCompactedBlocks: 1,
    })

    // Find the compacted summary message
    const compactedMsgs = result.messages.filter(m =>
      m.content?.includes('[Compacted'),
    )
    expect(compactedMsgs.length).toBeGreaterThanOrEqual(1)
  })

  it('operational trace projector and transcript projector do not pollute each other', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantText('thinking'),
    ]

    // Provide operational trace entries
    const opTrace = [{
      id: 'op-1',
      at: new Date().toISOString(),
      event: 'executed',
      toolName: 'desktop_screenshot',
      result: { path: '/tmp/a.png' },
    }]

    const result = projectTranscript(entries, {
      ...baseOpts,
      operationalTrace: opTrace as any,
    })

    // System header should contain operational trace data
    expect(result.system).toContain('Operational Trace')

    // Messages should only contain transcript content, not operational trace
    const msgTexts = result.messages.map(m => m.content ?? '')
    const hasOpTrace = msgTexts.some(t => t.includes('desktop_screenshot'))
    expect(hasOpTrace).toBe(false)
  })

  it('returns correct metadata', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantWithTools(['tc1']),
      toolResult('tc1'),
      assistantWithTools(['tc2']),
      toolResult('tc2'),
      assistantWithTools(['tc3']),
      toolResult('tc3'),
      assistantWithTools(['tc4']),
      toolResult('tc4'),
      assistantWithTools(['tc5']),
      toolResult('tc5'),
    ]

    const result = projectTranscript(entries, {
      ...baseOpts,
      maxFullToolBlocks: 2,
      maxCompactedBlocks: 2,
    })

    expect(result.metadata.totalTranscriptEntries).toBe(11)
    expect(result.metadata.totalBlocks).toBe(6) // 1 user + 5 tool_interaction
    expect(result.metadata.keptFullBlocks).toBeGreaterThanOrEqual(3) // pinned user + 2 latest tool
    expect(result.metadata.compactedBlocks).toBeLessThanOrEqual(2)
  })

  it('empty transcript produces empty messages but valid system header', () => {
    const result = projectTranscript([], baseOpts)
    expect(result.messages).toHaveLength(0)
    expect(result.system).toContain('coding assistant')
    expect(result.metadata.totalBlocks).toBe(0)
  })

  it('text blocks and tool blocks have independent limits', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantText('thought 1'),
      assistantText('thought 2'),
      assistantText('thought 3'),
      assistantWithTools(['tc1']),
      toolResult('tc1'),
      assistantWithTools(['tc2']),
      toolResult('tc2'),
    ]

    const result = projectTranscript(entries, {
      ...baseOpts,
      maxFullToolBlocks: 5, // keep all tool blocks
      maxFullTextBlocks: 1,  // only keep latest text block
      maxCompactedBlocks: 0, // no compaction
    })

    // All tool blocks should be present
    const toolMsgs = result.messages.filter(m => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)

    // Only the latest text block should be present
    const assistantTexts = result.messages.filter(m =>
      m.role === 'assistant' && !m.tool_calls && m.content && !m.content.includes('[Compacted'),
    )
    expect(assistantTexts).toHaveLength(1)
    expect(assistantTexts[0].content).toBe('thought 3')
  })
})
