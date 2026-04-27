import type {
  WorkspaceMemoryEntry,
  WorkspaceMemoryReviewRequestInput,
  WorkspaceMemoryReviewRequestRecord,
} from './types'

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

import { workspaceKeyFromPath } from './store'

const WHITESPACE_RE = /\s+/g

export interface WorkspaceMemoryReviewRequestStoreOptions {
  workspacePath: string
}

export class WorkspaceMemoryReviewRequestStore {
  private requests: WorkspaceMemoryReviewRequestRecord[] = []
  private initialized = false
  private initPromise: Promise<void> | undefined
  private appendQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly options: WorkspaceMemoryReviewRequestStoreOptions,
  ) {}

  async init(): Promise<void> {
    if (this.initialized)
      return

    this.initPromise ??= this.initCommitted().finally(() => {
      this.initPromise = undefined
    })

    await this.initPromise
  }

  async request(
    input: WorkspaceMemoryReviewRequestInput,
    targetEntry: WorkspaceMemoryEntry | undefined,
  ): Promise<WorkspaceMemoryReviewRequestRecord> {
    const pending = this.appendQueue.then(
      async () => {
        await this.init()
        return this.requestCommitted(input, targetEntry)
      },
      async () => {
        await this.init()
        return this.requestCommitted(input, targetEntry)
      },
    )
    this.appendQueue = pending.catch(() => undefined)
    return pending
  }

  list(options: { query?: string, limit?: number } = {}): WorkspaceMemoryReviewRequestRecord[] {
    this.assertInitialized()
    const normalizedQuery = normalizeText(options.query ?? '').toLowerCase()
    const limit = normalizeLimit(options.limit)

    return this.requests
      .filter(request => request.status === 'pending')
      .filter(request => !normalizedQuery || reviewRequestHaystack(request).includes(normalizedQuery))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  }

  read(id: string): WorkspaceMemoryReviewRequestRecord | undefined {
    this.assertInitialized()
    return this.requests.find(request => request.id === id && request.status === 'pending')
  }

  getAll(): readonly WorkspaceMemoryReviewRequestRecord[] {
    this.assertInitialized()
    return this.requests
  }

  private async initCommitted(): Promise<void> {
    if (this.initialized)
      return

    await mkdir(dirname(this.filePath), { recursive: true })

    try {
      const stream = createReadStream(this.filePath, { encoding: 'utf-8' })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      const byId = new Map<string, WorkspaceMemoryReviewRequestRecord>()

      for await (const line of lines) {
        if (line.trim().length === 0)
          continue
        try {
          const request = JSON.parse(line) as WorkspaceMemoryReviewRequestRecord
          if (request.workspaceKey !== this.workspaceKey)
            continue
          byId.set(request.id, request)
        }
        catch {
          // Skip malformed lines; append-only logs can contain partial writes.
        }
      }

      this.requests = Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
    catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT')
        throw error
    }

    this.initialized = true
  }

  private async requestCommitted(
    input: WorkspaceMemoryReviewRequestInput,
    targetEntry: WorkspaceMemoryEntry | undefined,
  ): Promise<WorkspaceMemoryReviewRequestRecord> {
    const requester = normalizeText(input.requester)
    if (!requester)
      throw new Error('Workspace memory review request requester is required')

    const rationale = normalizeText(input.rationale)
    if (!rationale)
      throw new Error('Workspace memory review request rationale is required')

    if (!targetEntry)
      throw new Error(`Workspace memory entry not found: ${input.memoryId}`)

    const requestedStatus = statusForReviewDecision(input.decision)
    if (targetEntry.status === requestedStatus) {
      throw new Error(`Workspace memory review request is a no-op: ${input.memoryId} is already ${requestedStatus}`)
    }

    const existing = this.requests.find(request =>
      request.status === 'pending'
      && request.memoryId === input.memoryId
      && request.decision === input.decision,
    )
    if (existing)
      return existing

    const request: WorkspaceMemoryReviewRequestRecord = {
      id: randomUUID(),
      workspaceKey: this.workspaceKey,
      memoryId: targetEntry.id,
      decision: input.decision,
      requester,
      rationale,
      status: 'pending',
      targetStatus: targetEntry.status,
      targetUpdatedAt: targetEntry.updatedAt,
      targetStatement: targetEntry.statement,
      createdAt: new Date().toISOString(),
    }

    await this.persist(request)
    this.requests.push(request)
    return request
  }

  private async persist(request: WorkspaceMemoryReviewRequestRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, `${JSON.stringify(request)}\n`, 'utf8')
  }

  private get workspaceKey(): string {
    return workspaceKeyFromPath(this.options.workspacePath)
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new Error('WorkspaceMemoryReviewRequestStore.init() must be called before reading')
  }
}

function statusForReviewDecision(decision: WorkspaceMemoryReviewRequestInput['decision']) {
  if (decision === 'activate')
    return 'active'
  if (decision === 'reject')
    return 'rejected'
  throw new Error(`Workspace memory review request decision is invalid: ${decision}`)
}

function normalizeText(text: string): string {
  return text.replace(WHITESPACE_RE, ' ').trim()
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined)
    return 20
  if (!Number.isFinite(limit))
    return 20
  return Math.min(50, Math.max(1, Math.floor(limit)))
}

function reviewRequestHaystack(request: WorkspaceMemoryReviewRequestRecord): string {
  return [
    request.id,
    request.workspaceKey,
    request.memoryId,
    request.decision,
    request.requester,
    request.rationale,
    request.status,
    request.targetStatus,
    request.targetUpdatedAt,
    request.targetStatement,
  ].join('\n').toLowerCase()
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
