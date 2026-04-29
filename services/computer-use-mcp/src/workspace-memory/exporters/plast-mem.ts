import type {
  WorkspaceMemoryConfidence,
  WorkspaceMemoryEntry,
  WorkspaceMemoryKind,
} from '../types'

export const CODING_PLAST_MEM_BRIDGE_SCHEMA_V1 = 'computer-use-mcp.coding-memory.v1'
export const CODING_PLAST_MEM_BRIDGE_TRUST_V1 = 'reviewed_coding_context_not_instruction_authority'

export interface CodingPlastMemBridgeRecordV1 {
  schema: typeof CODING_PLAST_MEM_BRIDGE_SCHEMA_V1
  source: 'computer-use-mcp'
  workspaceKey: string
  memoryId: string
  kind: WorkspaceMemoryKind
  statement: string
  evidence: string
  confidence: WorkspaceMemoryConfidence
  tags: string[]
  relatedFiles: string[]
  sourceRunId?: string
  reviewRequestId?: string
  humanVerified: true
  review: {
    reviewer: string
    rationale: string
    reviewedAt: string
  }
  exportedAt: string
  trust: typeof CODING_PLAST_MEM_BRIDGE_TRUST_V1
}

export interface BuildCodingPlastMemBridgeRecordV1Options {
  entry: WorkspaceMemoryEntry
  exportedAt: string
  reviewRequestId?: string
}

/**
 * Serializes a reviewed active workspace-memory entry into the stable bridge
 * record shape expected by future plast-mem ingestion adapters.
 */
export function buildCodingPlastMemBridgeRecordV1(
  options: BuildCodingPlastMemBridgeRecordV1Options,
): CodingPlastMemBridgeRecordV1 {
  const { entry } = options

  if (entry.status !== 'active')
    throw new Error(`Workspace memory cannot be exported to plast-mem unless active: ${entry.id} is ${entry.status}`)

  if (entry.humanVerified !== true)
    throw new Error(`Workspace memory cannot be exported to plast-mem unless humanVerified: ${entry.id}`)

  if (!entry.review)
    throw new Error(`Workspace memory cannot be exported to plast-mem without review metadata: ${entry.id}`)

  const reviewer = normalizeRequiredText(entry.review.reviewer, `Workspace memory plast-mem export reviewer is required: ${entry.id}`)
  const rationale = normalizeRequiredText(entry.review.rationale, `Workspace memory plast-mem export rationale is required: ${entry.id}`)
  const reviewedAt = normalizeRequiredText(entry.review.reviewedAt, `Workspace memory plast-mem export reviewedAt is required: ${entry.id}`)
  const exportedAt = normalizeRequiredText(options.exportedAt, `Workspace memory plast-mem export exportedAt is required: ${entry.id}`)

  return {
    schema: CODING_PLAST_MEM_BRIDGE_SCHEMA_V1,
    source: 'computer-use-mcp',
    workspaceKey: entry.workspaceKey,
    memoryId: entry.id,
    kind: entry.kind,
    statement: entry.statement,
    evidence: entry.evidence,
    confidence: entry.confidence,
    tags: [...entry.tags],
    relatedFiles: [...entry.relatedFiles],
    ...(entry.sourceRunId ? { sourceRunId: entry.sourceRunId } : {}),
    ...(options.reviewRequestId ? { reviewRequestId: options.reviewRequestId } : {}),
    humanVerified: true,
    review: {
      reviewer,
      rationale,
      reviewedAt,
    },
    exportedAt,
    trust: CODING_PLAST_MEM_BRIDGE_TRUST_V1,
  }
}

function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim()
  if (!normalized)
    throw new Error(message)
  return normalized
}
