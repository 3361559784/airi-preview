/**
 * Archived Context — types for the archive layer.
 *
 * Archive artifacts are markdown files with YAML frontmatter persisted to
 * the local filesystem. They represent transcript blocks that were removed
 * from the active prompt (compacted or dropped) and may be recalled later.
 *
 * V1 scope: write-only, no retrieval, no promotion to workspace memory.
 */

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

export interface ArchiveArtifactFrontmatter {
  /** Unique artifact ID. */
  id: string
  /** Scope of this artifact. */
  scope: 'run' | 'task'
  /** Run identifier (generated per runCodingTask invocation). */
  run_id: string
  /** Task identifier (V1: same as run_id). */
  task_id: string
  /** ISO timestamp of the earliest transcript entry in the archived block. */
  created_at: string
  /** What kind of summary this is. */
  summary_type: 'compacted_block' | 'dropped_block'
  /** Confidence level of the archive content. */
  confidence: 'low' | 'medium' | 'high'
  /** Tags derived from block content (e.g. tool names). */
  tags: string[]
  /** Related file paths. V1: always empty array. */
  related_files: string[]
  /** Where this archive was produced from. */
  source: 'transcript_projection'
  /** Whether a human has verified this content. */
  human_verified: false
}

// ---------------------------------------------------------------------------
// Full artifact
// ---------------------------------------------------------------------------

export interface ArchiveArtifact {
  frontmatter: ArchiveArtifactFrontmatter
  /** Deterministic short summary (from compactor). */
  summary: string
  /** Entry id range of the source block. */
  sourceRange: [number, number]
  /** Full normalized content for human reading and future retrieval. */
  transcriptExcerpt: string
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplication key format: `${run_id}:${task_id}:${start}:${end}:${reason}`
 *
 * Same key means same archived block — skip writing.
 */
export type ArchiveDeduplicationKey = string

export function buildDeduplicationKey(
  runId: string,
  taskId: string,
  entryIdRange: [number, number],
  reason: 'compacted' | 'dropped',
): ArchiveDeduplicationKey {
  return `${runId}:${taskId}:${entryIdRange[0]}:${entryIdRange[1]}:${reason}`
}
