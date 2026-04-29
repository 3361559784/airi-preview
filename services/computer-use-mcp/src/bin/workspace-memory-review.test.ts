import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceMemoryReviewRequestStore } from '../workspace-memory/review-request-store'
import { workspaceKeyFromPath, WorkspaceMemoryStore } from '../workspace-memory/store'
import { runWorkspaceMemoryReviewCli } from './workspace-memory-review'

const APPLY_TOKEN = 'workspace-memory-review-cli-token'
const WRONG_TOKEN = 'workspace-memory-review-cli-wrong-token'

class StringWriter {
  text = ''

  write(chunk: string): void {
    this.text += chunk
  }
}

describe('workspace memory review CLI', () => {
  let tmpRoot: string
  let sessionRoot: string
  let workspacePath: string
  let workspaceKey: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'workspace-memory-review-cli-'))
    sessionRoot = join(tmpRoot, 'session')
    workspacePath = join(tmpRoot, 'repo')
    workspaceKey = workspaceKeyFromPath(workspacePath)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  async function createMemoryStore() {
    const store = new WorkspaceMemoryStore(
      join(sessionRoot, 'workspace-memory', `${workspaceKey}.jsonl`),
      { workspacePath, sourceRunId: 'workspace-memory-review-cli-test' },
    )
    await store.init()
    return store
  }

  async function createRequestStore() {
    const store = new WorkspaceMemoryReviewRequestStore(
      join(sessionRoot, 'workspace-memory-review-requests', `${workspaceKey}.jsonl`),
      { workspacePath },
    )
    await store.init()
    return store
  }

  function baseArgs(command: string, extra: string[] = []): string[] {
    return [
      command,
      '--workspace',
      workspacePath,
      '--session-root',
      sessionRoot,
      ...extra,
    ]
  }

  async function runCli(extraArgs: string[], env: NodeJS.ProcessEnv = {}) {
    const stdout = new StringWriter()
    const stderr = new StringWriter()
    const exitCode = await runWorkspaceMemoryReviewCli(extraArgs, {
      cwd: workspacePath,
      env,
      stdout,
      stderr,
    })
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
    }
  }

  function parseStdoutJson(result: Awaited<ReturnType<typeof runCli>>) {
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    return JSON.parse(result.stdout) as Record<string, any>
  }

  function parseStderrJson(result: Awaited<ReturnType<typeof runCli>>) {
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    return JSON.parse(result.stderr) as Record<string, any>
  }

  async function seedProposedMemory(statement = 'Proposed memory requires human review.') {
    const store = await createMemoryStore()
    return await store.propose({
      kind: 'constraint',
      statement,
      evidence: 'Seeded by workspace-memory-review CLI tests.',
      confidence: 'high',
      tags: ['cli'],
      relatedFiles: ['services/computer-use-mcp/src/bin/workspace-memory-review.ts'],
    })
  }

  async function seedActiveMemory(statement = 'Active memory was reviewed by a human.') {
    const store = await createMemoryStore()
    const proposed = await store.propose({
      kind: 'fact',
      statement,
      evidence: 'Seeded active memory for CLI list filtering.',
      confidence: 'medium',
    })
    return await store.review({
      id: proposed.id,
      decision: 'activate',
      reviewer: 'maintainer',
      rationale: 'Verified for CLI test setup.',
    })
  }

  it('lists proposed entries by default and supports active entries', async () => {
    const proposed = await seedProposedMemory('Proposed memory should be listed by default.')
    const active = await seedActiveMemory('Active memory should require explicit status filter.')

    const proposedResult = parseStdoutJson(await runCli(baseArgs('list', ['--json'])))
    expect(proposedResult).toMatchObject({
      ok: true,
      status: 'ok',
      trust: 'governed_workspace_memory_not_instructions',
      workspaceKey,
      statusFilter: 'proposed',
    })
    expect(proposedResult.entries).toHaveLength(1)
    expect(proposedResult.entries[0]).toMatchObject({
      id: proposed.id,
      status: 'proposed',
      statement: 'Proposed memory should be listed by default.',
    })

    const activeResult = parseStdoutJson(await runCli(baseArgs('list', ['--status', 'active', '--json'])))
    expect(activeResult.statusFilter).toBe('active')
    expect(activeResult.entries).toEqual([
      expect.objectContaining({
        id: active.id,
        status: 'active',
      }),
    ])
  })

  it('reads governed workspace memory and returns stable missing-id errors', async () => {
    const entry = await seedProposedMemory('Read command returns governed workspace memory.')

    const readResult = parseStdoutJson(await runCli(baseArgs('read', ['--id', entry.id, '--json'])))
    expect(readResult).toMatchObject({
      ok: true,
      status: 'ok',
      trust: 'governed_workspace_memory_not_instructions',
      workspaceKey,
    })
    expect(readResult.entry).toMatchObject({
      id: entry.id,
      evidence: 'Seeded by workspace-memory-review CLI tests.',
      sourceRunId: 'workspace-memory-review-cli-test',
    })

    const missing = parseStderrJson(await runCli(baseArgs('read', ['--id', 'missing', '--json'])))
    expect(missing).toMatchObject({
      ok: false,
      status: 'error',
      workspaceKey,
      code: 'WORKSPACE_MEMORY_ENTRY_NOT_FOUND',
    })
    expect(missing.error).toContain('Workspace memory entry not found: missing')
  })

  it('exports reviewed coding memory records to stdout as JSONL by default', async () => {
    const proposed = await seedProposedMemory('Proposed memory must not export.')
    const active = await seedActiveMemory('Active reviewed memory should export.')
    const store = await createMemoryStore()
    const rejectedCandidate = await store.propose({
      kind: 'fact',
      statement: 'Rejected memory must not export.',
      evidence: 'Rejected entries are not eligible for plast-mem bridge export.',
    })
    await store.review({
      id: rejectedCandidate.id,
      decision: 'reject',
      reviewer: 'maintainer',
      rationale: 'Reject before export.',
    })

    const result = await runCli(baseArgs('export', [
      '--exported-at',
      '2026-04-29T02:00:00.000Z',
    ]))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const rows = result.stdout.trim().split('\n').map(row => JSON.parse(row) as Record<string, any>)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      schema: 'computer-use-mcp.coding-memory.v1',
      source: 'computer-use-mcp',
      workspaceKey,
      memoryId: active.id,
      statement: 'Active reviewed memory should export.',
      humanVerified: true,
      exportedAt: '2026-04-29T02:00:00.000Z',
      trust: 'reviewed_coding_context_not_instruction_authority',
    })
    expect(rows[0].memoryId).not.toBe(proposed.id)
    expect(rows[0].memoryId).not.toBe(rejectedCandidate.id)
  })

  it('exports all reviewed coding memory records by default instead of list-limiting to 20', async () => {
    for (let index = 0; index < 25; index += 1)
      await seedActiveMemory(`Reviewed memory ${index} should export.`)

    const result = await runCli(baseArgs('export', [
      '--exported-at',
      '2026-04-29T02:00:00.000Z',
    ]))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(25)
  })

  it('supports explicit export limit without applying the list cap', async () => {
    for (let index = 0; index < 55; index += 1)
      await seedActiveMemory(`Reviewed memory ${index} can be explicitly limited.`)

    const result = await runCli(baseArgs('export', [
      '--limit',
      '52',
      '--exported-at',
      '2026-04-29T02:00:00.000Z',
    ]))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toHaveLength(52)
  })

  it('exports reviewed coding memory records to a file and reports short human output', async () => {
    const active = await seedActiveMemory('File export should write bridge records.')
    const outputPath = join(tmpRoot, 'exports', 'plast-mem.jsonl')

    const result = await runCli(baseArgs('export', [
      '--output',
      outputPath,
      '--exported-at',
      '2026-04-29T02:00:00.000Z',
    ]))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`Exported 1 reviewed coding memory record to ${outputPath}.`)
    expect(result.stdout).toContain(active.id)

    const rows = (await readFile(outputPath, 'utf8')).trim().split('\n').map(row => JSON.parse(row) as Record<string, any>)
    expect(rows).toEqual([
      expect.objectContaining({
        memoryId: active.id,
        trust: 'reviewed_coding_context_not_instruction_authority',
      }),
    ])
  })

  it('exports JSON payload for scripts when --json is requested', async () => {
    const active = await seedActiveMemory('JSON export should be parseable.')

    const exported = parseStdoutJson(await runCli(baseArgs('export', [
      '--format',
      'json',
      '--exported-at',
      '2026-04-29T02:00:00.000Z',
      '--json',
    ])))

    expect(exported).toMatchObject({
      ok: true,
      status: 'ok',
      trust: 'reviewed_coding_context_not_instruction_authority',
      workspaceKey,
      format: 'json',
      recordCount: 1,
      records: [
        {
          memoryId: active.id,
          exportedAt: '2026-04-29T02:00:00.000Z',
          trust: 'reviewed_coding_context_not_instruction_authority',
        },
      ],
    })
  })

  it('rejects invalid export format with stable CLI usage code', async () => {
    await seedActiveMemory('Invalid format should fail before exporting.')

    const result = parseStderrJson(await runCli(baseArgs('export', [
      '--format',
      'yaml',
      '--json',
    ])))

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      code: 'WORKSPACE_MEMORY_REVIEW_CLI_USAGE',
    })
    expect(result.error).toContain('Invalid workspace memory export format: yaml')
  })

  it('keeps plast-mem ingestion disabled unless explicitly configured', async () => {
    await seedActiveMemory('Disabled ingestion should not call plast-mem.')

    const result = parseStderrJson(await runCli(baseArgs('ingest-plast-mem', ['--json'])))

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      workspaceKey,
      code: 'WORKSPACE_MEMORY_PLAST_MEM_INGEST_DISABLED',
    })
  })

  it('ingests reviewed coding memory records into configured plast-mem import endpoint', async () => {
    const active = await seedActiveMemory('Plast-mem ingestion should use reviewed records.')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await runCli(baseArgs('ingest-plast-mem', [
      '--base-url',
      'http://localhost:3030/',
      '--conversation-id',
      '00000000-0000-4000-8000-000000000001',
      '--api-key',
      'plast-secret-token',
      '--exported-at',
      '2026-04-29T02:00:00.000Z',
      '--json',
    ]))
    const payload = parseStdoutJson(result)

    expect(payload).toMatchObject({
      ok: true,
      status: 'ingested',
      trust: 'reviewed_coding_context_not_instruction_authority',
      workspaceKey,
      endpoint: 'http://localhost:3030/api/v0/import_batch_messages',
      conversationId: '00000000-0000-4000-8000-000000000001',
      recordCount: 1,
      accepted: true,
    })
    expect(result.stdout).not.toContain('plast-secret-token')
    expect(result.stderr).not.toContain('plast-secret-token')
    expect(fetchMock).toHaveBeenCalledOnce()

    const [endpoint, init] = fetchMock.mock.calls[0]!
    expect(endpoint).toBe('http://localhost:3030/api/v0/import_batch_messages')
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'authorization': 'Bearer plast-secret-token',
    })
    const body = JSON.parse(String(init?.body)) as Record<string, any>
    expect(body.conversation_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]).toMatchObject({
      role: 'computer-use-mcp',
      timestamp: Date.parse('2026-04-29T02:00:00.000Z'),
    })
    expect(body.messages[0].content).toContain(active.id)
    expect(body.messages[0].content).toContain('Plast-mem ingestion should use reviewed records.')
  })

  it('surfaces plast-mem ingestion failures without echoing API keys', async () => {
    await seedActiveMemory('Ingestion failures should be visible to operators.')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('upstream unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await runCli(baseArgs('ingest-plast-mem', [
      '--base-url',
      'http://localhost:3030',
      '--conversation-id',
      '00000000-0000-4000-8000-000000000001',
      '--api-key',
      'plast-secret-token',
      '--json',
    ]))
    const payload = parseStderrJson(result)

    expect(payload).toMatchObject({
      ok: false,
      status: 'error',
      workspaceKey,
      code: 'PLAST_MEM_INGESTION_HTTP_ERROR',
    })
    expect(payload.error).toContain('HTTP 503')
    expect(result.stdout).not.toContain('plast-secret-token')
    expect(result.stderr).not.toContain('plast-secret-token')
  })

  it('creates review requests without mutating memory and deduplicates pending memory-id decisions', async () => {
    const entry = await seedProposedMemory('Request-review should not mutate memory status.')

    const first = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      entry.id,
      '--decision',
      'activate',
      '--requester',
      'chika',
      '--rationale',
      'Promote this reviewed memory later.',
      '--json',
    ])))
    expect(first).toMatchObject({
      ok: true,
      status: 'approval_required',
      trust: 'workspace_memory_review_request_not_instructions',
      workspaceKey,
    })
    expect(first.pendingReviewId).toBe(first.request.id)

    const reloadedMemory = await createMemoryStore()
    expect(reloadedMemory.read(entry.id)?.status).toBe('proposed')

    const second = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      entry.id,
      '--decision',
      'activate',
      '--requester',
      'another-reviewer',
      '--rationale',
      'Duplicate pending activation should reuse the existing request.',
      '--json',
    ])))
    expect(second.pendingReviewId).toBe(first.pendingReviewId)

    const requestStore = await createRequestStore()
    expect(requestStore.getAll()).toHaveLength(1)
  })

  it('lists pending requests by default and resolved requests by explicit status', async () => {
    const pendingEntry = await seedProposedMemory('Pending request remains pending by default.')
    const appliedEntry = await seedProposedMemory('Applied request appears only under applied status.')

    await runCli(baseArgs('request-review', [
      '--id',
      pendingEntry.id,
      '--decision',
      'activate',
      '--requester',
      'chika',
      '--rationale',
      'Keep pending for list default.',
    ]))
    const appliedRequest = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      appliedEntry.id,
      '--decision',
      'activate',
      '--requester',
      'chika',
      '--rationale',
      'Apply this request.',
      '--json',
    ])))
    await runCli(baseArgs('apply', [
      '--id',
      String(appliedRequest.pendingReviewId),
      '--approver',
      'host',
      '--rationale',
      'Authorized apply for list filtering.',
    ]), {
      COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN: APPLY_TOKEN,
    })

    const pending = parseStdoutJson(await runCli(baseArgs('list-requests', ['--json'])))
    expect(pending.statusFilter).toBe('pending')
    expect(pending.requests).toEqual([
      expect.objectContaining({
        status: 'pending',
        memoryId: pendingEntry.id,
      }),
    ])

    const applied = parseStdoutJson(await runCli(baseArgs('list-requests', ['--status', 'applied', '--json'])))
    expect(applied.statusFilter).toBe('applied')
    expect(applied.requests).toEqual([
      expect.objectContaining({
        status: 'applied',
        memoryId: appliedEntry.id,
      }),
    ])
  })

  it('lists stale pending review request candidates without resolving them', async () => {
    const entry = await seedProposedMemory('Stale candidate should be visible before apply.')
    const request = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      entry.id,
      '--decision',
      'activate',
      '--requester',
      'chika',
      '--rationale',
      'Activate if the snapshot remains current.',
      '--json',
    ])))
    const memoryStore = await createMemoryStore()
    await memoryStore.review({
      id: entry.id,
      decision: 'reject',
      reviewer: 'maintainer',
      rationale: 'Changed after the review request was created.',
    })

    const stale = parseStdoutJson(await runCli(baseArgs('list-stale-requests', ['--json'])))
    expect(stale).toMatchObject({
      ok: true,
      status: 'ok',
      trust: 'workspace_memory_review_request_not_instructions',
      workspaceKey,
    })
    expect(stale.staleCandidates).toEqual([
      expect.objectContaining({
        staleReason: 'target_status_changed',
        request: expect.objectContaining({
          id: request.pendingReviewId,
          status: 'pending',
          memoryId: entry.id,
        }),
        currentEntry: expect.objectContaining({
          id: entry.id,
          status: 'rejected',
        }),
      }),
    ])

    const requestStore = await createRequestStore()
    expect(requestStore.read(String(request.pendingReviewId))?.status).toBe('pending')
  })

  it('requires apply authorization and never echoes wrong approval tokens', async () => {
    const entry = await seedProposedMemory('Apply authorization should not echo secrets.')
    const request = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      entry.id,
      '--decision',
      'activate',
      '--requester',
      'chika',
      '--rationale',
      'Needs authorized apply.',
      '--json',
    ])))

    const disabled = parseStderrJson(await runCli(baseArgs('apply', [
      '--id',
      String(request.pendingReviewId),
      '--approver',
      'host',
      '--rationale',
      'Missing configured token should fail.',
      '--json',
    ])))
    expect(disabled.code).toBe('WORKSPACE_MEMORY_REVIEW_APPLY_DISABLED')

    const deniedResult = await runCli(baseArgs('apply', [
      '--id',
      String(request.pendingReviewId),
      '--approver',
      'host',
      '--rationale',
      'Wrong token should fail.',
      '--approval-token',
      WRONG_TOKEN,
      '--json',
    ]), {
      COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN: APPLY_TOKEN,
    })
    const denied = parseStderrJson(deniedResult)
    expect(denied.code).toBe('WORKSPACE_MEMORY_REVIEW_APPLY_DENIED')
    expect(deniedResult.stdout).not.toContain(WRONG_TOKEN)
    expect(deniedResult.stderr).not.toContain(WRONG_TOKEN)
  })

  it('applies activate and reject decisions through WorkspaceMemoryStore.review()', async () => {
    const activationCandidate = await seedProposedMemory('Activation request should mark memory active.')
    const rejectionCandidate = await seedActiveMemory('Rejection request should mark memory rejected.')
    const activationRequest = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      activationCandidate.id,
      '--decision',
      'activate',
      '--requester',
      'chika',
      '--rationale',
      'Activate durable memory.',
      '--json',
    ])))
    const rejectionRequest = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      rejectionCandidate.id,
      '--decision',
      'reject',
      '--requester',
      'chika',
      '--rationale',
      'Reject stale memory.',
      '--json',
    ])))

    const activation = parseStdoutJson(await runCli(baseArgs('apply', [
      '--id',
      String(activationRequest.pendingReviewId),
      '--approver',
      'host',
      '--rationale',
      'Approved activation.',
      '--approval-token',
      APPLY_TOKEN,
      '--json',
    ]), {
      COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN: APPLY_TOKEN,
    }))
    expect(activation).toMatchObject({
      ok: true,
      status: 'applied',
      workspaceKey,
      entry: {
        id: activationCandidate.id,
        status: 'active',
        humanVerified: true,
      },
    })

    const rejection = parseStdoutJson(await runCli(baseArgs('apply', [
      '--id',
      String(rejectionRequest.pendingReviewId),
      '--approver',
      'host',
      '--rationale',
      'Approved rejection.',
      '--approval-token',
      APPLY_TOKEN,
      '--json',
    ]), {
      COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN: APPLY_TOKEN,
    }))
    expect(rejection).toMatchObject({
      ok: true,
      status: 'applied',
      entry: {
        id: rejectionCandidate.id,
        status: 'rejected',
        humanVerified: false,
      },
    })

    const memoryStore = await createMemoryStore()
    expect(memoryStore.read(activationCandidate.id)?.status).toBe('active')
    expect(memoryStore.read(rejectionCandidate.id)?.status).toBe('rejected')
  })

  it('rejects pending requests without mutating memory status', async () => {
    const entry = await seedProposedMemory('Rejecting a request should not reject memory.')
    const request = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      entry.id,
      '--decision',
      'activate',
      '--requester',
      'chika',
      '--rationale',
      'Request can be rejected by operator.',
      '--json',
    ])))

    const rejection = parseStdoutJson(await runCli(baseArgs('reject', [
      '--id',
      String(request.pendingReviewId),
      '--approver',
      'host',
      '--rationale',
      'Do not apply this request.',
      '--json',
    ]), {
      COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN: APPLY_TOKEN,
    }))
    expect(rejection).toMatchObject({
      ok: true,
      status: 'rejected',
      request: {
        id: request.pendingReviewId,
        status: 'rejected',
      },
    })

    const memoryStore = await createMemoryStore()
    expect(memoryStore.read(entry.id)?.status).toBe('proposed')
  })

  it('keeps human output short and does not print approval tokens', async () => {
    const entry = await seedProposedMemory('Human output should not leak tokens.')
    const request = parseStdoutJson(await runCli(baseArgs('request-review', [
      '--id',
      entry.id,
      '--decision',
      'activate',
      '--requester',
      'chika',
      '--rationale',
      'Prepare human output apply.',
      '--json',
    ])))

    const result = await runCli(baseArgs('apply', [
      '--id',
      String(request.pendingReviewId),
      '--approver',
      'host',
      '--rationale',
      'Approved without leaking token.',
      '--approval-token',
      APPLY_TOKEN,
    ]), {
      COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN: APPLY_TOKEN,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Workspace memory review request applied')
    expect(result.stdout).not.toContain(APPLY_TOKEN)
    expect(result.stderr).not.toContain(APPLY_TOKEN)
  })
})
