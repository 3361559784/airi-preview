import type { TranscriptBlock, TranscriptEntry } from './types'

import { describe, expect, it } from 'vitest'

import { planTranscriptRetention } from './retention'

let idCounter = 0

function resetIds() {
  idCounter = 0
}

function entry(role: TranscriptEntry['role'], content: string | unknown[], extra?: Partial<TranscriptEntry>): TranscriptEntry {
  const id = idCounter++
  return { id, at: new Date().toISOString(), role, content, ...extra }
}

function userEntry(content: string) {
  return entry('user', content)
}

function systemEntry(content: string) {
  return entry('system', content)
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

function toolResult(toolCallId: string, content: string | unknown[] = `result for ${toolCallId}`) {
  return entry('tool', content, { toolCallId })
}

function blockKey(block: TranscriptBlock): string {
  return `${block.kind}:${block.entryIdRange[0]}:${block.entryIdRange[1]}`
}

function blockKeys(blocks: readonly TranscriptBlock[]): string[] {
  return blocks.map(blockKey)
}

function expectDisjoint(left: readonly TranscriptBlock[], right: readonly TranscriptBlock[]) {
  const rightKeys = new Set(blockKeys(right))
  expect(blockKeys(left).filter(key => rightKeys.has(key))).toEqual([])
}

describe('planTranscriptRetention', () => {
  it('pins the first user block and excludes it from candidate blocks', () => {
    resetIds()
    const entries = [
      systemEntry('system preface'),
      userEntry('initial task'),
      assistantText('old thought'),
      userEntry('follow-up'),
    ]

    const plan = planTranscriptRetention(entries, {
      maxFullTextBlocks: 10,
    })

    expect(plan.pinnedBlock?.entry.content).toBe('initial task')
    expect(blockKeys(plan.candidateBlocks)).not.toContain(blockKey(plan.pinnedBlock!))
    expect(blockKeys(plan.candidateBlocks)).toEqual([
      'system:0:0',
      'text:2:2',
      'user:3:3',
    ])
  })

  it('keeps only recent complete tool interactions', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantWithTools(['tc1']),
      toolResult('tc1'),
      assistantWithTools(['tc2']),
      toolResult('tc2'),
      assistantWithTools(['tc3']),
      toolResult('tc3'),
    ]

    const plan = planTranscriptRetention(entries, {
      maxFullToolBlocks: 2,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 0,
    })

    expect(blockKeys(plan.keptToolBlocks)).toEqual([
      'tool_interaction:3:4',
      'tool_interaction:5:6',
    ])
    expect(blockKeys(plan.droppedSourceBlocks)).toContain('tool_interaction:1:2')
  })

  it('does not full-keep incomplete tool interactions', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantWithTools(['tc1', 'tc2']),
      toolResult('tc1'),
      assistantWithTools(['tc3']),
      toolResult('tc3'),
    ]

    const plan = planTranscriptRetention(entries, {
      maxFullToolBlocks: 5,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 5,
    })

    expect(blockKeys(plan.keptToolBlocks)).toEqual(['tool_interaction:3:4'])
    expect(blockKeys(plan.compactedSourceBlocks)).toContain('tool_interaction:1:2')
    expect(blockKeys(plan.keptFullBlocks)).not.toContain('tool_interaction:1:2')
  })

  it('keeps recent text-like blocks according to the text limit', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantText('thought 1'),
      systemEntry('runtime note'),
      userEntry('follow-up'),
      assistantText('thought 2'),
    ]

    const plan = planTranscriptRetention(entries, {
      maxFullToolBlocks: 0,
      maxFullTextBlocks: 2,
      maxCompactedBlocks: 0,
    })

    expect(blockKeys(plan.keptTextLikeBlocks)).toEqual([
      'user:3:3',
      'text:4:4',
    ])
    expect(blockKeys(plan.droppedSourceBlocks)).toEqual([
      'text:1:1',
      'system:2:2',
    ])
  })

  it('treats zero limits as keeping and compacting zero optional blocks', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantText('thought'),
      assistantWithTools(['tc1']),
      toolResult('tc1'),
      assistantText('final thought'),
    ]

    const plan = planTranscriptRetention(entries, {
      maxFullToolBlocks: 0,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 0,
    })

    expect(blockKeys(plan.keptFullBlocks)).toEqual(['user:0:0'])
    expect(plan.keptToolBlocks).toEqual([])
    expect(plan.keptTextLikeBlocks).toEqual([])
    expect(plan.compactedSourceBlocks).toEqual([])
    expect(blockKeys(plan.droppedSourceBlocks)).toEqual([
      'text:1:1',
      'tool_interaction:2:3',
      'text:4:4',
    ])
    expect(plan.metadata).toMatchObject({
      keptFullBlocks: 1,
      compactedBlocks: 0,
      droppedBlocks: 3,
    })
  })

  it('treats negative limits as zero', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantText('thought'),
      assistantWithTools(['tc1']),
      toolResult('tc1'),
    ]

    const zeroPlan = planTranscriptRetention(entries, {
      maxFullToolBlocks: 0,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 0,
    })
    const negativePlan = planTranscriptRetention(entries, {
      maxFullToolBlocks: -1,
      maxFullTextBlocks: -1,
      maxCompactedBlocks: -1,
    })

    expect(blockKeys(negativePlan.keptFullBlocks)).toEqual(blockKeys(zeroPlan.keptFullBlocks))
    expect(blockKeys(negativePlan.compactedSourceBlocks)).toEqual(blockKeys(zeroPlan.compactedSourceBlocks))
    expect(blockKeys(negativePlan.droppedSourceBlocks)).toEqual(blockKeys(zeroPlan.droppedSourceBlocks))
  })

  it('kept, compacted, and dropped source ranges are disjoint', () => {
    resetIds()
    const entries = [
      userEntry('task'),
      assistantText('old thought'),
      assistantWithTools(['tc1']),
      toolResult('tc1'),
      assistantText('middle thought'),
      assistantWithTools(['tc2']),
      toolResult('tc2'),
      assistantText('recent thought'),
    ]

    const plan = planTranscriptRetention(entries, {
      maxFullToolBlocks: 1,
      maxFullTextBlocks: 1,
      maxCompactedBlocks: 2,
    })

    expectDisjoint(plan.keptFullBlocks, plan.compactedSourceBlocks)
    expectDisjoint(plan.keptFullBlocks, plan.droppedSourceBlocks)
    expectDisjoint(plan.compactedSourceBlocks, plan.droppedSourceBlocks)
  })
})
