export type WorkspaceMemoryStatus = 'proposed' | 'active' | 'rejected'
export type WorkspaceMemoryKind = 'constraint' | 'fact' | 'pitfall' | 'command' | 'file_note'
export type WorkspaceMemoryConfidence = 'low' | 'medium' | 'high'
export type WorkspaceMemoryReviewDecision = 'activate' | 'reject'
export type WorkspaceMemoryReviewRequestStatus = 'pending' | 'applied' | 'rejected' | 'stale'
export type WorkspaceMemoryReviewRequestStaleReason
  = | 'target_missing'
    | 'target_status_changed'
    | 'target_updated_at_changed'
    | 'target_statement_changed'

export interface WorkspaceMemoryReview {
  decision: WorkspaceMemoryReviewDecision
  reviewer: string
  rationale: string
  reviewedAt: string
}

export interface WorkspaceMemoryEntry {
  id: string
  status: WorkspaceMemoryStatus
  kind: WorkspaceMemoryKind
  statement: string
  evidence: string
  confidence: WorkspaceMemoryConfidence
  tags: string[]
  relatedFiles: string[]
  workspaceKey: string
  sourceRunId: string
  source: 'coding_runner'
  humanVerified: boolean
  review?: WorkspaceMemoryReview
  createdAt: string
  updatedAt: string
}

export interface WorkspaceMemoryDraft {
  kind: WorkspaceMemoryKind
  statement: string
  evidence: string
  confidence?: WorkspaceMemoryConfidence
  tags?: string[]
  relatedFiles?: string[]
}

export interface WorkspaceMemoryReviewInput {
  id: string
  decision: WorkspaceMemoryReviewDecision
  reviewer: string
  rationale: string
}

export interface WorkspaceMemoryReviewRequestRecord {
  id: string
  workspaceKey: string
  memoryId: string
  decision: WorkspaceMemoryReviewDecision
  requester: string
  rationale: string
  status: WorkspaceMemoryReviewRequestStatus
  targetStatus: WorkspaceMemoryStatus
  targetUpdatedAt: string
  targetStatement: string
  createdAt: string
  resolvedAt?: string
  resolvedBy?: string
  resolutionRationale?: string
  appliedMemoryStatus?: WorkspaceMemoryStatus
  errorCode?: string
}

export interface WorkspaceMemoryReviewRequestStaleCandidate {
  request: WorkspaceMemoryReviewRequestRecord
  staleReason: WorkspaceMemoryReviewRequestStaleReason
  currentEntry?: WorkspaceMemoryEntry
}

export interface WorkspaceMemoryReviewRequestInput {
  memoryId: string
  decision: WorkspaceMemoryReviewDecision
  requester: string
  rationale: string
}

export interface WorkspaceMemoryReviewRequestResolutionInput {
  approver: string
  rationale: string
}

export interface WorkspaceMemorySearchHit {
  id: string
  status: WorkspaceMemoryStatus
  kind: WorkspaceMemoryKind
  statement: string
  evidenceExcerpt: string
  confidence: WorkspaceMemoryConfidence
  tags: string[]
  relatedFiles: string[]
  humanVerified: boolean
}
