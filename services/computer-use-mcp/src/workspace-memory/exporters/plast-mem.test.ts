import type { WorkspaceMemoryEntry } from '../types'

import { describe, expect, it } from 'vitest'

import {
  buildCodingPlastMemBridgeRecordV1,
  CODING_PLAST_MEM_BRIDGE_SCHEMA_V1,
  CODING_PLAST_MEM_BRIDGE_TRUST_V1,
} from './plast-mem'

function activeEntry(overrides: Partial<WorkspaceMemoryEntry> = {}): WorkspaceMemoryEntry {
  return {
    id: 'mem-1',
    status: 'active',
    kind: 'constraint',
    statement: 'Use pnpm workspace filters for computer-use-mcp tests.',
    evidence: 'Verified against package scripts and successful filtered test runs.',
    confidence: 'high',
    tags: ['pnpm', 'tests'],
    relatedFiles: ['services/computer-use-mcp/package.json'],
    workspaceKey: 'workspace-key',
    sourceRunId: 'run-1',
    source: 'coding_runner',
    humanVerified: true,
    review: {
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Confirmed as durable coding workflow guidance.',
      reviewedAt: '2026-04-29T01:00:00.000Z',
    },
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T01:00:00.000Z',
    ...overrides,
  }
}

describe('plast-mem workspace memory bridge exporter', () => {
  it('serializes active human-verified workspace memory into bridge record v1', () => {
    const entry = activeEntry()
    const record = buildCodingPlastMemBridgeRecordV1({
      entry,
      exportedAt: '2026-04-29T02:00:00.000Z',
      reviewRequestId: 'review-request-1',
    })

    expect(record).toEqual({
      schema: CODING_PLAST_MEM_BRIDGE_SCHEMA_V1,
      source: 'computer-use-mcp',
      workspaceKey: 'workspace-key',
      memoryId: 'mem-1',
      kind: 'constraint',
      statement: 'Use pnpm workspace filters for computer-use-mcp tests.',
      evidence: 'Verified against package scripts and successful filtered test runs.',
      confidence: 'high',
      tags: ['pnpm', 'tests'],
      relatedFiles: ['services/computer-use-mcp/package.json'],
      sourceRunId: 'run-1',
      reviewRequestId: 'review-request-1',
      humanVerified: true,
      review: {
        reviewer: 'maintainer',
        rationale: 'Confirmed as durable coding workflow guidance.',
        reviewedAt: '2026-04-29T01:00:00.000Z',
      },
      exportedAt: '2026-04-29T02:00:00.000Z',
      trust: CODING_PLAST_MEM_BRIDGE_TRUST_V1,
    })
  })

  it('rejects proposed and rejected entries', () => {
    for (const status of ['proposed', 'rejected'] as const) {
      expect(() => buildCodingPlastMemBridgeRecordV1({
        entry: activeEntry({ status }),
        exportedAt: '2026-04-29T02:00:00.000Z',
      })).toThrow(`unless active: mem-1 is ${status}`)
    }
  })

  it('rejects active entries that are not human verified', () => {
    expect(() => buildCodingPlastMemBridgeRecordV1({
      entry: activeEntry({ humanVerified: false }),
      exportedAt: '2026-04-29T02:00:00.000Z',
    })).toThrow('unless humanVerified')
  })

  it('rejects missing or empty review metadata', () => {
    expect(() => buildCodingPlastMemBridgeRecordV1({
      entry: activeEntry({ review: undefined }),
      exportedAt: '2026-04-29T02:00:00.000Z',
    })).toThrow('without review metadata')

    expect(() => buildCodingPlastMemBridgeRecordV1({
      entry: activeEntry({
        review: {
          decision: 'activate',
          reviewer: ' ',
          rationale: 'Confirmed.',
          reviewedAt: '2026-04-29T01:00:00.000Z',
        },
      }),
      exportedAt: '2026-04-29T02:00:00.000Z',
    })).toThrow('reviewer is required')

    expect(() => buildCodingPlastMemBridgeRecordV1({
      entry: activeEntry({
        review: {
          decision: 'activate',
          reviewer: 'maintainer',
          rationale: ' ',
          reviewedAt: '2026-04-29T01:00:00.000Z',
        },
      }),
      exportedAt: '2026-04-29T02:00:00.000Z',
    })).toThrow('rationale is required')

    expect(() => buildCodingPlastMemBridgeRecordV1({
      entry: activeEntry({
        review: {
          decision: 'activate',
          reviewer: 'maintainer',
          rationale: 'Confirmed.',
          reviewedAt: ' ',
        },
      }),
      exportedAt: '2026-04-29T02:00:00.000Z',
    })).toThrow('reviewedAt is required')
  })

  it('requires caller-provided exportedAt instead of generating it implicitly', () => {
    expect(() => buildCodingPlastMemBridgeRecordV1({
      entry: activeEntry(),
      exportedAt: ' ',
    })).toThrow('exportedAt is required')
  })

  it('copies mutable arrays and preserves optional source identifiers', () => {
    const entry = activeEntry({
      sourceRunId: '',
      tags: ['coding'],
      relatedFiles: ['src/a.ts'],
    })
    const record = buildCodingPlastMemBridgeRecordV1({
      entry,
      exportedAt: '2026-04-29T02:00:00.000Z',
    })

    expect(record.sourceRunId).toBeUndefined()
    expect(record.reviewRequestId).toBeUndefined()

    entry.tags.push('mutated-after-export')
    entry.relatedFiles.push('src/b.ts')

    expect(record.tags).toEqual(['coding'])
    expect(record.relatedFiles).toEqual(['src/a.ts'])
  })

  it('does not serialize task-memory or archive-only fields into the bridge record', () => {
    const entry = {
      ...activeEntry(),
      evidencePins: ['terminal_result:pnpm test: exitCode=0 timedOut=false'],
      archiveArtifactId: '0-2-compacted.md',
    } as WorkspaceMemoryEntry & { evidencePins: string[], archiveArtifactId: string }

    const record = buildCodingPlastMemBridgeRecordV1({
      entry,
      exportedAt: '2026-04-29T02:00:00.000Z',
    })

    expect(Object.hasOwn(record, 'evidencePins')).toBe(false)
    expect(Object.hasOwn(record, 'archiveArtifactId')).toBe(false)
  })
})
