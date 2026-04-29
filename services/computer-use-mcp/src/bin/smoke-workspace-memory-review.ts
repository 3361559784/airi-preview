/**
 * MCP smoke test for workspace memory review requests and authorized apply.
 *
 * Verifies that:
 * 1. Review request/apply/reject tools are registered on the real stdio MCP server.
 * 2. Requesting review does not mutate workspace memory status.
 * 3. Apply requires the configured host/client token and never echoes wrong tokens.
 * 4. Authorized apply activates memory through WorkspaceMemoryStore.review().
 * 5. Authorized request rejection resolves only the request and leaves memory unchanged.
 *
 * This is deliberately a service-level smoke, not an AIRI CLI surface.
 *
 * Usage:
 *   pnpm -F @proj-airi/computer-use-mcp smoke:workspace-memory-review
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { env, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { workspaceKeyFromPath, WorkspaceMemoryStore } from '../workspace-memory/store'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const APPLY_TOKEN = 'workspace-memory-review-smoke-token'
const WRONG_TOKEN = 'workspace-memory-review-smoke-wrong-token'
const WHITESPACE_RE = /\s+/

function parseCommandArgs(raw: string | undefined, fallback: string[]) {
  if (!raw?.trim())
    return fallback

  return raw
    .split(WHITESPACE_RE)
    .map(item => item.trim())
    .filter(Boolean)
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition)
    throw new Error(`Assertion failed: ${message}`)
}

function requireStructuredContent(result: unknown, label: string) {
  if (!result || typeof result !== 'object')
    throw new Error(`${label} did not return an object result`)

  const structuredContent = (result as { structuredContent?: unknown }).structuredContent
  if (!structuredContent || typeof structuredContent !== 'object')
    throw new Error(`${label} missing structuredContent`)

  return structuredContent as Record<string, unknown>
}

function getArrayField(record: Record<string, unknown>, field: string, label: string): Record<string, unknown>[] {
  const value = record[field]
  if (!Array.isArray(value))
    throw new Error(`${label} missing array field: ${field}`)

  return value.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
}

async function createClient(sessionRoot: string): Promise<Client> {
  const command = env.COMPUTER_USE_SMOKE_SERVER_COMMAND?.trim() || 'pnpm'
  const args = parseCommandArgs(env.COMPUTER_USE_SMOKE_SERVER_ARGS, ['start'])
  const cwd = env.COMPUTER_USE_SMOKE_SERVER_CWD?.trim() || packageDir

  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: {
      ...env,
      COMPUTER_USE_EXECUTOR: 'dry-run',
      COMPUTER_USE_APPROVAL_MODE: 'actions',
      COMPUTER_USE_SESSION_ROOT: sessionRoot,
      COMPUTER_USE_SESSION_TAG: 'smoke-workspace-memory-review',
      COMPUTER_USE_ALLOWED_BOUNDS: '0,0,1280,800',
      COMPUTER_USE_WORKSPACE_MEMORY_REVIEW_APPLY_TOKEN: APPLY_TOKEN,
    },
    stderr: 'pipe',
  })

  const client = new Client({
    name: '@proj-airi/computer-use-mcp-smoke-workspace-memory-review',
    version: '0.1.0',
  })

  transport.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf-8').trim()
    if (text)
      console.error(`[computer-use-mcp stderr] ${text}`)
  })

  await client.connect(transport)
  return client
}

async function seedWorkspaceMemory(sessionRoot: string, workspacePath: string) {
  const store = new WorkspaceMemoryStore(
    join(sessionRoot, 'workspace-memory', `${workspaceKeyFromPath(workspacePath)}.jsonl`),
    { workspacePath, sourceRunId: 'smoke-workspace-memory-review' },
  )
  await store.init()

  const activationCandidate = await store.propose({
    kind: 'fact',
    statement: 'Workspace memory review smoke can activate governed memory.',
    evidence: 'Seeded by smoke-workspace-memory-review.ts for authorized apply validation.',
    confidence: 'high',
  })

  const rejectionCandidate = await store.propose({
    kind: 'pitfall',
    statement: 'Workspace memory review smoke request rejection does not reject memory.',
    evidence: 'Seeded by smoke-workspace-memory-review.ts for request rejection validation.',
    confidence: 'medium',
  })

  return { activationCandidate, rejectionCandidate }
}

async function assertWorkspaceMemoryTools(client: Client) {
  console.info('\n=== Test 1: workspace memory review tools are registered ===')
  const initialTools = await client.listTools()
  const initialToolNames = new Set(initialTools.tools.map(tool => tool.name))
  assert(initialToolNames.has('tool_search'), 'missing tool_search meta-tool')

  const requiredTools = [
    'workspace_memory_list',
    'workspace_memory_read',
    'workspace_memory_request_review',
    'workspace_memory_list_review_requests',
    'workspace_memory_list_stale_review_requests',
    'workspace_memory_read_review_request',
    'workspace_memory_apply_review_request',
    'workspace_memory_reject_review_request',
  ]

  const searchResult = await client.callTool({
    name: 'tool_search',
    arguments: {
      query: 'workspace memory review',
      lane: 'workspace_memory',
      limit: 10,
      exposeTools: requiredTools,
    },
  })
  const searchData = requireStructuredContent(searchResult, 'tool_search expose workspace memory tools')
  const candidates = getArrayField(searchData, 'candidates', 'tool_search expose workspace memory tools')
  const candidateNames = new Set(candidates.map(candidate => String(candidate.canonicalName)))

  for (const expectedCandidate of [
    'workspace_memory_request_review',
    'workspace_memory_list_review_requests',
    'workspace_memory_list_stale_review_requests',
    'workspace_memory_read_review_request',
    'workspace_memory_apply_review_request',
    'workspace_memory_reject_review_request',
  ]) {
    assert(candidateNames.has(expectedCandidate), `tool_search missing candidate: ${expectedCandidate}`)
  }

  const tools = await client.listTools()
  const toolNames = new Set(tools.tools.map(tool => tool.name))

  for (const required of [
    'tool_search',
    ...requiredTools,
  ]) {
    assert(toolNames.has(required), `missing tool: ${required}`)
    console.info(`  ✓ ${required}`)
  }

  for (const forbidden of [
    'workspace_memory_review',
    'workspace_memory_approve_review_request',
    'coding_review_workspace_memory',
    'coding_update_workspace_memory',
    'coding_activate_workspace_memory',
  ]) {
    assert(!toolNames.has(forbidden), `unexpected mutation/model-loop tool: ${forbidden}`)
  }
  console.info('  PASSED')
}

async function assertToolSearchFindsReviewTools(client: Client) {
  console.info('\n=== Test 2: tool_search exposes review request/apply tools ===')
  const result = await client.callTool({
    name: 'tool_search',
    arguments: {
      query: 'workspace memory review',
      limit: 20,
    },
  })
  const data = requireStructuredContent(result, 'tool_search')
  const tools = getArrayField(data, 'candidates', 'tool_search')
  const names = new Set(tools.map(tool => String(tool.canonicalName)))

  assert(names.has('workspace_memory_request_review'), 'tool_search missing workspace_memory_request_review')
  assert(names.has('workspace_memory_apply_review_request'), 'tool_search missing workspace_memory_apply_review_request')
  assert(names.has('workspace_memory_reject_review_request'), 'tool_search missing workspace_memory_reject_review_request')
  assert(!names.has('workspace_memory_review'), 'tool_search exposed generic workspace_memory_review')
  console.info('  PASSED')
}

async function assertRequestAndApplyFlow(client: Client, workspacePath: string, memoryId: string) {
  console.info('\n=== Test 3: review request + authorized apply ===')
  const requestResult = await client.callTool({
    name: 'workspace_memory_request_review',
    arguments: {
      workspacePath,
      id: memoryId,
      decision: 'activate',
      requester: 'smoke-requester',
      rationale: 'Smoke validates request-only review before authorized apply.',
    },
  })
  const requestData = requireStructuredContent(requestResult, 'workspace_memory_request_review')
  assert(requestData.status === 'approval_required', `expected approval_required, got ${String(requestData.status)}`)
  assert(requestData.trust === 'workspace_memory_review_request_not_instructions', 'request missing trust marker')
  const pendingReviewId = String(requestData.pendingReviewId || '')
  assert(pendingReviewId.length > 0, 'request missing pendingReviewId')

  const proposedList = await client.callTool({
    name: 'workspace_memory_list',
    arguments: {
      workspacePath,
      status: 'proposed',
      query: 'activate governed memory',
    },
  })
  const proposedData = requireStructuredContent(proposedList, 'workspace_memory_list proposed')
  const proposedEntries = getArrayField(proposedData, 'entries', 'workspace_memory_list proposed')
  assert(proposedEntries.some(entry => entry.id === memoryId), 'request mutated memory before authorized apply')

  const wrongTokenResult = await client.callTool({
    name: 'workspace_memory_apply_review_request',
    arguments: {
      workspacePath,
      id: pendingReviewId,
      approver: 'smoke-host',
      rationale: 'This should be rejected.',
      approvalToken: WRONG_TOKEN,
    },
  })
  const wrongTokenSerialized = JSON.stringify(wrongTokenResult)
  const wrongTokenData = requireStructuredContent(wrongTokenResult, 'workspace_memory_apply_review_request wrong token')
  assert((wrongTokenResult as { isError?: boolean }).isError === true, 'wrong token apply should be an MCP error')
  assert(wrongTokenData.code === 'WORKSPACE_MEMORY_REVIEW_APPLY_DENIED', `expected token denial code, got ${String(wrongTokenData.code)}`)
  assert(!wrongTokenSerialized.includes(WRONG_TOKEN), 'wrong approval token was echoed in tool response')

  const applyResult = await client.callTool({
    name: 'workspace_memory_apply_review_request',
    arguments: {
      workspacePath,
      id: pendingReviewId,
      approver: 'smoke-host',
      rationale: 'Authorized smoke apply.',
      approvalToken: APPLY_TOKEN,
    },
  })
  const applySerialized = JSON.stringify(applyResult)
  const applyData = requireStructuredContent(applyResult, 'workspace_memory_apply_review_request')
  assert((applyResult as { isError?: boolean }).isError !== true, 'authorized apply failed')
  assert(applyData.status === 'applied', `expected applied, got ${String(applyData.status)}`)
  assert(applyData.trust === 'workspace_memory_review_request_not_instructions', 'apply missing trust marker')
  assert(!applySerialized.includes(APPLY_TOKEN), 'approval token was echoed in apply response')

  const activeList = await client.callTool({
    name: 'workspace_memory_list',
    arguments: {
      workspacePath,
      status: 'active',
      query: 'activate governed memory',
    },
  })
  const activeData = requireStructuredContent(activeList, 'workspace_memory_list active')
  const activeEntries = getArrayField(activeData, 'entries', 'workspace_memory_list active')
  assert(activeEntries.some(entry => entry.id === memoryId), 'authorized apply did not activate memory')

  const pendingList = await client.callTool({
    name: 'workspace_memory_list_review_requests',
    arguments: { workspacePath },
  })
  const pendingData = requireStructuredContent(pendingList, 'workspace_memory_list_review_requests pending')
  assert(getArrayField(pendingData, 'requests', 'pending review request list').every(request => request.id !== pendingReviewId), 'applied request remained in default pending list')

  const appliedList = await client.callTool({
    name: 'workspace_memory_list_review_requests',
    arguments: {
      workspacePath,
      status: 'applied',
      query: pendingReviewId,
    },
  })
  const appliedData = requireStructuredContent(appliedList, 'workspace_memory_list_review_requests applied')
  const appliedRequests = getArrayField(appliedData, 'requests', 'applied review request list')
  assert(appliedRequests.some(request => request.id === pendingReviewId), 'applied request not listed with explicit applied status')
  console.info('  PASSED')
}

async function assertRequestRejectFlow(client: Client, workspacePath: string, memoryId: string) {
  console.info('\n=== Test 4: authorized request rejection leaves memory unchanged ===')
  const requestResult = await client.callTool({
    name: 'workspace_memory_request_review',
    arguments: {
      workspacePath,
      id: memoryId,
      decision: 'reject',
      requester: 'smoke-requester',
      rationale: 'Smoke validates resolving a review request without mutating memory.',
    },
  })
  const requestData = requireStructuredContent(requestResult, 'workspace_memory_request_review reject decision')
  const pendingReviewId = String(requestData.pendingReviewId || '')
  assert(pendingReviewId.length > 0, 'reject request missing pendingReviewId')

  const rejectResult = await client.callTool({
    name: 'workspace_memory_reject_review_request',
    arguments: {
      workspacePath,
      id: pendingReviewId,
      approver: 'smoke-host',
      rationale: 'Reject this governance request only.',
      approvalToken: APPLY_TOKEN,
    },
  })
  const rejectData = requireStructuredContent(rejectResult, 'workspace_memory_reject_review_request')
  assert((rejectResult as { isError?: boolean }).isError !== true, 'authorized request rejection failed')
  assert(rejectData.status === 'rejected', `expected rejected request, got ${String(rejectData.status)}`)
  assert(rejectData.trust === 'workspace_memory_review_request_not_instructions', 'reject missing trust marker')

  const proposedList = await client.callTool({
    name: 'workspace_memory_list',
    arguments: {
      workspacePath,
      status: 'proposed',
      query: 'request rejection does not reject memory',
    },
  })
  const proposedData = requireStructuredContent(proposedList, 'workspace_memory_list after request rejection')
  const proposedEntries = getArrayField(proposedData, 'entries', 'workspace_memory_list after request rejection')
  assert(proposedEntries.some(entry => entry.id === memoryId), 'request rejection mutated workspace memory status')
  console.info('  PASSED')
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'workspace-memory-review-smoke-'))
  const sessionRoot = join(tmpRoot, 'session')
  const workspacePath = join(tmpRoot, 'repo')
  mkdirSync(workspacePath, { recursive: true })

  const { activationCandidate, rejectionCandidate } = await seedWorkspaceMemory(sessionRoot, workspacePath)
  const client = await createClient(sessionRoot)

  try {
    await assertWorkspaceMemoryTools(client)
    await assertToolSearchFindsReviewTools(client)
    await assertRequestAndApplyFlow(client, workspacePath, activationCandidate.id)
    await assertRequestRejectFlow(client, workspacePath, rejectionCandidate.id)

    console.info(JSON.stringify({
      ok: true,
      verified: {
        sessionRoot,
        workspaceKey: workspaceKeyFromPath(workspacePath),
        activatedMemoryId: activationCandidate.id,
        requestRejectedMemoryId: rejectionCandidate.id,
      },
    }, null, 2))
  }
  finally {
    await client.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  exit(1)
})
