import type {
  WorkspaceMemoryEntry,
  WorkspaceMemoryReviewRequestInput,
  WorkspaceMemoryReviewRequestRecord,
  WorkspaceMemoryReviewRequestResolutionInput,
  WorkspaceMemoryReviewRequestStaleCandidate,
  WorkspaceMemoryReviewRequestStaleReason,
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

export interface WorkspaceMemoryReviewRequestApplyResult {
  request: WorkspaceMemoryReviewRequestRecord
  entry: WorkspaceMemoryEntry
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

  async apply(
    requestId: string,
    input: WorkspaceMemoryReviewRequestResolutionInput,
    getCurrentEntry: (request: WorkspaceMemoryReviewRequestRecord) => WorkspaceMemoryEntry | undefined | Promise<WorkspaceMemoryEntry | undefined>,
    applyMemoryReview: (request: WorkspaceMemoryReviewRequestRecord) => Promise<WorkspaceMemoryEntry>,
  ): Promise<WorkspaceMemoryReviewRequestApplyResult> {
    const pending = this.appendQueue.then(
      async () => {
        await this.init()
        return this.applyCommitted(requestId, input, getCurrentEntry, applyMemoryReview)
      },
      async () => {
        await this.init()
        return this.applyCommitted(requestId, input, getCurrentEntry, applyMemoryReview)
      },
    )
    this.appendQueue = pending.catch(() => undefined)
    return pending
  }

  async reject(
    requestId: string,
    input: WorkspaceMemoryReviewRequestResolutionInput,
  ): Promise<WorkspaceMemoryReviewRequestRecord> {
    const pending = this.appendQueue.then(
      async () => {
        await this.init()
        return this.rejectCommitted(requestId, input)
      },
      async () => {
        await this.init()
        return this.rejectCommitted(requestId, input)
      },
    )
    this.appendQueue = pending.catch(() => undefined)
    return pending
  }

  list(options: { query?: string, limit?: number, status?: WorkspaceMemoryReviewRequestRecord['status'] | 'all' } = {}): WorkspaceMemoryReviewRequestRecord[] {
    this.assertInitialized()
    const normalizedQuery = normalizeText(options.query ?? '').toLowerCase()
    const limit = normalizeLimit(options.limit)
    const status = options.status ?? 'pending'

    return this.requests
      .filter(request => status === 'all' || request.status === status)
      .filter(request => !normalizedQuery || reviewRequestHaystack(request).includes(normalizedQuery))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  }

  async listStaleCandidates(
    getCurrentEntry: (request: WorkspaceMemoryReviewRequestRecord) => WorkspaceMemoryEntry | undefined | Promise<WorkspaceMemoryEntry | undefined>,
    options: { query?: string, limit?: number } = {},
  ): Promise<WorkspaceMemoryReviewRequestStaleCandidate[]> {
    this.assertInitialized()
    const normalizedQuery = normalizeText(options.query ?? '').toLowerCase()
    const limit = normalizeLimit(options.limit)
    const candidates: WorkspaceMemoryReviewRequestStaleCandidate[] = []

    const pendingRequests = this.requests
      .filter(request => request.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    for (const request of pendingRequests) {
      const currentEntry = await getCurrentEntry(request)
      const staleReason = getTargetStaleErrorCode(request, currentEntry)
      if (!staleReason)
        continue

      const candidate: WorkspaceMemoryReviewRequestStaleCandidate = {
        request,
        staleReason,
        currentEntry,
      }

      if (normalizedQuery && !staleCandidateHaystack(candidate).includes(normalizedQuery))
        continue

      candidates.push(candidate)
      if (candidates.length >= limit)
        break
    }

    return candidates
  }

  read(id: string): WorkspaceMemoryReviewRequestRecord | undefined {
    this.assertInitialized()
    return this.requests.find(request => request.id === id)
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

  private async applyCommitted(
    requestId: string,
    input: WorkspaceMemoryReviewRequestResolutionInput,
    getCurrentEntry: (request: WorkspaceMemoryReviewRequestRecord) => WorkspaceMemoryEntry | undefined | Promise<WorkspaceMemoryEntry | undefined>,
    applyMemoryReview: (request: WorkspaceMemoryReviewRequestRecord) => Promise<WorkspaceMemoryEntry>,
  ): Promise<WorkspaceMemoryReviewRequestApplyResult> {
    const approver = normalizeApprover(input.approver)
    const rationale = normalizeResolutionRationale(input.rationale)
    const request = this.requirePendingRequest(requestId)
    const currentEntry = await getCurrentEntry(request)

    const staleErrorCode = getTargetStaleErrorCode(request, currentEntry)
    if (staleErrorCode) {
      const staleRequest = await this.resolveRequest(request, {
        status: 'stale',
        resolvedBy: approver,
        resolutionRationale: rationale,
        errorCode: staleErrorCode,
      })
      throw new Error(`Workspace memory review request target is stale: ${staleRequest.id} (${staleErrorCode})`)
    }

    const entry = await applyMemoryReview(request)
    const appliedRequest = await this.resolveRequest(request, {
      status: 'applied',
      resolvedBy: approver,
      resolutionRationale: rationale,
      appliedMemoryStatus: entry.status,
    })

    return {
      request: appliedRequest,
      entry,
    }
  }

  private async rejectCommitted(
    requestId: string,
    input: WorkspaceMemoryReviewRequestResolutionInput,
  ): Promise<WorkspaceMemoryReviewRequestRecord> {
    const approver = normalizeApprover(input.approver)
    const rationale = normalizeResolutionRationale(input.rationale)
    const request = this.requirePendingRequest(requestId)

    return await this.resolveRequest(request, {
      status: 'rejected',
      resolvedBy: approver,
      resolutionRationale: rationale,
    })
  }

  private requirePendingRequest(requestId: string): WorkspaceMemoryReviewRequestRecord {
    const request = this.requests.find(candidate => candidate.id === requestId)
    if (!request)
      throw new Error(`Workspace memory review request not found: ${requestId}`)
    if (request.status !== 'pending')
      throw new Error(`Workspace memory review request is not pending: ${requestId} is ${request.status}`)
    return request
  }

  private async resolveRequest(
    request: WorkspaceMemoryReviewRequestRecord,
    resolution: Pick<WorkspaceMemoryReviewRequestRecord, 'status' | 'resolvedBy' | 'resolutionRationale'> & Pick<Partial<WorkspaceMemoryReviewRequestRecord>, 'appliedMemoryStatus' | 'errorCode'>,
  ): Promise<WorkspaceMemoryReviewRequestRecord> {
    const resolved: WorkspaceMemoryReviewRequestRecord = {
      ...request,
      status: resolution.status,
      resolvedAt: new Date().toISOString(),
      resolvedBy: resolution.resolvedBy,
      resolutionRationale: resolution.resolutionRationale,
      appliedMemoryStatus: resolution.appliedMemoryStatus,
      errorCode: resolution.errorCode,
    }

    await this.persist(resolved)
    this.requests = this.requests.map(candidate => candidate.id === request.id ? resolved : candidate)
    return resolved
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

function normalizeApprover(approver: string): string {
  const normalized = normalizeText(approver)
  if (!normalized)
    throw new Error('Workspace memory review request approver is required')
  return normalized
}

function normalizeResolutionRationale(rationale: string): string {
  const normalized = normalizeText(rationale)
  if (!normalized)
    throw new Error('Workspace memory review request resolution rationale is required')
  return normalized
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
    request.resolvedBy,
    request.resolutionRationale,
    request.appliedMemoryStatus,
    request.errorCode,
  ].filter(Boolean).join('\n').toLowerCase()
}

function getTargetStaleErrorCode(
  request: WorkspaceMemoryReviewRequestRecord,
  currentEntry: WorkspaceMemoryEntry | undefined,
): WorkspaceMemoryReviewRequestStaleReason | undefined {
  if (!currentEntry)
    return 'target_missing'
  if (currentEntry.status !== request.targetStatus)
    return 'target_status_changed'
  if (currentEntry.updatedAt !== request.targetUpdatedAt)
    return 'target_updated_at_changed'
  if (currentEntry.statement !== request.targetStatement)
    return 'target_statement_changed'
  return undefined
}

function staleCandidateHaystack(candidate: WorkspaceMemoryReviewRequestStaleCandidate): string {
  const currentEntry = candidate.currentEntry
  return [
    reviewRequestHaystack(candidate.request),
    candidate.staleReason,
    currentEntry?.id,
    currentEntry?.status,
    currentEntry?.updatedAt,
    currentEntry?.statement,
  ].filter(Boolean).join('\n').toLowerCase()
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
