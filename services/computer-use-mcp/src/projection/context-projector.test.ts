import { describe, expect, it } from 'vitest'

import type { SessionTraceEntry } from '../types'
import type { ProjectionInput } from './types'

import { projectContext } from './context-projector'

describe('context-projector (Operational Trace)', () => {
  it('should pin task memory, run state summary, and system prompt header', () => {
    const input: ProjectionInput = {
      trace: [],
      runState: {
        executionTarget: { mode: 'local-windowed' },
        coding: { currentPlan: { steps: [] } },
      } as any,
      taskMemoryString: 'Task123: Working on tests.',
      systemPromptBase: 'You are an AI assistant.',
    }

    const { systemHeader } = projectContext(input)

    expect(systemHeader).toContain('You are an AI assistant.')
    expect(systemHeader).toContain('Task123: Working on tests.')
    expect(systemHeader).toContain('local-windowed')
    expect(systemHeader).toContain('No Active Plan')
  })

  it('should show Active Plan when coding plan steps exist', () => {
    const input: ProjectionInput = {
      trace: [],
      runState: {
        executionTarget: { mode: 'local-windowed' },
        coding: { currentPlan: { steps: [{ filePath: 'a.ts' }] } },
      } as any,
    }

    const { systemHeader } = projectContext(input)
    expect(systemHeader).toContain('Active Plan')
  })

  it('should prune older operational trace events beyond intactTraceEventLimit', () => {
    // 12 events, default limit is 8 → oldest 4 should be pruned
    const trace: SessionTraceEntry[] = Array.from({ length: 12 }).map((_, i) => ({
      id: `trace-${i}`,
      at: new Date().toISOString(),
      event: 'executed',
      toolName: 'desktop_click',
      action: { kind: 'click', input: { x: i, y: i } } as any,
      result: { performed: true, backend: 'macos-local' },
    }))

    const input: ProjectionInput = { trace, runState: {} as any }
    const { prunedTrace, metadata } = projectContext(input)

    expect(metadata.originalTraceLength).toBe(12)
    expect(metadata.prunedTraceEvents).toBe(4)
    expect(prunedTrace).toHaveLength(12)

    // Oldest 4 (index 0-3) should be pruned
    for (let i = 0; i < 4; i++) {
      expect(prunedTrace[i].pruned).toBe(true)
      expect(prunedTrace[i].resultPayload).toBeUndefined()
      expect(prunedTrace[i].actionPayload).toBeUndefined()
      expect(prunedTrace[i].summary).toContain('pruned')
    }

    // Newest 8 (index 4-11) should remain intact
    for (let i = 4; i < 12; i++) {
      expect(prunedTrace[i].pruned).toBe(false)
      expect(prunedTrace[i].resultPayload).toBeDefined()
      expect(prunedTrace[i].actionPayload).toBeDefined()
    }
  })

  it('should soft-truncate extremely large result payloads even if within intact window', () => {
    const largeResult = { huge: 'A'.repeat(15000) }
    const trace: SessionTraceEntry[] = [{
      id: 'trace-0',
      at: new Date().toISOString(),
      event: 'executed',
      toolName: 'coding_read_file',
      result: largeResult,
    }]

    const input: ProjectionInput = { trace, runState: {} as any }
    const { prunedTrace, metadata } = projectContext(input)

    expect(metadata.prunedTraceEvents).toBe(1)
    expect(prunedTrace[0].pruned).toBe(true)
    expect(prunedTrace[0].resultPayload).toBeUndefined()
    expect(prunedTrace[0].summary).toContain('truncated due to length')
  })

  it('should handle mixed real trace events correctly', () => {
    // Simulate a realistic sequence: requested → executed → requested → failed
    const trace: SessionTraceEntry[] = [
      {
        id: 'trace-1',
        at: '2026-04-16T00:00:00Z',
        event: 'requested',
        toolName: 'desktop_screenshot',
        action: { kind: 'screenshot', input: {} } as any,
        policy: { allowed: true, requiresApproval: false, reasons: [], riskLevel: 'low', estimatedOperationUnits: 1 },
      },
      {
        id: 'trace-2',
        at: '2026-04-16T00:00:01Z',
        event: 'executed',
        toolName: 'desktop_screenshot',
        result: { screenshotPath: '/tmp/screenshot.png', width: 1920, height: 1080 },
      },
      {
        id: 'trace-3',
        at: '2026-04-16T00:00:02Z',
        event: 'requested',
        toolName: 'desktop_click',
        action: { kind: 'click', input: { x: 100, y: 200 } } as any,
      },
      {
        id: 'trace-4',
        at: '2026-04-16T00:00:03Z',
        event: 'failed',
        toolName: 'desktop_click',
        result: { error: 'Coordinate out of bounds' },
      },
    ]

    const input: ProjectionInput = { trace, runState: {} as any }
    const { prunedTrace, metadata } = projectContext(input)

    expect(prunedTrace).toHaveLength(4)
    expect(metadata.prunedTraceEvents).toBe(0) // 4 events, limit is 8
    expect(prunedTrace[0].event).toBe('requested')
    expect(prunedTrace[1].event).toBe('executed')
    expect(prunedTrace[2].event).toBe('requested')
    expect(prunedTrace[3].event).toBe('failed')
    expect(prunedTrace[3].resultPayload).toEqual({ error: 'Coordinate out of bounds' })
  })

  it('should return empty trace and header-only when no trace entries exist', () => {
    const input: ProjectionInput = {
      trace: [],
      runState: {} as any,
      taskMemoryString: 'Working on it.',
    }
    const { prunedTrace, systemHeader, metadata } = projectContext(input)

    expect(prunedTrace).toHaveLength(0)
    expect(metadata.originalTraceLength).toBe(0)
    expect(metadata.prunedTraceEvents).toBe(0)
    expect(systemHeader).toContain('Working on it.')
  })

  it('should respect custom policy overrides', () => {
    const trace: SessionTraceEntry[] = Array.from({ length: 5 }).map((_, i) => ({
      id: `trace-${i}`,
      at: new Date().toISOString(),
      event: 'executed',
      toolName: 'test_tool',
      result: { data: `result ${i}` },
    }))

    const input: ProjectionInput = { trace, runState: {} as any }
    // Override to keep only 2 intact
    const { prunedTrace, metadata } = projectContext(input, { intactTraceEventLimit: 2 })

    expect(metadata.prunedTraceEvents).toBe(3) // 5 - 2 = 3 pruned
    expect(prunedTrace[0].pruned).toBe(true)
    expect(prunedTrace[1].pruned).toBe(true)
    expect(prunedTrace[2].pruned).toBe(true)
    expect(prunedTrace[3].pruned).toBe(false)
    expect(prunedTrace[4].pruned).toBe(false)
  })
})
