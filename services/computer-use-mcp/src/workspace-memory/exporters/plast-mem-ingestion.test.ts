import type { CodingPlastMemBridgeRecordV1 } from './plast-mem'

import { describe, expect, it, vi } from 'vitest'

import {
  buildPlastMemImportBatchRequest,
  formatCodingPlastMemIngestionMessage,
  ingestCodingPlastMemBridgeRecords,
  PlastMemIngestionError,
  tryIngestCodingPlastMemBridgeRecords,
} from './plast-mem-ingestion'

function bridgeRecord(overrides: Partial<CodingPlastMemBridgeRecordV1> = {}): CodingPlastMemBridgeRecordV1 {
  return {
    schema: 'computer-use-mcp.coding-memory.v1',
    source: 'computer-use-mcp',
    workspaceKey: 'workspace-key',
    memoryId: 'mem-1',
    kind: 'constraint',
    statement: 'Use pnpm workspace filters for computer-use-mcp tests.',
    evidence: 'Verified by filtered test runs.',
    confidence: 'high',
    tags: ['pnpm', 'tests'],
    relatedFiles: ['services/computer-use-mcp/package.json'],
    sourceRunId: 'run-1',
    humanVerified: true,
    review: {
      reviewer: 'maintainer',
      rationale: 'Confirmed as durable coding workflow guidance.',
      reviewedAt: '2026-04-29T01:00:00.000Z',
    },
    exportedAt: '2026-04-29T02:00:00.000Z',
    trust: 'reviewed_coding_context_not_instruction_authority',
    ...overrides,
  }
}

describe('plast-mem ingestion adapter', () => {
  it('serializes reviewed bridge records into plast-mem batch messages', () => {
    const request = buildPlastMemImportBatchRequest([bridgeRecord()], {
      conversationId: '00000000-0000-4000-8000-000000000001',
    })

    expect(request).toEqual({
      conversation_id: '00000000-0000-4000-8000-000000000001',
      messages: [
        {
          role: 'computer-use-mcp',
          timestamp: Date.parse('2026-04-29T02:00:00.000Z'),
          content: expect.stringContaining('Reviewed coding memory record'),
        },
      ],
    })
    expect(request.messages[0].content).toContain('trust: reviewed_coding_context_not_instruction_authority')
    expect(request.messages[0].content).toContain('statement:\nUse pnpm workspace filters')
    expect(request.messages[0].content).toContain('evidence:\nVerified by filtered test runs.')
  })

  it('keeps message formatting readable for plast-mem consolidation', () => {
    const message = formatCodingPlastMemIngestionMessage(bridgeRecord({
      reviewRequestId: 'review-1',
    }))

    expect(message).toContain('memoryId: mem-1')
    expect(message).toContain('reviewRequestId: review-1')
    expect(message).toContain('reviewRationale: Confirmed as durable coding workflow guidance.')
    expect(message).not.toContain('[object Object]')
  })

  it('posts to plast-mem import_batch_messages with optional bearer token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const result = await ingestCodingPlastMemBridgeRecords([bridgeRecord()], {
      baseUrl: 'http://localhost:3030/',
      conversationId: '00000000-0000-4000-8000-000000000001',
      apiKey: 'secret-token',
      fetchImpl,
    })

    expect(result).toEqual({
      status: 'ingested',
      endpoint: 'http://localhost:3030/api/v0/import_batch_messages',
      conversationId: '00000000-0000-4000-8000-000000000001',
      recordCount: 1,
      accepted: true,
    })
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3030/api/v0/import_batch_messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'authorization': 'Bearer secret-token',
      }),
    }))
    const [, init] = fetchImpl.mock.calls[0]!
    const body = JSON.parse(String(init?.body))
    expect(body.conversation_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(body.messages).toHaveLength(1)
  })

  it('throws stable errors for disabled config, bad timestamps, and HTTP failures without echoing tokens', async () => {
    expect(() => buildPlastMemImportBatchRequest([bridgeRecord()], {
      conversationId: ' ',
    })).toThrow('conversation id is required')

    expect(() => buildPlastMemImportBatchRequest([bridgeRecord({ exportedAt: 'not-a-date' })], {
      conversationId: '00000000-0000-4000-8000-000000000001',
    })).toThrow('Invalid plast-mem export timestamp')

    const fetchImpl = vi.fn(async () => new Response('upstream rejected request with secret-token', { status: 503 }))
    await expect(ingestCodingPlastMemBridgeRecords([bridgeRecord()], {
      baseUrl: 'http://localhost:3030',
      conversationId: '00000000-0000-4000-8000-000000000001',
      apiKey: 'secret-token',
      fetchImpl,
    })).rejects.toMatchObject({
      code: 'PLAST_MEM_INGESTION_HTTP_ERROR',
    })

    await ingestCodingPlastMemBridgeRecords([bridgeRecord()], {
      baseUrl: 'http://localhost:3030',
      conversationId: '00000000-0000-4000-8000-000000000001',
      apiKey: 'secret-token',
      fetchImpl,
    }).catch((error) => {
      expect(error).toBeInstanceOf(PlastMemIngestionError)
      expect(error.message).not.toContain('secret-token')
      expect(error.message).toContain('[redacted]')
    })
  })

  it('offers a non-throwing adapter result for future runner-safe integration', async () => {
    const result = await tryIngestCodingPlastMemBridgeRecords([bridgeRecord()], {
      baseUrl: 'http://localhost:3030',
      conversationId: '00000000-0000-4000-8000-000000000001',
      fetchImpl: async () => new Response('down', { status: 500 }),
    })

    expect(result).toMatchObject({
      status: 'failed',
      code: 'PLAST_MEM_INGESTION_HTTP_ERROR',
      recordCount: 1,
    })
  })
})
