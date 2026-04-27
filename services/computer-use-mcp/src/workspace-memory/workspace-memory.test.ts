import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { workspaceKeyFromPath, WorkspaceMemoryStore } from './store'

describe('workspaceMemoryStore', () => {
  let tmpRoot: string
  let filePath: string
  let workspacePath: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'workspace-memory-'))
    filePath = join(tmpRoot, 'workspace-memory.jsonl')
    workspacePath = join(tmpRoot, 'repo-a')
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  async function createStore(path = workspacePath, runId = 'run-1') {
    const store = new WorkspaceMemoryStore(filePath, {
      workspacePath: path,
      sourceRunId: runId,
    })
    await store.init()
    return store
  }

  async function jsonlRows(): Promise<string[]> {
    const content = await readFile(filePath, 'utf8')
    return content.trim() ? content.trim().split('\n') : []
  }

  it('keeps proposed entries out of default search and prompt context', async () => {
    const store = await createStore()
    const entry = await store.propose({
      kind: 'constraint',
      statement: 'Use pnpm workspace filters for computer-use-mcp tests.',
      evidence: 'Observed package scripts and successful filtered test runs.',
      confidence: 'medium',
      tags: ['pnpm', 'tests'],
    })

    expect(entry.status).toBe('proposed')
    expect(store.search('pnpm')).toEqual([])
    expect(store.toContextString('pnpm')).toBe('')
    expect(store.search('pnpm', { includeProposed: true })).toHaveLength(1)
  })

  it('reviews proposed entries into active search and context with verification marker', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'pitfall',
      statement: 'Do not treat live evals as deterministic CI coverage.',
      evidence: 'Live model behavior depends on API keys and model output.',
      confidence: 'high',
      tags: ['eval'],
    })

    const active = await store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Verified against package eval behavior.',
    })

    expect(active.status).toBe('active')
    expect(active.humanVerified).toBe(true)
    expect(active.review).toMatchObject({
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Verified against package eval behavior.',
    })
    expect(active.review?.reviewedAt).toBeTruthy()
    expect(store.search('deterministic')).toHaveLength(1)
    expect(store.search('Fix deterministic CI coverage task')).toHaveLength(1)
    expect(store.toContextString('deterministic')).toContain('[pitfall/high/verified]')
    expect(store.toContextString('deterministic')).toContain('Do not treat live evals')
  })

  it('reviews proposed entries into rejected state without prompt injection', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'fact',
      statement: 'Speculative one-run observation should not persist.',
      evidence: 'Only observed once during a local run.',
    })

    const rejected = await store.review({
      id: proposed.id,
      decision: 'reject',
      reviewer: 'maintainer',
      rationale: 'One-run observation is not durable workspace knowledge.',
    })

    expect(rejected.status).toBe('rejected')
    expect(rejected.humanVerified).toBe(false)
    expect(rejected.review).toMatchObject({
      decision: 'reject',
      reviewer: 'maintainer',
    })
    expect(store.search('Speculative')).toEqual([])
    expect(store.search('Speculative', { includeProposed: true })).toEqual([])
    expect(store.toContextString('Speculative')).toBe('')
  })

  it('removes active entries from prompt context when rejected', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'constraint',
      statement: 'Old validation command should be replaced.',
      evidence: 'Previous package script output.',
      confidence: 'medium',
    })
    const active = await store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Initially matched package scripts.',
    })

    expect(store.toContextString('validation')).toContain('Old validation command')

    const rejected = await store.review({
      id: active.id,
      decision: 'reject',
      reviewer: 'maintainer',
      rationale: 'Superseded by newer package scripts.',
    })

    expect(rejected.status).toBe('rejected')
    expect(rejected.humanVerified).toBe(false)
    expect(store.search('validation')).toEqual([])
    expect(store.toContextString('validation')).toBe('')
  })

  it('requires a fresh review to reactivate rejected entries', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'command',
      statement: 'Run the filtered package test before claiming green.',
      evidence: 'Package script supports filtered test execution.',
      confidence: 'high',
    })
    await store.review({
      id: proposed.id,
      decision: 'reject',
      reviewer: 'maintainer-a',
      rationale: 'Needs stronger evidence.',
    })

    const reactivated = await store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer-b',
      rationale: 'Re-reviewed package scripts and confirmed this command is durable.',
    })

    expect(reactivated.status).toBe('active')
    expect(reactivated.humanVerified).toBe(true)
    expect(reactivated.review).toMatchObject({
      decision: 'activate',
      reviewer: 'maintainer-b',
      rationale: 'Re-reviewed package scripts and confirmed this command is durable.',
    })
    expect(store.toContextString('filtered package test')).toContain('[command/high/verified]')
  })

  it('rejects empty review metadata without appending JSONL rows', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'fact',
      statement: 'Workspace memory review needs concrete rationale.',
      evidence: 'Governance policy requires reviewer metadata.',
    })
    const rowsBefore = await jsonlRows()

    await expect(store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: ' ',
      rationale: 'Valid rationale.',
    })).rejects.toThrow('reviewer is required')
    await expect(store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: ' ',
    })).rejects.toThrow('rationale is required')

    expect(await jsonlRows()).toHaveLength(rowsBefore.length)
    expect(store.read(proposed.id)?.status).toBe('proposed')
  })

  it('rejects no-op reviews without appending JSONL rows', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'pitfall',
      statement: 'No-op reviews must not pollute append-only memory logs.',
      evidence: 'Status updates are stored as append-only JSONL rows.',
    })
    await store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Confirmed as durable pitfall.',
    })
    const rowsBefore = await jsonlRows()

    await expect(store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Duplicate activation should fail.',
    })).rejects.toThrow('review is a no-op')

    expect(await jsonlRows()).toHaveLength(rowsBefore.length)
    expect(store.read(proposed.id)?.status).toBe('active')
  })

  it('rejects invalid review decisions without appending JSONL rows', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'fact',
      statement: 'Review decisions must be explicit governance actions.',
      evidence: 'Only activate and reject are valid review decisions.',
    })
    const rowsBefore = await jsonlRows()

    await expect(store.review({
      id: proposed.id,
      decision: 'archive' as any,
      reviewer: 'maintainer',
      rationale: 'Invalid decisions must not silently reject memory.',
    })).rejects.toThrow('review decision is invalid')

    expect(await jsonlRows()).toHaveLength(rowsBefore.length)
    expect(store.read(proposed.id)?.status).toBe('proposed')
  })

  it('deduplicates equivalent proposals for the same workspace', async () => {
    const store = await createStore()
    const first = await store.propose({
      kind: 'command',
      statement: 'Run pnpm -F @proj-airi/computer-use-mcp test before claiming the line is green.',
      evidence: 'The package has a dedicated filtered test script.',
      relatedFiles: ['services/computer-use-mcp/package.json'],
    })
    const second = await store.propose({
      kind: 'command',
      statement: '  Run pnpm -F @proj-airi/computer-use-mcp test before claiming the line is green. ',
      evidence: 'Different wording should not matter for dedup once the statement matches.',
      relatedFiles: ['services/computer-use-mcp/package.json'],
    })

    const lines = await jsonlRows()

    expect(second.id).toBe(first.id)
    expect(store.getAll()).toHaveLength(1)
    expect(lines).toHaveLength(1)
  })

  it('rebuilds latest status from append-only JSONL on init', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'fact',
      statement: 'Transcript is the truth source for the coding runner.',
      evidence: 'Runner appends xsai delta messages into TranscriptStore.',
    })
    await store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Verified transcript storage behavior in runner implementation.',
    })

    const reloaded = await createStore()
    const entry = reloaded.read(proposed.id)

    expect(entry).toMatchObject({
      id: proposed.id,
      status: 'active',
      humanVerified: true,
      review: {
        decision: 'activate',
        reviewer: 'maintainer',
        rationale: 'Verified transcript storage behavior in runner implementation.',
      },
    })
    expect(reloaded.search('truth source')).toHaveLength(1)
  })

  it('filters entries by normalized workspace key when stores share a file', async () => {
    const workspaceB = join(tmpRoot, 'repo-b')
    const storeA = await createStore(workspacePath, 'run-a')
    const storeB = await createStore(workspaceB, 'run-b')

    const entryA = await storeA.propose({
      kind: 'fact',
      statement: 'Repo A uses transcript archives.',
      evidence: 'Evidence A.',
    })
    const entryB = await storeB.propose({
      kind: 'fact',
      statement: 'Repo B uses a different memory file.',
      evidence: 'Evidence B.',
    })

    await storeA.review({
      id: entryA.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Repo A fact is scoped to repo A.',
    })
    await storeB.review({
      id: entryB.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Repo B fact is scoped to repo B.',
    })

    const reloadedA = await createStore(workspacePath, 'run-a2')
    const reloadedB = await createStore(workspaceB, 'run-b2')

    expect(reloadedA.search('Repo A')).toHaveLength(1)
    expect(reloadedA.search('Repo B')).toHaveLength(0)
    expect(reloadedB.search('Repo B')).toHaveLength(1)
    expect(workspaceKeyFromPath(`${workspacePath}/../repo-a`)).toBe(workspaceKeyFromPath(workspacePath))
  })

  it('serializes concurrent proposals without duplicate IDs or JSONL rows', async () => {
    const store = await createStore()

    await Promise.all([
      store.propose({
        kind: 'constraint',
        statement: 'Keep coding memory changes out of desktop PRs.',
        evidence: 'Scope guard from AIRI coding line.',
      }),
      store.propose({
        kind: 'pitfall',
        statement: 'Do not call a manual eval CI-stable.',
        evidence: 'Live model runs are not deterministic.',
      }),
    ])

    const ids = store.getAll().map(entry => entry.id)
    expect(new Set(ids).size).toBe(2)
    expect(await jsonlRows()).toHaveLength(2)
  })
})
