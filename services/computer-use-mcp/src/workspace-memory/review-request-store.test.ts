import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WorkspaceMemoryReviewRequestStore } from './review-request-store'
import { workspaceKeyFromPath, WorkspaceMemoryStore } from './store'

describe('workspaceMemoryReviewRequestStore', () => {
  let tmpRoot: string
  let workspacePath: string
  let memoryPath: string
  let requestPath: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'workspace-memory-review-requests-'))
    workspacePath = join(tmpRoot, 'repo')
    const workspaceKey = workspaceKeyFromPath(workspacePath)
    memoryPath = join(tmpRoot, 'workspace-memory', `${workspaceKey}.jsonl`)
    requestPath = join(tmpRoot, 'workspace-memory-review-requests', `${workspaceKey}.jsonl`)
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  async function createMemoryStore() {
    const store = new WorkspaceMemoryStore(memoryPath, {
      workspacePath,
      sourceRunId: 'run-1',
    })
    await store.init()
    return store
  }

  async function createRequestStore() {
    const store = new WorkspaceMemoryReviewRequestStore(requestPath, { workspacePath })
    await store.init()
    return store
  }

  async function jsonlRows(path: string): Promise<string[]> {
    const content = await readFile(path, 'utf8')
    return content.trim() ? content.trim().split('\n') : []
  }

  it('creates a pending review request without changing memory status', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'constraint',
      statement: 'Use package filters before claiming tests are green.',
      evidence: 'The package exposes filtered pnpm scripts.',
      confidence: 'high',
    })

    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'This command is durable workspace guidance.',
    }, memoryStore.read(proposed.id))

    expect(request).toMatchObject({
      workspaceKey: workspaceKeyFromPath(workspacePath),
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'This command is durable workspace guidance.',
      status: 'pending',
      targetStatus: 'proposed',
      targetUpdatedAt: proposed.updatedAt,
      targetStatement: proposed.statement,
    })
    expect(memoryStore.read(proposed.id)?.status).toBe('proposed')
    expect(await jsonlRows(memoryPath)).toHaveLength(1)
    expect(await jsonlRows(requestPath)).toHaveLength(1)
  })

  it('rejects missing target memory without appending JSONL rows', async () => {
    await createMemoryStore()
    const requestStore = await createRequestStore()

    await expect(requestStore.request({
      memoryId: 'missing',
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Missing memory cannot be reviewed.',
    }, undefined)).rejects.toThrow('Workspace memory entry not found: missing')

    await expect(readFile(requestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects no-op decisions without appending JSONL rows', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'fact',
      statement: 'This fact is already active.',
      evidence: 'Maintainer reviewed it.',
    })
    const active = await memoryStore.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Verified.',
    })

    await expect(requestStore.request({
      memoryId: active.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Duplicate activation should not create a request.',
    }, memoryStore.read(active.id))).rejects.toThrow('review request is a no-op')

    await expect(readFile(requestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects empty requester or rationale without appending JSONL rows', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'pitfall',
      statement: 'Review request metadata must be concrete.',
      evidence: 'Governance request records require attribution.',
    })

    await expect(requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: ' ',
      rationale: 'Valid rationale.',
    }, memoryStore.read(proposed.id))).rejects.toThrow('requester is required')
    await expect(requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: ' ',
    }, memoryStore.read(proposed.id))).rejects.toThrow('rationale is required')

    await expect(readFile(requestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deduplicates pending requests by memory id and decision', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'command',
      statement: 'Run package typecheck before claiming green.',
      evidence: 'Package scripts expose a typecheck command.',
    })

    const first = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer-a',
      rationale: 'First request.',
    }, memoryStore.read(proposed.id))
    const second = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer-b',
      rationale: 'Second request should dedupe.',
    }, memoryStore.read(proposed.id))

    expect(second.id).toBe(first.id)
    expect(await jsonlRows(requestPath)).toHaveLength(1)
  })

  it('reloads pending requests with target snapshot metadata', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'fact',
      statement: 'Transcript remains the coding truth source.',
      evidence: 'Transcript store is append-only.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Verified transcript architecture.',
    }, memoryStore.read(proposed.id))

    const reloaded = await createRequestStore()
    expect(reloaded.read(request.id)).toMatchObject({
      id: request.id,
      memoryId: proposed.id,
      status: 'pending',
      targetStatus: 'proposed',
      targetStatement: 'Transcript remains the coding truth source.',
    })
  })
})
