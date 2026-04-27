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

  it('filters requests by normalized workspace key when stores share a JSONL file', async () => {
    const workspaceA = join(tmpRoot, 'repo-a')
    const workspaceB = join(tmpRoot, 'repo-b')
    const sharedRequestPath = join(tmpRoot, 'workspace-memory-review-requests', 'shared.jsonl')
    const memoryStoreA = new WorkspaceMemoryStore(join(tmpRoot, 'workspace-memory', 'repo-a.jsonl'), {
      workspacePath: workspaceA,
      sourceRunId: 'run-a',
    })
    const memoryStoreB = new WorkspaceMemoryStore(join(tmpRoot, 'workspace-memory', 'repo-b.jsonl'), {
      workspacePath: workspaceB,
      sourceRunId: 'run-b',
    })
    const requestStoreA = new WorkspaceMemoryReviewRequestStore(sharedRequestPath, { workspacePath: workspaceA })
    const requestStoreB = new WorkspaceMemoryReviewRequestStore(sharedRequestPath, { workspacePath: workspaceB })
    await memoryStoreA.init()
    await memoryStoreB.init()
    await requestStoreA.init()
    await requestStoreB.init()

    const proposedA = await memoryStoreA.propose({
      kind: 'fact',
      statement: 'Repo A memory request stays scoped to repo A.',
      evidence: 'Repo A evidence.',
    })
    const proposedB = await memoryStoreB.propose({
      kind: 'fact',
      statement: 'Repo B memory request stays scoped to repo B.',
      evidence: 'Repo B evidence.',
    })
    const requestA = await requestStoreA.request({
      memoryId: proposedA.id,
      decision: 'activate',
      requester: 'maintainer-a',
      rationale: 'Review repo A memory.',
    }, memoryStoreA.read(proposedA.id))
    const requestB = await requestStoreB.request({
      memoryId: proposedB.id,
      decision: 'reject',
      requester: 'maintainer-b',
      rationale: 'Review repo B memory.',
    }, memoryStoreB.read(proposedB.id))

    const reloadedA = new WorkspaceMemoryReviewRequestStore(sharedRequestPath, {
      workspacePath: `${workspaceA}/../repo-a`,
    })
    const reloadedB = new WorkspaceMemoryReviewRequestStore(sharedRequestPath, { workspacePath: workspaceB })
    await reloadedA.init()
    await reloadedB.init()

    expect(workspaceKeyFromPath(`${workspaceA}/../repo-a`)).toBe(workspaceKeyFromPath(workspaceA))
    expect(await jsonlRows(sharedRequestPath)).toHaveLength(2)
    expect(reloadedA.list()).toEqual([expect.objectContaining({
      id: requestA.id,
      memoryId: proposedA.id,
      workspaceKey: workspaceKeyFromPath(workspaceA),
    })])
    expect(reloadedA.read(requestB.id)).toBeUndefined()
    expect(reloadedB.list()).toEqual([expect.objectContaining({
      id: requestB.id,
      memoryId: proposedB.id,
      workspaceKey: workspaceKeyFromPath(workspaceB),
    })])
    expect(reloadedB.read(requestA.id)).toBeUndefined()
  })

  it('applies pending activate requests and marks them applied', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'constraint',
      statement: 'Active memory must be explicitly reviewed.',
      evidence: 'Workspace memory review requests are governed.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Promote durable constraint.',
    }, memoryStore.read(proposed.id))

    const result = await requestStore.apply(request.id, {
      approver: 'host',
      rationale: 'Authorized apply.',
    }, pendingRequest => memoryStore.read(pendingRequest.memoryId), async (pendingRequest) => {
      return await memoryStore.review({
        id: pendingRequest.memoryId,
        decision: pendingRequest.decision,
        reviewer: 'host',
        rationale: 'Authorized apply.',
      })
    })

    expect(result.entry.status).toBe('active')
    expect(result.request).toMatchObject({
      id: request.id,
      status: 'applied',
      resolvedBy: 'host',
      resolutionRationale: 'Authorized apply.',
      appliedMemoryStatus: 'active',
    })
    expect(result.request.resolvedAt).toBeTruthy()
    expect(memoryStore.read(proposed.id)?.status).toBe('active')
    expect(await jsonlRows(memoryPath)).toHaveLength(2)
    expect(await jsonlRows(requestPath)).toHaveLength(2)
  })

  it('applies pending reject requests and marks them applied', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'fact',
      statement: 'Weak observation should be rejected.',
      evidence: 'Only observed once.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'reject',
      requester: 'maintainer',
      rationale: 'Reject weak memory.',
    }, memoryStore.read(proposed.id))

    const result = await requestStore.apply(request.id, {
      approver: 'host',
      rationale: 'Authorized rejection apply.',
    }, pendingRequest => memoryStore.read(pendingRequest.memoryId), async (pendingRequest) => {
      return await memoryStore.review({
        id: pendingRequest.memoryId,
        decision: pendingRequest.decision,
        reviewer: 'host',
        rationale: 'Authorized rejection apply.',
      })
    })

    expect(result.entry.status).toBe('rejected')
    expect(result.entry.humanVerified).toBe(false)
    expect(result.request.status).toBe('applied')
    expect(result.request.appliedMemoryStatus).toBe('rejected')
    expect(memoryStore.read(proposed.id)?.status).toBe('rejected')
  })

  it('rejects pending requests without changing memory status', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'pitfall',
      statement: 'Request rejection should not reject memory.',
      evidence: 'Rejecting a request is not the same as applying reject decision.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'reject',
      requester: 'maintainer',
      rationale: 'Maybe reject this memory later.',
    }, memoryStore.read(proposed.id))

    const rejected = await requestStore.reject(request.id, {
      approver: 'host',
      rationale: 'Do not apply this governance request.',
    })

    expect(rejected).toMatchObject({
      id: request.id,
      status: 'rejected',
      resolvedBy: 'host',
      resolutionRationale: 'Do not apply this governance request.',
    })
    expect(memoryStore.read(proposed.id)?.status).toBe('proposed')
    expect(await jsonlRows(memoryPath)).toHaveLength(1)
    expect(await jsonlRows(requestPath)).toHaveLength(2)
  })

  it('marks stale target requests without mutating memory', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'command',
      statement: 'Old command snapshot should not be blindly applied.',
      evidence: 'Request stores target snapshot metadata.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Activate if still current.',
    }, memoryStore.read(proposed.id))
    await memoryStore.review({
      id: proposed.id,
      decision: 'reject',
      reviewer: 'maintainer',
      rationale: 'Changed after request.',
    })
    const rowsBefore = await jsonlRows(memoryPath)

    await expect(requestStore.apply(request.id, {
      approver: 'host',
      rationale: 'Attempt stale apply.',
    }, pendingRequest => memoryStore.read(pendingRequest.memoryId), async () => {
      throw new Error('must not review stale target')
    })).rejects.toThrow('target is stale')

    expect(memoryStore.read(proposed.id)?.status).toBe('rejected')
    expect(await jsonlRows(memoryPath)).toHaveLength(rowsBefore.length)
    expect(requestStore.read(request.id)).toMatchObject({
      status: 'stale',
      resolvedBy: 'host',
      errorCode: 'target_status_changed',
    })
    expect(await jsonlRows(requestPath)).toHaveLength(2)
  })

  it('marks missing target requests stale without mutating memory', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'fact',
      statement: 'Missing target is stale.',
      evidence: 'Apply requires the original memory entry.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Activate if target exists.',
    }, memoryStore.read(proposed.id))
    const rowsBefore = await jsonlRows(memoryPath)

    await expect(requestStore.apply(request.id, {
      approver: 'host',
      rationale: 'Attempt missing target apply.',
    }, () => undefined, async () => {
      throw new Error('must not review missing target')
    })).rejects.toThrow('target is stale')

    expect(await jsonlRows(memoryPath)).toHaveLength(rowsBefore.length)
    expect(requestStore.read(request.id)).toMatchObject({
      status: 'stale',
      errorCode: 'target_missing',
    })
  })

  it('rejects duplicate resolutions without appending JSONL rows', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'constraint',
      statement: 'Resolved requests should be immutable.',
      evidence: 'Review requests are append-only state transitions.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Activate once.',
    }, memoryStore.read(proposed.id))
    await requestStore.reject(request.id, {
      approver: 'host',
      rationale: 'Reject once.',
    })
    const memoryRowsBefore = await jsonlRows(memoryPath)
    const requestRowsBefore = await jsonlRows(requestPath)

    await expect(requestStore.reject(request.id, {
      approver: 'host',
      rationale: 'Reject again.',
    })).rejects.toThrow('is not pending')
    await expect(requestStore.apply(request.id, {
      approver: 'host',
      rationale: 'Apply after reject.',
    }, pendingRequest => memoryStore.read(pendingRequest.memoryId), async () => {
      throw new Error('must not review non-pending request')
    })).rejects.toThrow('is not pending')

    expect(await jsonlRows(memoryPath)).toHaveLength(memoryRowsBefore.length)
    expect(await jsonlRows(requestPath)).toHaveLength(requestRowsBefore.length)
  })

  it('rejects empty resolution metadata without appending JSONL rows', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'fact',
      statement: 'Resolution metadata is required.',
      evidence: 'Authorized apply needs attribution.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Activate with metadata.',
    }, memoryStore.read(proposed.id))
    const requestRowsBefore = await jsonlRows(requestPath)

    await expect(requestStore.apply(request.id, {
      approver: ' ',
      rationale: 'Valid rationale.',
    }, pendingRequest => memoryStore.read(pendingRequest.memoryId), async () => {
      throw new Error('must not review empty approver')
    })).rejects.toThrow('approver is required')
    await expect(requestStore.reject(request.id, {
      approver: 'host',
      rationale: ' ',
    })).rejects.toThrow('resolution rationale is required')

    expect(await jsonlRows(requestPath)).toHaveLength(requestRowsBefore.length)
    expect(memoryStore.read(proposed.id)?.status).toBe('proposed')
  })

  it('reloads resolved request metadata', async () => {
    const memoryStore = await createMemoryStore()
    const requestStore = await createRequestStore()
    const proposed = await memoryStore.propose({
      kind: 'fact',
      statement: 'Resolved metadata survives reload.',
      evidence: 'Request store replays append-only rows by id.',
    })
    const request = await requestStore.request({
      memoryId: proposed.id,
      decision: 'activate',
      requester: 'maintainer',
      rationale: 'Activate after reload.',
    }, memoryStore.read(proposed.id))
    await requestStore.apply(request.id, {
      approver: 'host',
      rationale: 'Authorized apply.',
    }, pendingRequest => memoryStore.read(pendingRequest.memoryId), async (pendingRequest) => {
      return await memoryStore.review({
        id: pendingRequest.memoryId,
        decision: pendingRequest.decision,
        reviewer: 'host',
        rationale: 'Authorized apply.',
      })
    })

    const reloaded = await createRequestStore()
    expect(reloaded.read(request.id)).toMatchObject({
      id: request.id,
      status: 'applied',
      resolvedBy: 'host',
      resolutionRationale: 'Authorized apply.',
      appliedMemoryStatus: 'active',
    })
    expect(reloaded.list({ status: 'applied' })).toHaveLength(1)
    expect(reloaded.list()).toHaveLength(0)
  })
})
