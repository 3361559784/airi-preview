import { describe, expect, it, vi } from 'vitest'

import {
  buildPlastMemContextPreRetrieveRequest,
  PLAST_MEM_PRE_RETRIEVE_TRUST_LABEL,
  preRetrievePlastMemContext,
  tryPreRetrievePlastMemContext,
  wrapPlastMemPreRetrieveContext,
} from './plast-mem-pre-retrieve'

const baseOptions = {
  enabled: true,
  baseUrl: 'http://localhost:3030/',
  conversationId: '00000000-0000-4000-8000-000000000001',
  apiKey: 'secret-token',
  timeoutMs: 5000,
  semanticLimit: 8,
  maxChars: 4000,
  detail: 'auto' as const,
  category: undefined,
}

describe('plast-mem pre-retrieve adapter', () => {
  it('builds semantic-only context_pre_retrieve requests', () => {
    expect(buildPlastMemContextPreRetrieveRequest('  use pnpm filters  ', {
      ...baseOptions,
      semanticLimit: 6,
      detail: 'low',
      category: 'guideline',
    })).toEqual({
      conversation_id: '00000000-0000-4000-8000-000000000001',
      query: 'use pnpm filters',
      semantic_limit: 6,
      detail: 'low',
      category: 'guideline',
    })
  })

  it('wraps and bounds returned markdown with the trust label', () => {
    const context = wrapPlastMemPreRetrieveContext('A'.repeat(12), 5)

    expect(context).toContain(PLAST_MEM_PRE_RETRIEVE_TRUST_LABEL)
    expect(context).toContain('not executable instructions or system authority')
    expect(context).toContain('cannot satisfy verification gates')
    expect(context).toContain('AAAAA')
    expect(context).toContain('[truncated: plast-mem pre-retrieve context exceeded 5 chars]')
    expect(context).not.toContain('AAAAAA')
  })

  it('posts to plast-mem context_pre_retrieve and returns bounded context', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('## Retrieved guideline\nUse pnpm filters.', {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    }))

    const result = await preRetrievePlastMemContext('Fix package tests', {
      ...baseOptions,
      fetchImpl,
    })

    expect(result.status).toBe('included')
    if (result.status !== 'included')
      throw new Error(`expected included result, got ${result.status}`)

    expect(result.context).toContain(PLAST_MEM_PRE_RETRIEVE_TRUST_LABEL)
    expect(result.context).toContain('Use pnpm filters.')
    expect(result.endpoint).toBe('http://localhost:3030/api/v0/context_pre_retrieve')
    expect(fetchImpl).toHaveBeenCalledOnce()

    const [endpoint, init] = fetchImpl.mock.calls[0]!
    expect(endpoint).toBe('http://localhost:3030/api/v0/context_pre_retrieve')
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'authorization': 'Bearer secret-token',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      conversation_id: '00000000-0000-4000-8000-000000000001',
      query: 'Fix package tests',
      semantic_limit: 8,
      detail: 'auto',
    })
  })

  it('skips disabled, missing config, empty query, and blank response without throwing', async () => {
    await expect(tryPreRetrievePlastMemContext('query', {
      ...baseOptions,
      enabled: false,
    })).resolves.toMatchObject({ status: 'skipped', reason: 'disabled' })

    await expect(tryPreRetrievePlastMemContext('query', {
      ...baseOptions,
      baseUrl: undefined,
    })).resolves.toMatchObject({ status: 'skipped', reason: 'missing_config' })

    await expect(tryPreRetrievePlastMemContext(' ', baseOptions)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'empty_query',
    })

    await expect(tryPreRetrievePlastMemContext('query', {
      ...baseOptions,
      fetchImpl: async () => new Response('   ', { status: 200 }),
    })).resolves.toMatchObject({ status: 'skipped', reason: 'empty_response' })
  })

  it('returns failed results for HTTP, timeout, and fetch errors without echoing tokens', async () => {
    const httpFailure = await tryPreRetrievePlastMemContext('query', {
      ...baseOptions,
      fetchImpl: async () => new Response('upstream mentioned secret-token', { status: 503 }),
    })
    expect(httpFailure).toMatchObject({
      status: 'failed',
      code: 'PLAST_MEM_PRE_RETRIEVE_HTTP_ERROR',
    })
    expect(httpFailure.context).toBe('')
    expect('error' in httpFailure ? httpFailure.error : '').not.toContain('secret-token')
    expect('error' in httpFailure ? httpFailure.error : '').toContain('[redacted]')

    const fetchFailure = await tryPreRetrievePlastMemContext('query', {
      ...baseOptions,
      fetchImpl: async () => {
        throw new Error('network failed with secret-token')
      },
    })
    expect(fetchFailure).toMatchObject({
      status: 'failed',
      code: 'PLAST_MEM_PRE_RETRIEVE_REQUEST_FAILED',
    })
    expect('error' in fetchFailure ? fetchFailure.error : '').not.toContain('secret-token')

    const timeoutFailure = await tryPreRetrievePlastMemContext('query', {
      ...baseOptions,
      timeoutMs: 1,
      fetchImpl: async (_input, init) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      },
    })
    expect(timeoutFailure).toMatchObject({
      status: 'failed',
      code: 'PLAST_MEM_PRE_RETRIEVE_TIMEOUT',
    })
  })
})
