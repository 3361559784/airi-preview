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

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ArchiveCandidate } from '../transcript/types'
import type { ArchiveDeduplicationKey } from './types'
import { archiveArtifactFilename, buildArchiveArtifact, serializeArchiveArtifact } from './serializer'
import { buildDeduplicationKey } from './types'

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
        if (!filename.endsWith('.md')) continue
        // Filename format: {start}-{end}-{reason}.md
        const withoutExt = filename.slice(0, -3)
        const parts = withoutExt.split('-')
        if (parts.length < 3) continue
        const reason = parts[parts.length - 1] as 'compacted' | 'dropped'
        if (reason !== 'compacted' && reason !== 'dropped') continue
        const end = Number(parts[parts.length - 2])
        const start = Number(parts[parts.length - 3])
        if (Number.isNaN(start) || Number.isNaN(end)) continue

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
      if (this.seenKeys.has(key)) continue

      const artifact = buildArchiveArtifact(candidate, runId, taskId)
      const content = serializeArchiveArtifact(artifact)
      const filename = archiveArtifactFilename(candidate.entryIdRange, candidate.reason)
      const runDir = join(this.archiveRoot, 'run', runId)

      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, filename), content, 'utf8')
      this.seenKeys.add(key)
    }
  }
}
