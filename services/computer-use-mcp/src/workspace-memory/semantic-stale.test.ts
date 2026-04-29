import type { WorkspaceMemoryEntry } from './types'

import { describe, expect, it } from 'vitest'

import { judgeWorkspaceMemorySemanticStale } from './semantic-stale'

const reviewedEntry: WorkspaceMemoryEntry = {
  id: 'memory-1',
  status: 'active',
  kind: 'constraint',
  statement: 'Use package-scoped pnpm commands for computer-use-mcp tests.',
  evidence: 'Reviewed package scripts and prior successful runs.',
  confidence: 'high',
  tags: ['tests'],
  relatedFiles: ['services/computer-use-mcp/package.json', './services/computer-use-mcp/src/config.ts'],
  workspaceKey: 'workspace-key',
  sourceRunId: 'run-1',
  source: 'coding_runner',
  humanVerified: true,
  review: {
    decision: 'activate',
    reviewer: 'maintainer',
    rationale: 'Verified against package scripts.',
    reviewedAt: '2026-01-01T00:00:00.000Z',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('workspace memory semantic stale contract', () => {
  it('returns current for active human-verified memory without stale signals', () => {
    expect(judgeWorkspaceMemorySemanticStale({
      entry: reviewedEntry,
      now: '2026-01-15T00:00:00.000Z',
      changedFiles: ['services/computer-use-mcp/src/unrelated.ts'],
    })).toEqual({
      status: 'current',
      memoryId: 'memory-1',
      reasons: [],
      suggestedAction: 'none',
      mutatesMemory: false,
    })
  })

  it('marks related source file changes as review recommended without mutating memory', () => {
    const judgment = judgeWorkspaceMemorySemanticStale({
      entry: reviewedEntry,
      now: '2026-01-15T00:00:00.000Z',
      changedFiles: [
        'services/computer-use-mcp/src/config.ts',
        './services/computer-use-mcp/package.json',
        'services/computer-use-mcp/package.json',
      ],
    })

    expect(judgment).toMatchObject({
      status: 'review_recommended',
      memoryId: 'memory-1',
      suggestedAction: 'operator_review',
      mutatesMemory: false,
    })
    expect(judgment.reasons).toEqual([
      {
        reason: 'source_files_changed',
        severity: 'soft',
        detail: 'One or more files related to this reviewed memory changed after review.',
        matchedFiles: [
          'services/computer-use-mcp/package.json',
          'services/computer-use-mcp/src/config.ts',
        ],
      },
    ])
    expect(reviewedEntry.status).toBe('active')
  })

  it('marks old review age as review recommended', () => {
    const judgment = judgeWorkspaceMemorySemanticStale({
      entry: reviewedEntry,
      now: '2026-04-15T00:00:00.000Z',
      maxReviewAgeDays: 30,
    })

    expect(judgment.status).toBe('review_recommended')
    expect(judgment.suggestedAction).toBe('operator_review')
    expect(judgment.reasons).toEqual([
      {
        reason: 'review_age_exceeded',
        severity: 'soft',
        detail: 'The review is older than 30 days.',
        ageDays: 104,
        maxReviewAgeDays: 30,
      },
    ])
  })

  it('treats current-run evidence conflicts as hard stale candidates', () => {
    const judgment = judgeWorkspaceMemorySemanticStale({
      entry: reviewedEntry,
      now: '2026-01-15T00:00:00.000Z',
      currentRunEvidenceConflicts: [
        {
          source: 'trusted_tool_result',
          summary: 'package.json no longer exposes the documented test script.',
        },
      ],
    })

    expect(judgment).toMatchObject({
      status: 'stale_candidate',
      suggestedAction: 'operator_review_before_reuse',
      mutatesMemory: false,
    })
    expect(judgment.reasons).toEqual([
      {
        reason: 'conflicts_with_current_run_evidence',
        severity: 'hard',
        detail: 'Current-run trusted evidence conflicts with this reviewed memory.',
        evidence: [
          {
            source: 'trusted_tool_result',
            summary: 'package.json no longer exposes the documented test script.',
          },
        ],
      },
    ])
  })

  it('treats plast-mem invalidation as a hard stale candidate', () => {
    const judgment = judgeWorkspaceMemorySemanticStale({
      entry: reviewedEntry,
      now: '2026-01-15T00:00:00.000Z',
      plastMemInvalidationSignal: {
        source: 'plast-mem',
        reason: 'Semantic consolidation superseded this coding rule.',
        receivedAt: '2026-01-14T00:00:00.000Z',
      },
    })

    expect(judgment).toMatchObject({
      status: 'stale_candidate',
      suggestedAction: 'operator_review_before_reuse',
      mutatesMemory: false,
    })
    expect(judgment.reasons).toEqual([
      {
        reason: 'plast_mem_invalidation_signal',
        severity: 'hard',
        detail: 'Plast-mem supplied an invalidation signal for this memory.',
        plastMemInvalidation: {
          source: 'plast-mem',
          reason: 'Semantic consolidation superseded this coding rule.',
          receivedAt: '2026-01-14T00:00:00.000Z',
        },
      },
    ])
  })

  it('keeps reason ordering deterministic and hard signals decide stale candidate status', () => {
    const judgment = judgeWorkspaceMemorySemanticStale({
      entry: reviewedEntry,
      now: '2026-04-15T00:00:00.000Z',
      maxReviewAgeDays: 30,
      changedFiles: ['services/computer-use-mcp/package.json'],
      currentRunEvidenceConflicts: [
        { source: 'verification_gate', summary: 'Verification gate rejected the remembered command.' },
      ],
      plastMemInvalidationSignal: {
        source: 'plast-mem',
        reason: 'Superseded by newer semantic memory.',
      },
    })

    expect(judgment.status).toBe('stale_candidate')
    expect(judgment.suggestedAction).toBe('operator_review_before_reuse')
    expect(judgment.reasons.map(reason => reason.reason)).toEqual([
      'source_files_changed',
      'review_age_exceeded',
      'conflicts_with_current_run_evidence',
      'plast_mem_invalidation_signal',
    ])
  })

  it('does not apply semantic stale judgment to non-active or unverified entries', () => {
    for (const entry of [
      { ...reviewedEntry, id: 'proposed', status: 'proposed' as const },
      { ...reviewedEntry, id: 'rejected', status: 'rejected' as const },
      { ...reviewedEntry, id: 'unverified', humanVerified: false },
    ]) {
      expect(judgeWorkspaceMemorySemanticStale({
        entry,
        now: '2026-04-15T00:00:00.000Z',
        changedFiles: ['services/computer-use-mcp/package.json'],
        currentRunEvidenceConflicts: [
          { source: 'trusted_tool_result', summary: 'conflict' },
        ],
      })).toEqual({
        status: 'not_applicable',
        memoryId: entry.id,
        reasons: [],
        suggestedAction: 'none',
        mutatesMemory: false,
      })
    }
  })
})
