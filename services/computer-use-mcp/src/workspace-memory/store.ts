import type {
  WorkspaceMemoryDraft,
  WorkspaceMemoryEntry,
  WorkspaceMemorySearchHit,
  WorkspaceMemoryStatus,
} from './types'

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const WHITESPACE_RE = /\s+/g
const SEARCH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'change',
  'fix',
  'for',
  'in',
  'of',
  'on',
  'task',
  'tasks',
  'the',
  'to',
  'update',
  'with',
])

export interface WorkspaceMemoryStoreOptions {
  workspacePath: string
  sourceRunId: string
}

export class WorkspaceMemoryStore {
  private entries: WorkspaceMemoryEntry[] = []
  private dedupKeys = new Set<string>()
  private initialized = false
  private initPromise: Promise<void> | undefined
  private appendQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly options: WorkspaceMemoryStoreOptions,
  ) {}

  async init(): Promise<void> {
    if (this.initialized)
      return

    this.initPromise ??= this.initCommitted().finally(() => {
      this.initPromise = undefined
    })

    await this.initPromise
  }

  async propose(draft: WorkspaceMemoryDraft): Promise<WorkspaceMemoryEntry> {
    const pending = this.appendQueue.then(
      async () => {
        await this.init()
        return this.proposeCommitted(draft)
      },
      async () => {
        await this.init()
        return this.proposeCommitted(draft)
      },
    )
    this.appendQueue = pending.catch(() => undefined)
    return pending
  }

  search(query: string, options: { includeProposed?: boolean, limit?: number } = {}): WorkspaceMemorySearchHit[] {
    this.assertInitialized()
    const normalizedQuery = normalizeSearch(query)
    if (!normalizedQuery)
      return []

    const limit = options.limit ?? 5
    if (limit <= 0)
      return []

    return this.entries
      .filter((entry) => {
        if (entry.status === 'active')
          return true
        return options.includeProposed === true && entry.status === 'proposed'
      })
      .filter(entry => matchesEntry(entry, normalizedQuery))
      .slice(0, limit)
      .map(toSearchHit)
  }

  read(id: string): WorkspaceMemoryEntry | undefined {
    this.assertInitialized()
    return this.entries.find(entry => entry.id === id)
  }

  async updateStatus(id: string, status: WorkspaceMemoryStatus, humanVerified: boolean): Promise<WorkspaceMemoryEntry> {
    const pending = this.appendQueue.then(
      async () => {
        await this.init()
        return this.updateStatusCommitted(id, status, humanVerified)
      },
      async () => {
        await this.init()
        return this.updateStatusCommitted(id, status, humanVerified)
      },
    )
    this.appendQueue = pending.catch(() => undefined)
    return pending
  }

  toContextString(query: string, limit = 5): string {
    const hits = this.search(query, { limit })
    if (hits.length === 0)
      return ''

    return [
      'Workspace Memory',
      ...hits.map(hit =>
        `- [${hit.kind}/${hit.confidence}${hit.humanVerified ? '/verified' : ''}] ${hit.statement}`,
      ),
    ].join('\n')
  }

  getAll(): readonly WorkspaceMemoryEntry[] {
    this.assertInitialized()
    return this.entries
  }

  private async initCommitted(): Promise<void> {
    if (this.initialized)
      return

    await mkdir(dirname(this.filePath), { recursive: true })

    try {
      const stream = createReadStream(this.filePath, { encoding: 'utf-8' })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      const byId = new Map<string, WorkspaceMemoryEntry>()

      for await (const line of lines) {
        if (line.trim().length === 0)
          continue
        try {
          const entry = JSON.parse(line) as WorkspaceMemoryEntry
          if (entry.workspaceKey !== this.workspaceKey)
            continue
          byId.set(entry.id, entry)
        }
        catch {
          // Skip malformed lines; append-only logs can contain partial writes.
        }
      }

      this.entries = Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      this.dedupKeys = new Set(this.entries.map(entry => dedupKey(entry)))
    }
    catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT')
        throw error
    }

    this.initialized = true
  }

  private async proposeCommitted(draft: WorkspaceMemoryDraft): Promise<WorkspaceMemoryEntry> {
    const normalizedDraft = normalizeDraft(draft)
    const key = dedupKey({
      ...normalizedDraft,
      workspaceKey: this.workspaceKey,
    })
    const existing = this.dedupKeys.has(key)
      ? this.entries.find(entry => dedupKey(entry) === key)
      : undefined
    if (existing)
      return existing

    const now = new Date().toISOString()
    const entry: WorkspaceMemoryEntry = {
      id: randomUUID(),
      status: 'proposed',
      kind: normalizedDraft.kind,
      statement: normalizedDraft.statement,
      evidence: normalizedDraft.evidence,
      confidence: normalizedDraft.confidence,
      tags: normalizedDraft.tags,
      relatedFiles: normalizedDraft.relatedFiles,
      workspaceKey: this.workspaceKey,
      sourceRunId: this.options.sourceRunId,
      source: 'coding_runner',
      humanVerified: false,
      createdAt: now,
      updatedAt: now,
    }

    await this.persist(entry)
    this.entries.push(entry)
    this.dedupKeys.add(key)
    return entry
  }

  private async updateStatusCommitted(
    id: string,
    status: WorkspaceMemoryStatus,
    humanVerified: boolean,
  ): Promise<WorkspaceMemoryEntry> {
    const current = this.read(id)
    if (!current)
      throw new Error(`Workspace memory entry not found: ${id}`)

    const updated: WorkspaceMemoryEntry = {
      ...current,
      status,
      humanVerified,
      updatedAt: new Date().toISOString(),
    }

    await this.persist(updated)
    this.entries = this.entries.map(entry => entry.id === id ? updated : entry)
    this.dedupKeys.add(dedupKey(updated))
    return updated
  }

  private async persist(entry: WorkspaceMemoryEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  private get workspaceKey(): string {
    return workspaceKeyFromPath(this.options.workspacePath)
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new Error('WorkspaceMemoryStore.init() must be called before reading')
  }
}

export function workspaceKeyFromPath(workspacePath: string): string {
  return createHash('sha256').update(resolve(workspacePath)).digest('hex').slice(0, 16)
}

function normalizeDraft(draft: WorkspaceMemoryDraft): Required<WorkspaceMemoryDraft> {
  const normalized = {
    kind: draft.kind,
    statement: normalizeText(draft.statement),
    evidence: normalizeText(draft.evidence),
    confidence: draft.confidence ?? 'low',
    tags: normalizeStringArray(draft.tags),
    relatedFiles: normalizeStringArray(draft.relatedFiles),
  }

  if (!normalized.statement)
    throw new Error('Workspace memory statement is required')
  if (!normalized.evidence)
    throw new Error('Workspace memory evidence is required')

  return normalized
}

function normalizeText(text: string): string {
  return text.replace(WHITESPACE_RE, ' ').trim()
}

function normalizeStringArray(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map(normalizeText).filter(Boolean))).slice(0, 12)
}

function normalizeSearch(query: string): string {
  return normalizeText(query).toLowerCase()
}

function matchesEntry(entry: WorkspaceMemoryEntry, normalizedQuery: string): boolean {
  const haystack = [
    entry.kind,
    entry.statement,
    entry.evidence,
    ...entry.tags,
    ...entry.relatedFiles,
  ].join('\n').toLowerCase()

  if (haystack.includes(normalizedQuery))
    return true

  const rawTokens = normalizedQuery.split(' ').filter(Boolean)
  const tokens = rawTokens.filter(token => token.length > 1 && !SEARCH_STOPWORDS.has(token))
  if (tokens.length < Math.min(2, rawTokens.length))
    return false

  return tokens.every(token => haystack.includes(token))
}

function toSearchHit(entry: WorkspaceMemoryEntry): WorkspaceMemorySearchHit {
  return {
    id: entry.id,
    status: entry.status,
    kind: entry.kind,
    statement: entry.statement,
    evidenceExcerpt: entry.evidence.slice(0, 500),
    confidence: entry.confidence,
    tags: entry.tags,
    relatedFiles: entry.relatedFiles,
    humanVerified: entry.humanVerified,
  }
}

function dedupKey(entry: Pick<WorkspaceMemoryEntry, 'workspaceKey' | 'kind' | 'statement' | 'relatedFiles'>): string {
  return [
    entry.workspaceKey,
    entry.kind,
    entry.statement.toLowerCase(),
    [...entry.relatedFiles].sort().join(','),
  ].join('::')
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
