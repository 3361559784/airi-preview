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

  it('promotes active entries into default search and context with verification marker', async () => {
    const store = await createStore()
    const proposed = await store.propose({
      kind: 'pitfall',
      statement: 'Do not treat live evals as deterministic CI coverage.',
      evidence: 'Live model behavior depends on API keys and model output.',
      confidence: 'high',
      tags: ['eval'],
    })

    const active = await store.updateStatus(proposed.id, 'active', true)

    expect(active.status).toBe('active')
    expect(active.humanVerified).toBe(true)
    expect(store.search('deterministic')).toHaveLength(1)
    expect(store.search('Fix deterministic CI coverage task')).toHaveLength(1)
    expect(store.toContextString('deterministic')).toContain('[pitfall/high/verified]')
    expect(store.toContextString('deterministic')).toContain('Do not treat live evals')
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

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n')

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
    await store.updateStatus(proposed.id, 'active', true)

    const reloaded = await createStore()
    const entry = reloaded.read(proposed.id)

    expect(entry).toMatchObject({
      id: proposed.id,
      status: 'active',
      humanVerified: true,
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

    await storeA.updateStatus(entryA.id, 'active', true)
    await storeB.updateStatus(entryB.id, 'active', true)

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
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(2)
  })
})
