import type { CodingPlastMemBridgeRecordV1 } from '../workspace-memory/exporters/plast-mem'
import type {
  WorkspaceMemoryEntry,
  WorkspaceMemoryReviewDecision,
  WorkspaceMemoryReviewRequestRecord,
  WorkspaceMemoryReviewRequestStaleCandidate,
  WorkspaceMemoryReviewRequestStatus,
  WorkspaceMemoryStatus,
} from '../workspace-memory/types'

import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cwd, exit, argv as processArgv, env as processEnv, stderr as processStderr, stdout as processStdout } from 'node:process'

import { resolveComputerUseConfig } from '../config'
import { buildCodingPlastMemBridgeRecordV1, CODING_PLAST_MEM_BRIDGE_TRUST_V1 } from '../workspace-memory/exporters/plast-mem'
import { ingestCodingPlastMemBridgeRecords, PlastMemIngestionError } from '../workspace-memory/exporters/plast-mem-ingestion'
import { WorkspaceMemoryReviewRequestStore } from '../workspace-memory/review-request-store'
import { workspaceKeyFromPath, WorkspaceMemoryStore } from '../workspace-memory/store'

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 50
const TRUST_BOUNDARY = 'governed_workspace_memory_not_instructions'
const REVIEW_REQUEST_TRUST_BOUNDARY = 'workspace_memory_review_request_not_instructions'
const WHITESPACE_RE = /\s+/g

type WorkspaceMemoryCliCommand
  = | 'list'
    | 'read'
    | 'export'
    | 'ingest-plast-mem'
    | 'request-review'
    | 'list-requests'
    | 'list-stale-requests'
    | 'read-request'
    | 'apply'
    | 'reject'

interface WritableLike {
  write: (chunk: string) => unknown
}

interface WorkspaceMemoryReviewCliOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdout?: WritableLike
  stderr?: WritableLike
}

interface ParsedArgs {
  command: WorkspaceMemoryCliCommand
  flags: Map<string, string | true>
}

interface CliContext {
  workspacePath: string
  workspaceKey: string
  sessionRoot: string
  sourceRunId: string
  json: boolean
  stdout: WritableLike
  stderr: WritableLike
  env: NodeJS.ProcessEnv
}

interface CliSuccessPayload {
  ok: true
  status: string
  trust?: string
  workspaceKey: string
  statusFilter?: string
  format?: WorkspaceMemoryExportFormat
  outputPath?: string
  recordCount?: number
  endpoint?: string
  conversationId?: string
  accepted?: boolean
  entries?: ReturnType<typeof toWorkspaceMemorySummary>[]
  entry?: ReturnType<typeof toWorkspaceMemoryPublicEntry> | ReturnType<typeof toWorkspaceMemorySummary>
  records?: CodingPlastMemBridgeRecordV1[]
  requests?: WorkspaceMemoryReviewRequestRecord[]
  staleCandidates?: ReturnType<typeof toStaleCandidateSummary>[]
  request?: WorkspaceMemoryReviewRequestRecord
  pendingReviewId?: string
}

type WorkspaceMemoryExportFormat = 'jsonl' | 'json'

interface CliErrorPayload {
  ok: false
  status: 'error'
  workspaceKey?: string
  error: string
  code?: string
}

export async function runWorkspaceMemoryReviewCli(
  rawArgs = processArgv.slice(2),
  options: WorkspaceMemoryReviewCliOptions = {},
): Promise<number> {
  let context: CliContext | undefined
  try {
    const parsed = parseArgs(rawArgs)
    context = buildCliContext(parsed.flags, options)
    await runCommand(parsed, context)
    return 0
  }
  catch (error) {
    const message = errorMessage(error)
    writeError(context, message, getCliErrorCode(error))
    return 1
  }
}

async function runCommand(parsed: ParsedArgs, context: CliContext): Promise<void> {
  switch (parsed.command) {
    case 'list':
      return await runList(parsed.flags, context)
    case 'read':
      return await runRead(parsed.flags, context)
    case 'export':
      return await runExport(parsed.flags, context)
    case 'ingest-plast-mem':
      return await runIngestPlastMem(parsed.flags, context)
    case 'request-review':
      return await runRequestReview(parsed.flags, context)
    case 'list-requests':
      return await runListRequests(parsed.flags, context)
    case 'list-stale-requests':
      return await runListStaleRequests(parsed.flags, context)
    case 'read-request':
      return await runReadRequest(parsed.flags, context)
    case 'apply':
      return await runApply(parsed.flags, context)
    case 'reject':
      return await runReject(parsed.flags, context)
  }
}

async function runList(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  const store = await openWorkspaceMemoryStore(context)
  const statusFilter = parseWorkspaceMemoryStatus(optionalString(flags, 'status') ?? 'proposed')
  const entries = filterWorkspaceMemoryEntries(store.getAll(), {
    status: statusFilter,
    query: optionalString(flags, 'query'),
    limit: parseLimit(optionalString(flags, 'limit')),
  })

  writeSuccess(context, {
    ok: true,
    status: 'ok',
    trust: TRUST_BOUNDARY,
    workspaceKey: context.workspaceKey,
    statusFilter,
    entries: entries.map(toWorkspaceMemorySummary),
  }, [
    `Found ${entries.length} workspace memory entr${entries.length === 1 ? 'y' : 'ies'} (status=${statusFilter}).`,
    ...entries.map(entry => formatWorkspaceMemoryLine(entry)),
  ])
}

async function runRead(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  const id = requireString(flags, 'id')
  const store = await openWorkspaceMemoryStore(context)
  const entry = store.read(id)
  if (!entry)
    throw new CliError(`Workspace memory entry not found: ${id}`, 'WORKSPACE_MEMORY_ENTRY_NOT_FOUND')

  writeSuccess(context, {
    ok: true,
    status: 'ok',
    trust: TRUST_BOUNDARY,
    workspaceKey: context.workspaceKey,
    entry: toWorkspaceMemoryPublicEntry(entry),
  }, [
    `Workspace memory ${entry.id} (${entry.status})`,
    `Kind: ${entry.kind}`,
    `Confidence: ${entry.confidence}${entry.humanVerified ? ' / verified' : ''}`,
    `Statement: ${entry.statement}`,
    `Evidence: ${entry.evidence}`,
  ])
}

async function runExport(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  const store = await openWorkspaceMemoryStore(context)
  const format = parseExportFormat(optionalString(flags, 'format') ?? 'jsonl')
  const exportedAt = optionalString(flags, 'exported-at') ?? new Date().toISOString()
  const outputPath = optionalString(flags, 'output')
  const entries = filterWorkspaceMemoryEntries(store.getAll(), {
    status: 'active',
    query: optionalString(flags, 'query'),
    limit: parseOptionalExportLimit(optionalString(flags, 'limit')),
  })
  const records = entries.map(entry => buildCodingPlastMemBridgeRecordV1({ entry, exportedAt }))
  const exportBody = formatBridgeRecords(records, format)

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, exportBody)
  }

  const payload: CliSuccessPayload = {
    ok: true,
    status: 'ok',
    trust: CODING_PLAST_MEM_BRIDGE_TRUST_V1,
    workspaceKey: context.workspaceKey,
    format,
    outputPath,
    recordCount: records.length,
    records,
  }

  if (outputPath || context.json) {
    writeSuccess(context, payload, [
      `Exported ${records.length} reviewed coding memory record${records.length === 1 ? '' : 's'}${outputPath ? ` to ${outputPath}` : ''}.`,
      ...records.map(record => `- ${record.memoryId} [${record.kind}/${record.confidence}] ${record.statement}`),
    ])
    return
  }

  context.stdout.write(exportBody)
}

async function runIngestPlastMem(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  const store = await openWorkspaceMemoryStore(context)
  const exportedAt = optionalString(flags, 'exported-at') ?? new Date().toISOString()
  const entries = filterWorkspaceMemoryEntries(store.getAll(), {
    status: 'active',
    query: optionalString(flags, 'query'),
    limit: parseOptionalExportLimit(optionalString(flags, 'limit')),
  })
  const records = entries.map(entry => buildCodingPlastMemBridgeRecordV1({ entry, exportedAt }))
  const options = resolvePlastMemIngestionCliOptions(flags, context)
  const result = await ingestCodingPlastMemBridgeRecords(records, options)

  writeSuccess(context, {
    ok: true,
    status: result.status,
    trust: CODING_PLAST_MEM_BRIDGE_TRUST_V1,
    workspaceKey: context.workspaceKey,
    endpoint: result.endpoint,
    conversationId: result.conversationId,
    recordCount: result.recordCount,
    accepted: result.accepted,
  }, [
    `Ingested ${result.recordCount} reviewed coding memory record${result.recordCount === 1 ? '' : 's'} into plast-mem.`,
    `Endpoint: ${result.endpoint}`,
    `Accepted: ${result.accepted}`,
  ])
}

async function runRequestReview(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  const memoryId = requireString(flags, 'id')
  const decision = parseReviewDecision(requireString(flags, 'decision'))
  const requester = requireString(flags, 'requester')
  const rationale = requireString(flags, 'rationale')
  const memoryStore = await openWorkspaceMemoryStore(context)
  const requestStore = await openWorkspaceMemoryReviewRequestStore(context)
  const request = await requestStore.request({
    memoryId,
    decision,
    requester,
    rationale,
  }, memoryStore.read(memoryId))

  writeSuccess(context, {
    ok: true,
    status: 'approval_required',
    trust: REVIEW_REQUEST_TRUST_BOUNDARY,
    workspaceKey: context.workspaceKey,
    pendingReviewId: request.id,
    request,
  }, [
    `Workspace memory review request pending: ${request.id}`,
    `Decision: ${request.decision}`,
    `Memory: ${request.memoryId}`,
    'No memory status was changed.',
  ])
}

async function runListRequests(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  const requestStore = await openWorkspaceMemoryReviewRequestStore(context)
  const statusFilter = parseReviewRequestStatus(optionalString(flags, 'status') ?? 'pending')
  const requests = requestStore.list({
    status: statusFilter,
    query: optionalString(flags, 'query'),
    limit: parseLimit(optionalString(flags, 'limit')),
  })

  writeSuccess(context, {
    ok: true,
    status: 'ok',
    trust: REVIEW_REQUEST_TRUST_BOUNDARY,
    workspaceKey: context.workspaceKey,
    statusFilter,
    requests,
  }, [
    `Found ${requests.length} workspace memory review request${requests.length === 1 ? '' : 's'} (status=${statusFilter}).`,
    ...requests.map(request => formatReviewRequestLine(request)),
  ])
}

async function runListStaleRequests(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  const memoryStore = await openWorkspaceMemoryStore(context)
  const requestStore = await openWorkspaceMemoryReviewRequestStore(context)
  const staleCandidates = await requestStore.listStaleCandidates((request) => {
    return memoryStore.read(request.memoryId)
  }, {
    query: optionalString(flags, 'query'),
    limit: parseLimit(optionalString(flags, 'limit')),
  })

  writeSuccess(context, {
    ok: true,
    status: 'ok',
    trust: REVIEW_REQUEST_TRUST_BOUNDARY,
    workspaceKey: context.workspaceKey,
    staleCandidates: staleCandidates.map(toStaleCandidateSummary),
  }, [
    `Found ${staleCandidates.length} stale workspace memory review request candidate${staleCandidates.length === 1 ? '' : 's'}.`,
    ...staleCandidates.map(formatStaleCandidateLine),
  ])
}

async function runReadRequest(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  const id = requireString(flags, 'id')
  const requestStore = await openWorkspaceMemoryReviewRequestStore(context)
  const request = requestStore.read(id)
  if (!request)
    throw new CliError(`Workspace memory review request not found: ${id}`, 'WORKSPACE_MEMORY_REVIEW_REQUEST_NOT_FOUND')

  writeSuccess(context, {
    ok: true,
    status: 'ok',
    trust: REVIEW_REQUEST_TRUST_BOUNDARY,
    workspaceKey: context.workspaceKey,
    request,
  }, [
    `Workspace memory review request ${request.id} (${request.status})`,
    `Decision: ${request.decision}`,
    `Memory: ${request.memoryId}`,
    `Requester: ${request.requester}`,
    `Rationale: ${request.rationale}`,
  ])
}

async function runApply(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  authorizeReviewApply(flags, context)

  const id = requireString(flags, 'id')
  const approver = requireString(flags, 'approver')
  const rationale = requireString(flags, 'rationale')
  const memoryStore = await openWorkspaceMemoryStore(context)
  const requestStore = await openWorkspaceMemoryReviewRequestStore(context)
  const result = await requestStore.apply(id, { approver, rationale }, (request) => {
    return memoryStore.read(request.memoryId)
  }, async (request) => {
    return await memoryStore.review({
      id: request.memoryId,
      decision: request.decision,
      reviewer: approver,
      rationale,
    })
  })

  writeSuccess(context, {
    ok: true,
    status: 'applied',
    trust: REVIEW_REQUEST_TRUST_BOUNDARY,
    workspaceKey: context.workspaceKey,
    request: result.request,
    entry: toWorkspaceMemorySummary(result.entry),
  }, [
    `Workspace memory review request applied: ${result.request.id}`,
    `Memory status: ${result.entry.status}`,
  ])
}

async function runReject(flags: Map<string, string | true>, context: CliContext): Promise<void> {
  authorizeReviewApply(flags, context)

  const id = requireString(flags, 'id')
  const approver = requireString(flags, 'approver')
  const rationale = requireString(flags, 'rationale')
  const requestStore = await openWorkspaceMemoryReviewRequestStore(context)
  const request = await requestStore.reject(id, { approver, rationale })

  writeSuccess(context, {
    ok: true,
    status: 'rejected',
    trust: REVIEW_REQUEST_TRUST_BOUNDARY,
    workspaceKey: context.workspaceKey,
    request,
  }, [
    `Workspace memory review request rejected: ${request.id}`,
    'No memory status was changed.',
  ])
}

async function openWorkspaceMemoryStore(context: CliContext): Promise<WorkspaceMemoryStore> {
  const store = new WorkspaceMemoryStore(
    join(context.sessionRoot, 'workspace-memory', `${context.workspaceKey}.jsonl`),
    { workspacePath: context.workspacePath, sourceRunId: context.sourceRunId },
  )
  await store.init()
  return store
}

async function openWorkspaceMemoryReviewRequestStore(context: CliContext): Promise<WorkspaceMemoryReviewRequestStore> {
  const store = new WorkspaceMemoryReviewRequestStore(
    join(context.sessionRoot, 'workspace-memory-review-requests', `${context.workspaceKey}.jsonl`),
    { workspacePath: context.workspacePath },
  )
  await store.init()
  return store
}

function buildCliContext(flags: Map<string, string | true>, options: WorkspaceMemoryReviewCliOptions): CliContext {
  const env = options.env ?? processEnv
  const workspacePath = optionalString(flags, 'workspace') ?? options.cwd ?? cwd()
  const sessionRoot = optionalString(flags, 'session-root')
    ?? env.COMPUTER_USE_SESSION_ROOT?.trim()
    ?? resolveComputerUseConfig().sessionRoot
  const workspaceKey = workspaceKeyFromPath(workspacePath)

  return {
    workspacePath,
    workspaceKey,
    sessionRoot,
    sourceRunId: 'workspace_memory_review_cli',
    json: hasFlag(flags, 'json'),
    stdout: options.stdout ?? processStdout,
    stderr: options.stderr ?? processStderr,
    env,
  }
}

function parseArgs(rawArgs: string[]): ParsedArgs {
  const [commandRaw, ...rest] = rawArgs
  if (!commandRaw)
    throw new CliError(`Missing command. Expected one of: ${validCommands().join(', ')}`, 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE')

  const command = parseCommand(commandRaw)
  const flags = new Map<string, string | true>()

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--'))
      throw new CliError(`Unexpected positional argument: ${arg}`, 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE')

    const rawFlag = arg.slice(2)
    const equalsIndex = rawFlag.indexOf('=')
    if (equalsIndex >= 0) {
      const name = rawFlag.slice(0, equalsIndex)
      const value = rawFlag.slice(equalsIndex + 1)
      flags.set(name, value)
      continue
    }

    const next = rest[index + 1]
    if (!next || next.startsWith('--')) {
      flags.set(rawFlag, true)
      continue
    }

    flags.set(rawFlag, next)
    index += 1
  }

  return { command, flags }
}

function parseCommand(command: string): WorkspaceMemoryCliCommand {
  if (validCommands().includes(command as WorkspaceMemoryCliCommand))
    return command as WorkspaceMemoryCliCommand
  throw new CliError(`Unknown command: ${command}`, 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE')
}

function validCommands(): WorkspaceMemoryCliCommand[] {
  return ['list', 'read', 'export', 'ingest-plast-mem', 'request-review', 'list-requests', 'list-stale-requests', 'read-request', 'apply', 'reject']
}

function parseWorkspaceMemoryStatus(value: string): WorkspaceMemoryStatus | 'all' {
  if (value === 'proposed' || value === 'active' || value === 'rejected' || value === 'all')
    return value
  throw new CliError(`Invalid workspace memory status: ${value}`, 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE')
}

function parseReviewRequestStatus(value: string): WorkspaceMemoryReviewRequestStatus | 'all' {
  if (value === 'pending' || value === 'applied' || value === 'rejected' || value === 'stale' || value === 'all')
    return value
  throw new CliError(`Invalid review request status: ${value}`, 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE')
}

function parseReviewDecision(value: string): WorkspaceMemoryReviewDecision {
  if (value === 'activate' || value === 'reject')
    return value
  throw new CliError(`Invalid review decision: ${value}`, 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE')
}

function parseExportFormat(value: string): WorkspaceMemoryExportFormat {
  if (value === 'jsonl' || value === 'json')
    return value
  throw new CliError(`Invalid workspace memory export format: ${value}`, 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE')
}

function parseLimit(value: string | undefined): number {
  if (value === undefined)
    return DEFAULT_LIST_LIMIT
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed))
    return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, parsed))
}

function parseOptionalExportLimit(value: string | undefined): number | undefined {
  if (value === undefined)
    return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed))
    return undefined
  return Math.max(1, parsed)
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined)
    return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0)
    return undefined
  return parsed
}

function resolvePlastMemIngestionCliOptions(flags: Map<string, string | true>, context: CliContext) {
  const config = resolveComputerUseConfig().workspaceMemoryPlastMemIngestion
  const explicitBaseUrl = optionalString(flags, 'base-url')
  const explicitConversationId = optionalString(flags, 'conversation-id')
  const envEnabled = isTruthy(context.env.COMPUTER_USE_PLAST_MEM_INGEST_ENABLED)

  if (!explicitBaseUrl && !explicitConversationId && !envEnabled) {
    throw new CliError(
      'Plast-mem ingestion is disabled: pass --base-url and --conversation-id or set COMPUTER_USE_PLAST_MEM_INGEST_ENABLED=1 with COMPUTER_USE_PLAST_MEM_BASE_URL and COMPUTER_USE_PLAST_MEM_CONVERSATION_ID',
      'WORKSPACE_MEMORY_PLAST_MEM_INGEST_DISABLED',
    )
  }

  const baseUrl = explicitBaseUrl ?? context.env.COMPUTER_USE_PLAST_MEM_BASE_URL?.trim() ?? config.baseUrl
  const conversationId = explicitConversationId ?? context.env.COMPUTER_USE_PLAST_MEM_CONVERSATION_ID?.trim() ?? config.conversationId
  if (!baseUrl) {
    throw new CliError(
      'Plast-mem ingestion is disabled: missing --base-url or COMPUTER_USE_PLAST_MEM_BASE_URL',
      'WORKSPACE_MEMORY_PLAST_MEM_INGEST_DISABLED',
    )
  }
  if (!conversationId) {
    throw new CliError(
      'Plast-mem ingestion is disabled: missing --conversation-id or COMPUTER_USE_PLAST_MEM_CONVERSATION_ID',
      'WORKSPACE_MEMORY_PLAST_MEM_INGEST_DISABLED',
    )
  }

  return {
    baseUrl,
    conversationId,
    apiKey: optionalString(flags, 'api-key') ?? context.env.COMPUTER_USE_PLAST_MEM_API_KEY?.trim() ?? config.apiKey,
    timeoutMs: parseOptionalPositiveInteger(optionalString(flags, 'timeout-ms'))
      ?? parseOptionalPositiveInteger(context.env.COMPUTER_USE_PLAST_MEM_TIMEOUT_MS)
      ?? config.timeoutMs,
  }
}

function authorizeReviewApply(flags: Map<string, string | true>, context: CliContext): void {
  const configuredToken = context.env.COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN?.trim()
  if (!configuredToken) {
    throw new CliError(
      'Workspace memory review apply is disabled: COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN is not configured',
      'WORKSPACE_MEMORY_REVIEW_APPLY_DISABLED',
    )
  }

  const approvalToken = optionalString(flags, 'approval-token') ?? configuredToken
  if (!constantTimeStringEqual(configuredToken, approvalToken)) {
    throw new CliError('Workspace memory review apply denied: invalid approval token', 'WORKSPACE_MEMORY_REVIEW_APPLY_DENIED')
  }
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

function constantTimeStringEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  if (expectedBuffer.length !== actualBuffer.length)
    return false
  return timingSafeEqual(expectedBuffer, actualBuffer)
}

function filterWorkspaceMemoryEntries(
  entries: readonly WorkspaceMemoryEntry[],
  options: { status: WorkspaceMemoryStatus | 'all', query?: string, limit?: number },
): WorkspaceMemoryEntry[] {
  const normalizedQuery = normalizeQuery(options.query)

  const filtered = entries
    .filter(entry => options.status === 'all' || entry.status === options.status)
    .filter(entry => !normalizedQuery || workspaceMemoryEntryHaystack(entry).includes(normalizedQuery))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return options.limit === undefined ? filtered : filtered.slice(0, options.limit)
}

function formatBridgeRecords(records: CodingPlastMemBridgeRecordV1[], format: WorkspaceMemoryExportFormat): string {
  if (format === 'json')
    return `${JSON.stringify(records, null, 2)}\n`

  return records.length > 0
    ? `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    : ''
}

function workspaceMemoryEntryHaystack(entry: WorkspaceMemoryEntry): string {
  return [
    entry.id,
    entry.status,
    entry.kind,
    entry.statement,
    entry.evidence,
    entry.confidence,
    ...entry.tags,
    ...entry.relatedFiles,
    entry.review?.decision,
    entry.review?.reviewer,
    entry.review?.rationale,
  ].filter(Boolean).join('\n').toLowerCase()
}

function normalizeQuery(value: string | undefined): string | undefined {
  const normalized = value?.replace(WHITESPACE_RE, ' ').trim().toLowerCase()
  return normalized || undefined
}

function toWorkspaceMemorySummary(entry: WorkspaceMemoryEntry) {
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
    review: entry.review,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

function toWorkspaceMemoryPublicEntry(entry: WorkspaceMemoryEntry) {
  return {
    ...toWorkspaceMemorySummary(entry),
    evidence: entry.evidence,
    sourceRunId: entry.sourceRunId,
    source: entry.source,
  }
}

function toStaleCandidateSummary(candidate: WorkspaceMemoryReviewRequestStaleCandidate) {
  return {
    staleReason: candidate.staleReason,
    request: candidate.request,
    currentEntry: candidate.currentEntry
      ? {
          id: candidate.currentEntry.id,
          status: candidate.currentEntry.status,
          updatedAt: candidate.currentEntry.updatedAt,
          statement: candidate.currentEntry.statement,
        }
      : undefined,
  }
}

function formatWorkspaceMemoryLine(entry: WorkspaceMemoryEntry): string {
  return [
    '-',
    entry.id,
    `[${entry.status}/${entry.kind}/${entry.confidence}${entry.humanVerified ? '/verified' : ''}]`,
    entry.statement,
  ].join(' ')
}

function formatReviewRequestLine(request: WorkspaceMemoryReviewRequestRecord): string {
  return [
    '-',
    request.id,
    `[${request.status}/${request.decision}]`,
    `memory=${request.memoryId}`,
    request.targetStatement,
  ].join(' ')
}

function formatStaleCandidateLine(candidate: WorkspaceMemoryReviewRequestStaleCandidate): string {
  return [
    '-',
    candidate.request.id,
    `[${candidate.staleReason}/${candidate.request.decision}]`,
    `memory=${candidate.request.memoryId}`,
    candidate.request.targetStatement,
  ].join(' ')
}

function requireString(flags: Map<string, string | true>, name: string): string {
  const value = optionalString(flags, name)
  if (!value)
    throw new CliError(`Missing required --${name}`, 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE')
  return value
}

function optionalString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name)
  if (typeof value !== 'string')
    return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function hasFlag(flags: Map<string, string | true>, name: string): boolean {
  return flags.has(name)
}

function writeSuccess(context: CliContext, payload: CliSuccessPayload, humanLines: string[]): void {
  if (context.json) {
    context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  context.stdout.write(`${humanLines.join('\n')}\n`)
}

function writeError(context: CliContext | undefined, message: string, code?: string): void {
  if (context?.json) {
    const payload: CliErrorPayload = {
      ok: false,
      status: 'error',
      workspaceKey: context.workspaceKey,
      error: message,
      code,
    }
    context.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  const output = code ? `${code}: ${message}` : message
  ;(context?.stderr ?? processStderr).write(`${output}\n`)
}

function getCliErrorCode(error: unknown): string | undefined {
  if (error instanceof CliError)
    return error.code
  if (error instanceof PlastMemIngestionError)
    return error.code
  if (error instanceof Error && error.message.includes('target is stale'))
    return 'WORKSPACE_MEMORY_REVIEW_TARGET_STALE'
  return undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message
  return String(error)
}

class CliError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

if (import.meta.url === `file://${processArgv[1]}`)
  void runWorkspaceMemoryReviewCli().then(exit)
