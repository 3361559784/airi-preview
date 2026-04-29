import type { WorkspaceMemoryEntry } from './types'

export type WorkspaceMemorySemanticStaleReason
  = | 'source_files_changed'
    | 'review_age_exceeded'
    | 'conflicts_with_current_run_evidence'
    | 'plast_mem_invalidation_signal'

export type WorkspaceMemorySemanticStaleStatus
  = | 'not_applicable'
    | 'current'
    | 'review_recommended'
    | 'stale_candidate'

export interface WorkspaceMemoryCurrentRunEvidenceConflict {
  source: 'trusted_tool_result' | 'verification_gate' | 'archive_recall' | 'task_memory'
  summary: string
}

export interface WorkspaceMemoryPlastMemInvalidationSignal {
  source: string
  reason: string
  receivedAt?: string
}

export interface WorkspaceMemorySemanticStaleInput {
  entry: WorkspaceMemoryEntry
  now: string | Date
  changedFiles?: readonly string[]
  maxReviewAgeDays?: number
  currentRunEvidenceConflicts?: readonly WorkspaceMemoryCurrentRunEvidenceConflict[]
  plastMemInvalidationSignal?: WorkspaceMemoryPlastMemInvalidationSignal
}

export interface WorkspaceMemorySemanticStaleReasonRecord {
  reason: WorkspaceMemorySemanticStaleReason
  severity: 'soft' | 'hard'
  detail: string
  matchedFiles?: string[]
  ageDays?: number
  maxReviewAgeDays?: number
  evidence?: WorkspaceMemoryCurrentRunEvidenceConflict[]
  plastMemInvalidation?: WorkspaceMemoryPlastMemInvalidationSignal
}

export interface WorkspaceMemorySemanticStaleJudgment {
  status: WorkspaceMemorySemanticStaleStatus
  memoryId: string
  reasons: WorkspaceMemorySemanticStaleReasonRecord[]
  suggestedAction: 'none' | 'operator_review' | 'operator_review_before_reuse'
  mutatesMemory: false
}

export const DEFAULT_WORKSPACE_MEMORY_SEMANTIC_STALE_REVIEW_AGE_DAYS = 90

const LEADING_DOT_SLASHES_RE = /^\.\/+/
const PATH_SLASHES_RE = /\/+/g

/**
 * Pure semantic stale judgment for reviewed coding memory.
 *
 * This function intentionally only classifies candidate risk. It never writes
 * WorkspaceMemoryStore status, never resolves review requests, and never calls
 * plast-mem. Operator review remains the authority for activation/rejection.
 */
export function judgeWorkspaceMemorySemanticStale(
  input: WorkspaceMemorySemanticStaleInput,
): WorkspaceMemorySemanticStaleJudgment {
  const entry = input.entry
  if (entry.status !== 'active' || entry.humanVerified !== true) {
    return {
      status: 'not_applicable',
      memoryId: entry.id,
      reasons: [],
      suggestedAction: 'none',
      mutatesMemory: false,
    }
  }

  const reasons: WorkspaceMemorySemanticStaleReasonRecord[] = []
  const changedRelatedFiles = getChangedRelatedFiles(entry.relatedFiles, input.changedFiles ?? [])
  if (changedRelatedFiles.length > 0) {
    reasons.push({
      reason: 'source_files_changed',
      severity: 'soft',
      detail: 'One or more files related to this reviewed memory changed after review.',
      matchedFiles: changedRelatedFiles,
    })
  }

  const maxReviewAgeDays = normalizePositiveInteger(
    input.maxReviewAgeDays,
    DEFAULT_WORKSPACE_MEMORY_SEMANTIC_STALE_REVIEW_AGE_DAYS,
  )
  const ageDays = getReviewAgeDays(entry.review?.reviewedAt, input.now)
  if (ageDays !== undefined && ageDays > maxReviewAgeDays) {
    reasons.push({
      reason: 'review_age_exceeded',
      severity: 'soft',
      detail: `The review is older than ${maxReviewAgeDays} days.`,
      ageDays,
      maxReviewAgeDays,
    })
  }

  const currentRunEvidenceConflicts = normalizeCurrentRunEvidenceConflicts(input.currentRunEvidenceConflicts ?? [])
  if (currentRunEvidenceConflicts.length > 0) {
    reasons.push({
      reason: 'conflicts_with_current_run_evidence',
      severity: 'hard',
      detail: 'Current-run trusted evidence conflicts with this reviewed memory.',
      evidence: currentRunEvidenceConflicts,
    })
  }

  const plastMemInvalidationSignal = normalizePlastMemInvalidationSignal(input.plastMemInvalidationSignal)
  if (plastMemInvalidationSignal) {
    reasons.push({
      reason: 'plast_mem_invalidation_signal',
      severity: 'hard',
      detail: 'Plast-mem supplied an invalidation signal for this memory.',
      plastMemInvalidation: plastMemInvalidationSignal,
    })
  }

  if (reasons.some(reason => reason.severity === 'hard')) {
    return {
      status: 'stale_candidate',
      memoryId: entry.id,
      reasons,
      suggestedAction: 'operator_review_before_reuse',
      mutatesMemory: false,
    }
  }

  if (reasons.length > 0) {
    return {
      status: 'review_recommended',
      memoryId: entry.id,
      reasons,
      suggestedAction: 'operator_review',
      mutatesMemory: false,
    }
  }

  return {
    status: 'current',
    memoryId: entry.id,
    reasons: [],
    suggestedAction: 'none',
    mutatesMemory: false,
  }
}

function getChangedRelatedFiles(relatedFiles: readonly string[], changedFiles: readonly string[]): string[] {
  if (relatedFiles.length === 0 || changedFiles.length === 0)
    return []

  const changed = new Set(changedFiles.map(normalizePathForComparison).filter(Boolean))
  return [...new Set(
    relatedFiles
      .map(normalizePathForComparison)
      .filter(file => file && changed.has(file)),
  )].sort()
}

function normalizePathForComparison(path: string): string {
  return path.trim().replace(LEADING_DOT_SLASHES_RE, '').replace(PATH_SLASHES_RE, '/')
}

function getReviewAgeDays(reviewedAt: string | undefined, now: string | Date): number | undefined {
  if (!reviewedAt)
    return undefined

  const reviewedAtMs = Date.parse(reviewedAt)
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  if (!Number.isFinite(reviewedAtMs) || !Number.isFinite(nowMs))
    return undefined

  return Math.max(0, Math.floor((nowMs - reviewedAtMs) / 86_400_000))
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0)
    return fallback
  return Math.floor(value)
}

function normalizeCurrentRunEvidenceConflicts(
  conflicts: readonly WorkspaceMemoryCurrentRunEvidenceConflict[],
): WorkspaceMemoryCurrentRunEvidenceConflict[] {
  return conflicts
    .map(conflict => ({
      source: conflict.source,
      summary: conflict.summary.trim(),
    }))
    .filter(conflict => conflict.summary.length > 0)
}

function normalizePlastMemInvalidationSignal(
  signal: WorkspaceMemoryPlastMemInvalidationSignal | undefined,
): WorkspaceMemoryPlastMemInvalidationSignal | undefined {
  const source = signal?.source.trim()
  const reason = signal?.reason.trim()
  if (!source || !reason)
    return undefined

  return {
    source,
    reason,
    ...(signal?.receivedAt?.trim() ? { receivedAt: signal.receivedAt.trim() } : {}),
  }
}
