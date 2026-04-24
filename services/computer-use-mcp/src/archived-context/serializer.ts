/**
 * Archive Serializer — converts ArchiveCandidates to ArchiveArtifacts
 * and serializes them as markdown with YAML frontmatter.
 *
 * NOTICE: This is intentionally separate from compactor.ts.
 * The compactor produces 120-char snippets for the system prompt.
 * This serializer produces full-content markdown files for human reading
 * and future retrieval.
 */

import { randomUUID } from 'node:crypto'

import type { ArchiveCandidate } from '../transcript/types'
import type { ArchiveArtifact, ArchiveArtifactFrontmatter } from './types'

/**
 * Build an ArchiveArtifact from a projection ArchiveCandidate.
 *
 * Confidence assignment:
 *   - tool_interaction → medium (structured, usually reliable)
 *   - text (assistant)  → low (may contain reasoning that drifts)
 */
export function buildArchiveArtifact(
  candidate: ArchiveCandidate,
  runId: string,
  taskId: string,
): ArchiveArtifact {
  const confidence: ArchiveArtifactFrontmatter['confidence'] =
    candidate.originalKind === 'tool_interaction' ? 'medium' : 'low'

  const summaryType: ArchiveArtifactFrontmatter['summary_type'] =
    candidate.reason === 'compacted' ? 'compacted_block' : 'dropped_block'

  const frontmatter: ArchiveArtifactFrontmatter = {
    id: randomUUID(),
    scope: 'run',
    run_id: runId,
    task_id: taskId,
    created_at: candidate.createdAt,
    summary_type: summaryType,
    confidence,
    tags: candidate.tags,
    related_files: [], // V1: no file path extraction
    source: 'transcript_projection',
    human_verified: false,
  }

  return {
    frontmatter,
    summary: candidate.summary,
    sourceRange: candidate.entryIdRange,
    transcriptExcerpt: candidate.normalizedContent,
  }
}

/**
 * Serialize an ArchiveArtifact to a markdown string with YAML frontmatter.
 *
 * Format:
 *   ---
 *   <yaml frontmatter>
 *   ---
 *   ## Summary
 *   <summary>
 *   ## Source Range
 *   entries [start, end]
 *   ## Transcript Excerpt
 *   <full normalized content>
 */
export function serializeArchiveArtifact(artifact: ArchiveArtifact): string {
  const fm = artifact.frontmatter
  const yamlLines = [
    `id: ${fm.id}`,
    `scope: ${fm.scope}`,
    `run_id: ${fm.run_id}`,
    `task_id: ${fm.task_id}`,
    `created_at: ${fm.created_at}`,
    `summary_type: ${fm.summary_type}`,
    `confidence: ${fm.confidence}`,
    `tags: [${fm.tags.map(t => JSON.stringify(t)).join(', ')}]`,
    `related_files: [${fm.related_files.map(f => JSON.stringify(f)).join(', ')}]`,
    `source: ${fm.source}`,
    `human_verified: ${fm.human_verified}`,
  ]

  const sections = [
    `---`,
    ...yamlLines,
    `---`,
    ``,
    `## Summary`,
    ``,
    artifact.summary,
    ``,
    `## Source Range`,
    ``,
    `entries [${artifact.sourceRange[0]}, ${artifact.sourceRange[1]}]`,
    ``,
    `## Transcript Excerpt`,
    ``,
    artifact.transcriptExcerpt,
    ``,
  ]

  return sections.join('\n')
}

/**
 * Generate a stable filename for an archive artifact.
 * Format: `{start}-{end}-{reason}.md`
 */
export function archiveArtifactFilename(
  entryIdRange: [number, number],
  reason: 'compacted' | 'dropped',
): string {
  return `${entryIdRange[0]}-${entryIdRange[1]}-${reason}.md`
}
