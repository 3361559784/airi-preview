import { describe, expect, it } from 'vitest'

import { DEFAULT_TRANSCRIPT_RETENTION_LIMITS } from '../transcript/retention'
import {
  DEFAULT_CODING_TURN_CONTEXT_POLICY,
  resolveCodingTurnContextPolicy,
  toRuntimePruningPolicy,
} from './context-policy'

describe('coding turn context policy', () => {
  it('matches current coding context defaults', () => {
    expect(DEFAULT_CODING_TURN_CONTEXT_POLICY).toEqual({
      recentTraceEntryLimit: 50,
      operationalTrace: {
        intactTraceEventLimit: 8,
        maxResultLengthBeforeSoftTruncation: 12000,
      },
      transcriptRetention: DEFAULT_TRANSCRIPT_RETENTION_LIMITS,
    })
  })

  it('deep merges nested overrides', () => {
    const policy = resolveCodingTurnContextPolicy({
      recentTraceEntryLimit: 25,
      operationalTrace: {
        intactTraceEventLimit: 3,
      },
      transcriptRetention: {
        maxFullToolBlocks: 2,
      },
    })

    expect(policy).toEqual({
      recentTraceEntryLimit: 25,
      operationalTrace: {
        intactTraceEventLimit: 3,
        maxResultLengthBeforeSoftTruncation: 12000,
      },
      transcriptRetention: {
        maxFullToolBlocks: 2,
        maxFullTextBlocks: DEFAULT_TRANSCRIPT_RETENTION_LIMITS.maxFullTextBlocks,
        maxCompactedBlocks: DEFAULT_TRANSCRIPT_RETENTION_LIMITS.maxCompactedBlocks,
      },
    })
  })

  it('normalizes zero and negative limits to zero', () => {
    const policy = resolveCodingTurnContextPolicy({
      recentTraceEntryLimit: -1,
      operationalTrace: {
        intactTraceEventLimit: 0,
        maxResultLengthBeforeSoftTruncation: -99,
      },
      transcriptRetention: {
        maxFullToolBlocks: -1,
        maxFullTextBlocks: 0,
        maxCompactedBlocks: -2,
      },
    })

    expect(policy).toEqual({
      recentTraceEntryLimit: 0,
      operationalTrace: {
        intactTraceEventLimit: 0,
        maxResultLengthBeforeSoftTruncation: 0,
      },
      transcriptRetention: {
        maxFullToolBlocks: 0,
        maxFullTextBlocks: 0,
        maxCompactedBlocks: 0,
      },
    })
  })

  it('falls back to defaults for non-finite values', () => {
    const policy = resolveCodingTurnContextPolicy({
      recentTraceEntryLimit: Number.NaN,
      operationalTrace: {
        intactTraceEventLimit: Number.POSITIVE_INFINITY,
        maxResultLengthBeforeSoftTruncation: Number.NEGATIVE_INFINITY,
      },
      transcriptRetention: {
        maxFullToolBlocks: Number.NaN,
        maxFullTextBlocks: Number.POSITIVE_INFINITY,
        maxCompactedBlocks: Number.NEGATIVE_INFINITY,
      },
    })

    expect(policy).toEqual(DEFAULT_CODING_TURN_CONTEXT_POLICY)
  })

  it('floors decimal limits', () => {
    const policy = resolveCodingTurnContextPolicy({
      recentTraceEntryLimit: 4.9,
      operationalTrace: {
        intactTraceEventLimit: 2.8,
        maxResultLengthBeforeSoftTruncation: 99.5,
      },
      transcriptRetention: {
        maxFullToolBlocks: 1.9,
        maxFullTextBlocks: 2.1,
        maxCompactedBlocks: 3.7,
      },
    })

    expect(policy).toMatchObject({
      recentTraceEntryLimit: 4,
      operationalTrace: {
        intactTraceEventLimit: 2,
        maxResultLengthBeforeSoftTruncation: 99,
      },
      transcriptRetention: {
        maxFullToolBlocks: 1,
        maxFullTextBlocks: 2,
        maxCompactedBlocks: 3,
      },
    })
  })

  it('does not mutate default policy objects', () => {
    const before = structuredClone(DEFAULT_CODING_TURN_CONTEXT_POLICY)

    resolveCodingTurnContextPolicy({
      operationalTrace: { intactTraceEventLimit: 1 },
      transcriptRetention: { maxFullTextBlocks: 1 },
    })

    expect(DEFAULT_CODING_TURN_CONTEXT_POLICY).toEqual(before)
  })

  it('does not expose pinSystemHeader as a runner policy override', () => {
    const policy = resolveCodingTurnContextPolicy({
      operationalTrace: {
        pinSystemHeader: false,
      },
    } as any)

    expect('pinSystemHeader' in policy.operationalTrace).toBe(false)
    expect(toRuntimePruningPolicy(policy.operationalTrace).pinSystemHeader).toBe(true)
  })
})
