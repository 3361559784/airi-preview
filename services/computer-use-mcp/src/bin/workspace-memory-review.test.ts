import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
