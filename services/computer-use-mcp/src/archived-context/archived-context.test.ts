import type { TranscriptBlock, TranscriptEntry } from '../transcript/types'
import type { ArchiveCandidate } from './types'

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { planTranscriptRetention } from '../transcript/retention'
import { buildArchiveCandidates } from './candidates'
import { archiveArtifactFilename, buildArchiveArtifact, serializeArchiveArtifact } from './serializer'
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

let entryId = 0

function transcriptEntry(role: TranscriptEntry['role'], content: string): TranscriptEntry {
  return {
    id: entryId++,
    at: new Date().toISOString(),
    role,
    content,
  }
}

function toolInteraction(callId: string, toolName: string, args: string, resultContent: string): TranscriptEntry[] {
  const assistantEntry: TranscriptEntry = {
    id: entryId++,
    at: new Date().toISOString(),
    role: 'assistant',
    content: '',
    toolCalls: [{ id: callId, type: 'function', function: { name: toolName, arguments: args } }],
  }
  const resultEntry: TranscriptEntry = {
    id: entryId++,
    at: new Date().toISOString(),
    role: 'tool',
    content: resultContent,
    toolCallId: callId,
  }
  return [assistantEntry, resultEntry]
}

function blockKey(block: TranscriptBlock): string {
  return `${block.kind}:${block.entryIdRange[0]}:${block.entryIdRange[1]}`
}

function candidateKey(candidate: ArchiveCandidate): string {
  return `${candidate.originalKind}:${candidate.entryIdRange[0]}:${candidate.entryIdRange[1]}`
}

// ---------------------------------------------------------------------------
// Candidate builder tests
// ---------------------------------------------------------------------------

describe('buildArchiveCandidates', () => {
  beforeEach(() => {
    entryId = 0
  })

  it('returns empty candidates when no blocks are removed', () => {
    const entries = [
      transcriptEntry('user', 'task'),
      ...toolInteraction('t1', 'coding_read_file', '{"path":"x.ts"}', 'content here'),
    ]

    const candidates = buildArchiveCandidates(entries, {
      maxFullToolBlocks: 5,
      maxFullTextBlocks: 3,
      maxCompactedBlocks: 4,
    })

    expect(candidates).toEqual([])
  })

  it('splits removed blocks into compacted and dropped candidates', () => {
    const entries = [
      transcriptEntry('user', 'task'),
      ...toolInteraction('t1', 'tool_a', '{}', 'result a'),
      ...toolInteraction('t2', 'tool_b', '{}', 'result b'),
      ...toolInteraction('t3', 'tool_c', '{}', 'result c'),
    ]

    const candidates = buildArchiveCandidates(entries, {
      maxFullToolBlocks: 1,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 1,
    })

    expect(candidates.map(c => c.reason)).toEqual(['compacted', 'dropped'])
    expect(candidates.map(c => c.originalKind)).toEqual(['tool_interaction', 'tool_interaction'])
  })

  it('derives eligible candidates from retention compacted and dropped source ranges', () => {
    const entries = [
      transcriptEntry('user', 'task'),
      ...toolInteraction('t1', 'tool_a', '{}', 'result a'),
      ...toolInteraction('t2', 'tool_b', '{}', 'result b'),
      ...toolInteraction('t3', 'tool_c', '{}', 'result c'),
    ]
    const opts = {
      maxFullToolBlocks: 1,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 1,
    }

    const retention = planTranscriptRetention(entries, opts)
    const candidates = buildArchiveCandidates(entries, opts)
    const keptKeys = new Set(retention.keptFullBlocks.map(blockKey))
    const compactedKeys = new Set(retention.compactedSourceBlocks.map(blockKey))
    const droppedKeys = new Set(retention.droppedSourceBlocks.map(blockKey))

    expect(candidates.map(candidate => ({
      key: candidateKey(candidate),
      reason: candidate.reason,
    }))).toEqual([
      { key: 'tool_interaction:3:4', reason: 'compacted' },
      { key: 'tool_interaction:1:2', reason: 'dropped' },
    ])

    for (const candidate of candidates) {
      const key = candidateKey(candidate)
      expect(keptKeys.has(key)).toBe(false)
      expect(candidate.reason === 'compacted' ? compactedKeys.has(key) : droppedKeys.has(key)).toBe(true)
    }
  })

  it('does not duplicate candidates when maxCompactedBlocks is zero', () => {
    const entries = [
      transcriptEntry('user', 'task'),
      ...toolInteraction('t1', 'tool_a', '{}', 'result a'),
      ...toolInteraction('t2', 'tool_b', '{}', 'result b'),
    ]

    const candidates = buildArchiveCandidates(entries, {
      maxFullToolBlocks: 0,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 0,
    })

    expect(candidates).toHaveLength(2)
    expect(candidates.every(c => c.reason === 'dropped')).toBe(true)
    expect(new Set(candidates.map(c => c.entryIdRange.join(':'))).size).toBe(candidates.length)
  })

  it('preserves full normalized content instead of compactor snippets', () => {
    const longResult = 'x'.repeat(500)
    const entries = [
      transcriptEntry('user', 'task'),
      ...toolInteraction('t1', 'coding_read_file', '{"path":"x.ts"}', longResult),
    ]

    const candidates = buildArchiveCandidates(entries, {
      maxFullToolBlocks: 0,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 1,
    })

    expect(candidates[0].normalizedContent).toContain(longResult)
  })

  it('filters orphan tool TextBlocks before text length eligibility', () => {
    const entries: TranscriptEntry[] = [
      transcriptEntry('user', 'task'),
      {
        id: entryId++,
        at: new Date().toISOString(),
        role: 'tool',
        content: 'orphan'.repeat(100),
        toolCallId: 'missing',
      },
    ]

    const candidates = buildArchiveCandidates(entries, {
      maxFullToolBlocks: 0,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 0,
    })

    expect(candidates).toEqual([])
  })

  it('archives long assistant text but skips short assistant text', () => {
    const entries = [
      transcriptEntry('user', 'task'),
      transcriptEntry('assistant', 'short'),
      transcriptEntry('assistant', 'T'.repeat(250)),
    ]

    const candidates = buildArchiveCandidates(entries, {
      maxFullToolBlocks: 0,
      maxFullTextBlocks: 0,
      maxCompactedBlocks: 0,
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0].normalizedContent).toBe('T'.repeat(250))
  })
})

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

describe('archiveContextStore', () => {
  let tmpDir: string
  const runId = `test-run-${randomUUID().slice(0, 8)}`
  const taskId = runId

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `archive-test-${randomUUID().slice(0, 8)}`)
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

  it('searches existing current-run artifacts by substring', async () => {
    const store = new ArchiveContextStore(tmpDir)
    await store.init(runId, taskId)

    await store.writeCandidates([
      makeToolCandidate({
        entryIdRange: [10, 12],
        normalizedContent: 'The previous failure involved CONFIG_DEBUG_MODE and stale imports.',
      }),
    ], runId, taskId)

    const hits = await store.search(runId, 'CONFIG_DEBUG_MODE')

    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      artifactId: '10-12-compacted.md',
      sourceRange: [10, 12],
      reason: 'compacted',
    })
    expect(hits[0].excerpt).toContain('CONFIG_DEBUG_MODE')
  })

  it('reads artifacts only by safe artifact id', async () => {
    const store = new ArchiveContextStore(tmpDir)
    await store.init(runId, taskId)
    await store.writeCandidates([makeToolCandidate({ entryIdRange: [20, 22] })], runId, taskId)

    await expect(store.readArtifact(runId, '../secret.md')).rejects.toThrow('Invalid archive artifact id')

    const content = await store.readArtifact(runId, '20-22-compacted.md')
    expect(content).toContain('## Transcript Excerpt')
  })
})
