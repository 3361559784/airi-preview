import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import type { ArchiveCandidate } from '../transcript/types'
import { buildArchiveArtifact, serializeArchiveArtifact, archiveArtifactFilename } from './serializer'
import { ArchiveContextStore } from './store'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeToolCandidate(overrides: Partial<ArchiveCandidate> = {}): ArchiveCandidate {
  return {
    reason: 'compacted',
    originalKind: 'tool_interaction',
    entryIdRange: [1, 3],
    summary: '[Compacted tool interaction] Tools: coding_read_file\n  call_1: ok — file content here',
    normalizedContent: 'Tool: coding_read_file\nArguments:\n{"path": "/tmp/test.ts"}\n\nResult (call_1):\nexport function hello() { return "world"; }',
    createdAt: '2026-04-20T06:00:00.000Z',
    tags: ['coding_read_file'],
    ...overrides,
  }
}

function makeTextCandidate(overrides: Partial<ArchiveCandidate> = {}): ArchiveCandidate {
  return {
    reason: 'dropped',
    originalKind: 'text',
    entryIdRange: [5, 5],
    summary: '[Compacted assistant text] This is a long reasoning block that exceeds…',
    normalizedContent: 'This is a long reasoning block that exceeds the minimum length threshold for archiving. It contains useful context about what the model was thinking during the coding task and should be preserved for future reference if needed.',
    createdAt: '2026-04-20T06:01:00.000Z',
    tags: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Serializer tests
// ---------------------------------------------------------------------------

describe('buildArchiveArtifact', () => {
  const runId = 'run-abc-123'
  const taskId = 'run-abc-123'

  it('produces artifact with all required frontmatter fields', () => {
    const candidate = makeToolCandidate()
    const artifact = buildArchiveArtifact(candidate, runId, taskId)
    const fm = artifact.frontmatter

    expect(fm.id).toBeTruthy()
    expect(fm.scope).toBe('run')
    expect(fm.run_id).toBe(runId)
    expect(fm.task_id).toBe(taskId)
    expect(fm.created_at).toBe(candidate.createdAt)
    expect(fm.summary_type).toBe('compacted_block')
    expect(fm.confidence).toBe('medium')
    expect(fm.tags).toEqual(['coding_read_file'])
    expect(fm.related_files).toEqual([])
    expect(fm.source).toBe('transcript_projection')
    expect(fm.human_verified).toBe(false)
  })

  it('assigns medium confidence for tool_interaction, low for text', () => {
    const toolArtifact = buildArchiveArtifact(makeToolCandidate({ originalKind: 'tool_interaction' }), runId, taskId)
    const textArtifact = buildArchiveArtifact(makeTextCandidate({ originalKind: 'text' }), runId, taskId)

    expect(toolArtifact.frontmatter.confidence).toBe('medium')
    expect(textArtifact.frontmatter.confidence).toBe('low')
  })

  it('assigns summary_type based on reason', () => {
    const compacted = buildArchiveArtifact(makeToolCandidate({ reason: 'compacted' }), runId, taskId)
    const dropped = buildArchiveArtifact(makeToolCandidate({ reason: 'dropped' }), runId, taskId)

    expect(compacted.frontmatter.summary_type).toBe('compacted_block')
    expect(dropped.frontmatter.summary_type).toBe('dropped_block')
  })

  it('preserves sourceRange and transcriptExcerpt from candidate', () => {
    const candidate = makeToolCandidate()
    const artifact = buildArchiveArtifact(candidate, runId, taskId)

    expect(artifact.sourceRange).toEqual([1, 3])
    expect(artifact.transcriptExcerpt).toBe(candidate.normalizedContent)
  })
})

describe('serializeArchiveArtifact', () => {
  const runId = 'run-abc-123'
  const taskId = 'run-abc-123'

  it('produces markdown with YAML frontmatter and 3 sections', () => {
    const artifact = buildArchiveArtifact(makeToolCandidate(), runId, taskId)
    const md = serializeArchiveArtifact(artifact)

    expect(md).toMatch(/^---\n/)
    expect(md).toContain('---\n')
    expect(md).toContain('## Summary')
    expect(md).toContain('## Source Range')
    expect(md).toContain('## Transcript Excerpt')
  })

  it('includes all frontmatter fields', () => {
    const artifact = buildArchiveArtifact(makeToolCandidate(), runId, taskId)
    const md = serializeArchiveArtifact(artifact)

    expect(md).toContain('scope: run')
    expect(md).toContain(`run_id: ${runId}`)
    expect(md).toContain(`task_id: ${taskId}`)
    expect(md).toContain('confidence: medium')
    expect(md).toContain('source: transcript_projection')
    expect(md).toContain('human_verified: false')
  })

  it('transcriptExcerpt is NOT truncated to 120 chars', () => {
    const longContent = 'A'.repeat(500)
    const candidate = makeToolCandidate({ normalizedContent: longContent })
    const artifact = buildArchiveArtifact(candidate, runId, taskId)
    const md = serializeArchiveArtifact(artifact)

    expect(md).toContain('A'.repeat(500))
    expect(md).not.toContain('…')
  })

  it('source range references entry ids', () => {
    const artifact = buildArchiveArtifact(makeToolCandidate(), runId, taskId)
    const md = serializeArchiveArtifact(artifact)

    expect(md).toContain('entries [1, 3]')
  })
})

describe('archiveArtifactFilename', () => {
  it('generates stable filename from entryIdRange and reason', () => {
    expect(archiveArtifactFilename([1, 3], 'compacted')).toBe('1-3-compacted.md')
    expect(archiveArtifactFilename([5, 5], 'dropped')).toBe('5-5-dropped.md')
  })
})

// ---------------------------------------------------------------------------
// Store tests
// ---------------------------------------------------------------------------

describe('ArchiveContextStore', () => {
  let tmpDir: string
  const runId = 'test-run-' + randomUUID().slice(0, 8)
  const taskId = runId

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'archive-test-' + randomUUID().slice(0, 8))
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes candidate to run/{runId}/{start}-{end}-{reason}.md', async () => {
    const store = new ArchiveContextStore(tmpDir)
    await store.init(runId, taskId)

    await store.writeCandidates([makeToolCandidate()], runId, taskId)

    const files = await readdir(join(tmpDir, 'run', runId))
    expect(files).toContain('1-3-compacted.md')
  })

  it('does not write duplicate — same candidate written twice produces one file', async () => {
    const store = new ArchiveContextStore(tmpDir)
    await store.init(runId, taskId)

    const candidate = makeToolCandidate()
    await store.writeCandidates([candidate], runId, taskId)
    await store.writeCandidates([candidate], runId, taskId)

    const files = await readdir(join(tmpDir, 'run', runId))
    expect(files.filter(f => f === '1-3-compacted.md')).toHaveLength(1)
  })

  it('writes different candidates as separate files', async () => {
    const store = new ArchiveContextStore(tmpDir)
    await store.init(runId, taskId)

    await store.writeCandidates([
      makeToolCandidate({ entryIdRange: [1, 3], reason: 'compacted' }),
      makeTextCandidate({ entryIdRange: [5, 5], reason: 'dropped' }),
    ], runId, taskId)

    const files = await readdir(join(tmpDir, 'run', runId))
    expect(files).toContain('1-3-compacted.md')
    expect(files).toContain('5-5-dropped.md')
  })

  it('rebuilds dedup index from existing files on init — does not re-write them', async () => {
    // First store instance writes one file
    const store1 = new ArchiveContextStore(tmpDir)
    await store1.init(runId, taskId)
    await store1.writeCandidates([makeToolCandidate()], runId, taskId)

    // Second store instance initialized on same dir should recognise existing file
    const store2 = new ArchiveContextStore(tmpDir)
    await store2.init(runId, taskId)
    await store2.writeCandidates([makeToolCandidate()], runId, taskId)

    const files = await readdir(join(tmpDir, 'run', runId))
    expect(files.filter(f => f === '1-3-compacted.md')).toHaveLength(1)
  })

  it('throws if writeCandidates called before init', async () => {
    const store = new ArchiveContextStore(tmpDir)
    await expect(store.writeCandidates([], runId, taskId)).rejects.toThrow('init')
  })
})
