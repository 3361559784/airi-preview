export type WorkspaceMemoryStatus = 'proposed' | 'active' | 'rejected'
export type WorkspaceMemoryKind = 'constraint' | 'fact' | 'pitfall' | 'command' | 'file_note'
export type WorkspaceMemoryConfidence = 'low' | 'medium' | 'high'

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
