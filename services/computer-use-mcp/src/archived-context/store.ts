/**
 * Archive Context Store — file-backed write-only store for archive artifacts.
 *
 * Layout:
 *   {archiveRoot}/run/{run_id}/{start}-{end}-{reason}.md
 *
 * V1 guarantees:
 *   - Append-only: never modifies existing files
 *   - Dedup: same block (same run_id + task_id + entryIdRange + reason) is never written twice
 *   - Init scans existing directory to rebuild dedup index
 */

import type { ArchiveCandidate, ArchiveDeduplicationKey, ArchiveSearchHit } from './types'

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { archiveArtifactFilename, buildArchiveArtifact, serializeArchiveArtifact } from './serializer'
import { buildDeduplicationKey } from './types'

const ARCHIVE_ARTIFACT_FILENAME_RE = /^\d+-\d+-(?:compacted|dropped)\.md$/
const ARCHIVE_ARTIFACT_FILENAME_PARTS_RE = /^(\d+)-(\d+)-(?:compacted|dropped)\.md$/
const WHITESPACE_RE = /\s+/g

export class ArchiveContextStore {
  private readonly seenKeys = new Set<ArchiveDeduplicationKey>()
  private initialized = false

  constructor(private readonly archiveRoot: string) {}

  /**
   * Initialize the store by scanning existing archive files to rebuild the
   * dedup index. Must be called before writeCandidates().
   *
   * NOTICE: We rebuild the dedup index from filenames (which encode entryIdRange
   * and reason) rather than parsing frontmatter. This is fast and avoids I/O
   * per file. The tradeoff is we can't deduplicate across different run_ids in
   * the same session — but that case doesn't arise in V1 (one run_id per
   * runCodingTask invocation).
   */
  async init(runId: string, taskId: string): Promise<void> {
    const runDir = join(this.archiveRoot, 'run', runId)

    try {
      const entries = await readdir(runDir)
      for (const filename of entries) {
        if (!filename.endsWith('.md'))
          continue
        // Filename format: {start}-{end}-{reason}.md
        const withoutExt = filename.slice(0, -3)
        const parts = withoutExt.split('-')
        if (parts.length < 3)
          continue
        const reason = parts.at(-1) as 'compacted' | 'dropped'
        if (reason !== 'compacted' && reason !== 'dropped')
          continue
        const end = Number(parts[parts.length - 2])
        const start = Number(parts[parts.length - 3])
        if (Number.isNaN(start) || Number.isNaN(end))
          continue

        const key = buildDeduplicationKey(runId, taskId, [start, end], reason)
        this.seenKeys.add(key)
      }
    }
    catch {
      // Directory doesn't exist yet — that's fine, will be created on first write
    }

    this.initialized = true
  }

  /**
   * Write archive candidates for the current projection turn.
   * Candidates already seen are skipped (dedup by entryIdRange + reason).
   */
  async writeCandidates(
    candidates: ArchiveCandidate[],
    runId: string,
    taskId: string,
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('ArchiveContextStore.init() must be called before writeCandidates()')
    }

    for (const candidate of candidates) {
      const key = buildDeduplicationKey(runId, taskId, candidate.entryIdRange, candidate.reason)
      if (this.seenKeys.has(key))
        continue

      const artifact = buildArchiveArtifact(candidate, runId, taskId)
      const content = serializeArchiveArtifact(artifact)
      const filename = archiveArtifactFilename(candidate.entryIdRange, candidate.reason)
      const runDir = join(this.archiveRoot, 'run', runId)

      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, filename), content, 'utf8')
      this.seenKeys.add(key)
    }
  }

  /**
   * Search current-run archive artifacts with deterministic substring matching.
   * V1 is intentionally simple: no vector index, no cross-run retrieval.
   */
  async search(runId: string, query: string, limit = 5): Promise<ArchiveSearchHit[]> {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery)
      return []
    if (limit <= 0)
      return []

    const runDir = join(this.archiveRoot, 'run', runId)
    let filenames: string[]
    try {
      filenames = await readdir(runDir)
    }
    catch {
      return []
    }

    const hits: ArchiveSearchHit[] = []
    for (const filename of filenames.sort()) {
      if (!isArchiveArtifactFilename(filename))
        continue

      const content = await readFile(join(runDir, filename), 'utf8')
      const index = content.toLowerCase().indexOf(normalizedQuery)
      if (index < 0)
        continue

      hits.push({
        artifactId: filename,
        sourceRange: sourceRangeFromFilename(filename),
        reason: reasonFromFilename(filename),
        summary: extractSection(content, 'Summary').slice(0, 500),
        excerpt: excerptAround(content, index),
      })

      if (hits.length >= limit)
        break
    }

    return hits
  }

  /**
   * Read a single current-run artifact by artifactId returned from search().
   */
  async readArtifact(runId: string, artifactId: string): Promise<string> {
    if (!isArchiveArtifactFilename(artifactId))
      throw new Error('Invalid archive artifact id')

    return readFile(join(this.archiveRoot, 'run', runId, artifactId), 'utf8')
  }
}

function isArchiveArtifactFilename(filename: string): boolean {
  return ARCHIVE_ARTIFACT_FILENAME_RE.test(filename)
}

function sourceRangeFromFilename(filename: string): [number, number] {
  const match = ARCHIVE_ARTIFACT_FILENAME_PARTS_RE.exec(filename)
  if (!match)
    throw new Error('Invalid archive artifact filename')
  return [Number(match[1]), Number(match[2])]
}

function reasonFromFilename(filename: string): 'compacted' | 'dropped' {
  return filename.endsWith('-compacted.md') ? 'compacted' : 'dropped'
}

function extractSection(markdown: string, heading: string): string {
  const marker = `## ${heading}`
  const start = markdown.indexOf(marker)
  if (start < 0)
    return ''
  const bodyStart = start + marker.length
  const next = markdown.indexOf('\n## ', bodyStart)
  return markdown
    .slice(bodyStart, next < 0 ? undefined : next)
    .trim()
}

function excerptAround(content: string, index: number): string {
  const start = Math.max(0, index - 120)
  const end = Math.min(content.length, index + 240)
  return content.slice(start, end).replace(WHITESPACE_RE, ' ').trim()
}
