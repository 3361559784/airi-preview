import type { CodingPlastMemBridgeRecordV1 } from './plast-mem'

export const DEFAULT_PLAST_MEM_INGESTION_TIMEOUT_MS = 10_000
export const PLAST_MEM_IMPORT_BATCH_PATH = '/api/v0/import_batch_messages'
export const CODING_PLAST_MEM_INGESTION_ROLE = 'computer-use-mcp'
const TRAILING_SLASHES_RE = /\/+$/

export interface PlastMemImportBatchMessage {
  role: string
  content: string
  timestamp?: number
}

export interface PlastMemImportBatchRequest {
  conversation_id: string
  messages: PlastMemImportBatchMessage[]
}

export interface PlastMemIngestionOptions {
  baseUrl: string
  conversationId: string
  apiKey?: string
  timeoutMs?: number
  role?: string
  fetchImpl?: typeof fetch
}

export interface PlastMemIngestionResult {
  status: 'ingested'
  endpoint: string
  conversationId: string
  recordCount: number
  accepted: boolean
}

export class PlastMemIngestionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/**
 * Build the plast-mem batch ingestion payload without calling the network.
 *
 * The plast-mem HTTP server currently ingests conversation messages through
 * `/api/v0/import_batch_messages`; semantic consolidation stays owned by
 * plast-mem after ingestion.
 */
export function buildPlastMemImportBatchRequest(
  records: readonly CodingPlastMemBridgeRecordV1[],
  options: Pick<PlastMemIngestionOptions, 'conversationId' | 'role'>,
): PlastMemImportBatchRequest {
  const conversationId = normalizeRequiredText(
    options.conversationId,
    'Plast-mem conversation id is required',
  )
  const role = normalizeRequiredText(
    options.role ?? CODING_PLAST_MEM_INGESTION_ROLE,
    'Plast-mem ingestion role is required',
  )

  return {
    conversation_id: conversationId,
    messages: records.map(record => ({
      role,
      content: formatCodingPlastMemIngestionMessage(record),
      timestamp: parseExportedAtMilliseconds(record.exportedAt, record.memoryId),
    })),
  }
}

export function formatCodingPlastMemIngestionMessage(record: CodingPlastMemBridgeRecordV1): string {
  return [
    'Reviewed coding memory record',
    `schema: ${record.schema}`,
    `source: ${record.source}`,
    `trust: ${record.trust}`,
    `workspaceKey: ${record.workspaceKey}`,
    `memoryId: ${record.memoryId}`,
    `kind: ${record.kind}`,
    `confidence: ${record.confidence}`,
    `tags: ${record.tags.join(', ') || '(none)'}`,
    `relatedFiles: ${record.relatedFiles.join(', ') || '(none)'}`,
    record.sourceRunId ? `sourceRunId: ${record.sourceRunId}` : undefined,
    record.reviewRequestId ? `reviewRequestId: ${record.reviewRequestId}` : undefined,
    `reviewer: ${record.review.reviewer}`,
    `reviewedAt: ${record.review.reviewedAt}`,
    `reviewRationale: ${record.review.rationale}`,
    `exportedAt: ${record.exportedAt}`,
    '',
    'statement:',
    record.statement,
    '',
    'evidence:',
    record.evidence,
  ].filter(line => line !== undefined).join('\n')
}

export async function ingestCodingPlastMemBridgeRecords(
  records: readonly CodingPlastMemBridgeRecordV1[],
  options: PlastMemIngestionOptions,
): Promise<PlastMemIngestionResult> {
  const endpoint = buildPlastMemImportBatchEndpoint(options.baseUrl)
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs)
  const request = buildPlastMemImportBatchRequest(records, options)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (!fetchImpl)
    throw new PlastMemIngestionError('Global fetch is not available for plast-mem ingestion', 'PLAST_MEM_FETCH_UNAVAILABLE')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })

    if (!response.ok) {
      const responseText = redactSensitiveText(await safeResponseText(response), options.apiKey)
      throw new PlastMemIngestionError(
        `Plast-mem ingestion failed with HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`,
        'PLAST_MEM_INGESTION_HTTP_ERROR',
      )
    }

    const body = await safeResponseJson(response)
    return {
      status: 'ingested',
      endpoint,
      conversationId: request.conversation_id,
      recordCount: records.length,
      accepted: body?.accepted === true,
    }
  }
  catch (error) {
    if (error instanceof PlastMemIngestionError)
      throw error
    if (isAbortError(error)) {
      throw new PlastMemIngestionError(
        `Plast-mem ingestion timed out after ${timeoutMs}ms`,
        'PLAST_MEM_INGESTION_TIMEOUT',
      )
    }
    const errorMessage = redactSensitiveText(
      error instanceof Error ? error.message : String(error),
      options.apiKey,
    )
    throw new PlastMemIngestionError(
      `Plast-mem ingestion request failed: ${errorMessage}`,
      'PLAST_MEM_INGESTION_REQUEST_FAILED',
    )
  }
  finally {
    clearTimeout(timeout)
  }
}

export async function tryIngestCodingPlastMemBridgeRecords(
  records: readonly CodingPlastMemBridgeRecordV1[],
  options: PlastMemIngestionOptions,
): Promise<PlastMemIngestionResult | { status: 'failed', code: string, error: string, recordCount: number }> {
  try {
    return await ingestCodingPlastMemBridgeRecords(records, options)
  }
  catch (error) {
    return {
      status: 'failed',
      code: error instanceof PlastMemIngestionError ? error.code : 'PLAST_MEM_INGESTION_REQUEST_FAILED',
      error: error instanceof Error ? error.message : String(error),
      recordCount: records.length,
    }
  }
}

function buildPlastMemImportBatchEndpoint(baseUrl: string): string {
  const normalizedBaseUrl = normalizeRequiredText(baseUrl, 'Plast-mem base URL is required')
  return `${normalizedBaseUrl.replace(TRAILING_SLASHES_RE, '')}${PLAST_MEM_IMPORT_BATCH_PATH}`
}

function parseExportedAtMilliseconds(exportedAt: string, memoryId: string): number {
  const timestamp = Date.parse(exportedAt)
  if (!Number.isFinite(timestamp)) {
    throw new PlastMemIngestionError(
      `Invalid plast-mem export timestamp for memory ${memoryId}: ${exportedAt}`,
      'PLAST_MEM_INVALID_EXPORTED_AT',
    )
  }
  return timestamp
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined)
    return DEFAULT_PLAST_MEM_INGESTION_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return DEFAULT_PLAST_MEM_INGESTION_TIMEOUT_MS
  return Math.floor(timeoutMs)
}

function normalizeRequiredText(value: string | undefined, message: string): string {
  const normalized = value?.trim()
  if (!normalized)
    throw new PlastMemIngestionError(message, 'PLAST_MEM_INGESTION_CONFIG_REQUIRED')
  return normalized
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  }
  catch {
    return ''
  }
}

async function safeResponseJson(response: Response): Promise<{ accepted?: unknown } | undefined> {
  try {
    return await response.json() as { accepted?: unknown }
  }
  catch {
    return undefined
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function redactSensitiveText(value: string, secret: string | undefined): string {
  const normalizedSecret = secret?.trim()
  if (!normalizedSecret)
    return value
  return value.split(normalizedSecret).join('[redacted]')
}
