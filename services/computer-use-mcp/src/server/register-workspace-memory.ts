import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { WorkspaceMemoryEntry, WorkspaceMemoryStatus } from '../workspace-memory/types'
import type { ComputerUseServerRuntime } from './runtime'

import { join } from 'node:path'

import { z } from 'zod'

import { WorkspaceMemoryReviewRequestStore } from '../workspace-memory/review-request-store'
import { workspaceKeyFromPath, WorkspaceMemoryStore } from '../workspace-memory/store'
import { textContent } from './content'
import { registerToolWithDescriptor, requireDescriptor } from './tool-descriptors'

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 50
const EVIDENCE_EXCERPT_MAX_CHARS = 500
const TRUST_BOUNDARY = 'governed_workspace_memory_not_instructions'
const REVIEW_REQUEST_TRUST_BOUNDARY = 'workspace_memory_review_request_not_instructions'
const WHITESPACE_RE = /\s+/g

const statusFilterSchema = z.enum(['proposed', 'active', 'rejected', 'all'])
const reviewDecisionSchema = z.enum(['activate', 'reject'])

/**
 * Register external workspace-memory review tools.
 *
 * These tools intentionally live outside the coding-runner xsai tool loop:
 * they expose a read-only review surface for MCP clients without giving the
 * coding model an automatic promotion/rejection tool.
 */
export function registerWorkspaceMemoryTools(server: McpServer, runtime: ComputerUseServerRuntime) {
  registerToolWithDescriptor(server, {
    descriptor: requireDescriptor('workspace_memory_list'),
    schema: {
      workspacePath: z.string().min(1).describe('Absolute path to the workspace root whose memory file should be reviewed.'),
      status: statusFilterSchema.optional().describe('Status filter. Defaults to proposed entries for review.'),
      query: z.string().optional().describe('Optional case-insensitive query matched against entry fields.'),
      limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Maximum number of entries to return. Default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}.`),
    },
    handler: async ({ workspacePath, status, query, limit }) => {
      const store = await openWorkspaceMemoryStore(runtime, workspacePath)
      const statusFilter = status ?? 'proposed'
      const entries = filterWorkspaceMemoryEntries(store.getAll(), {
        status: statusFilter,
        query,
        limit,
      })

      return {
        content: [textContent(`Found ${entries.length} workspace memory entr${entries.length === 1 ? 'y' : 'ies'} for ${statusFilter} review.`)],
        structuredContent: {
          status: 'ok',
          trust: TRUST_BOUNDARY,
          workspaceKey: workspaceKeyFromPath(workspacePath),
          statusFilter,
          entries: entries.map(toWorkspaceMemorySummary),
        },
      }
    },
  })

  registerToolWithDescriptor(server, {
    descriptor: requireDescriptor('workspace_memory_read'),
    schema: {
      workspacePath: z.string().min(1).describe('Absolute path to the workspace root whose memory file should be reviewed.'),
      id: z.string().min(1).describe('Workspace memory entry id returned by workspace_memory_list.'),
    },
    handler: async ({ workspacePath, id }) => {
      const store = await openWorkspaceMemoryStore(runtime, workspacePath)
      const entry = store.read(id)
      if (!entry)
        return workspaceMemoryError(`Workspace memory entry not found: ${id}`, workspacePath)

      return {
        content: [textContent(`Read workspace memory ${id} as governed review data, not executable instructions.`)],
        structuredContent: {
          status: 'ok',
          trust: TRUST_BOUNDARY,
          workspaceKey: workspaceKeyFromPath(workspacePath),
          entry: toWorkspaceMemoryPublicEntry(entry),
        },
      }
    },
  })

  registerToolWithDescriptor(server, {
    descriptor: requireDescriptor('workspace_memory_request_review'),
    schema: {
      workspacePath: z.string().min(1).describe('Absolute path to the workspace root whose memory entry should be reviewed.'),
      id: z.string().min(1).describe('Workspace memory entry id returned by workspace_memory_list or workspace_memory_read.'),
      decision: reviewDecisionSchema.describe('Requested governance decision. This creates a pending request only; it does not activate or reject memory.'),
      requester: z.string().min(1).describe('External requester identity for the pending review request.'),
      rationale: z.string().min(1).describe('Concrete rationale for why this review request should be approved later.'),
    },
    handler: async ({ workspacePath, id, decision, requester, rationale }) => {
      const memoryStore = await openWorkspaceMemoryStore(runtime, workspacePath)
      const requestStore = await openWorkspaceMemoryReviewRequestStore(runtime, workspacePath)

      try {
        const request = await requestStore.request({
          memoryId: id,
          decision,
          requester,
          rationale,
        }, memoryStore.read(id))

        return {
          content: [textContent(`Workspace memory review request created. Pending review id: ${request.id}. No memory status was changed.`)],
          structuredContent: {
            status: 'approval_required',
            trust: REVIEW_REQUEST_TRUST_BOUNDARY,
            workspaceKey: workspaceKeyFromPath(workspacePath),
            pendingReviewId: request.id,
            request,
          },
        }
      }
      catch (error) {
        return workspaceMemoryReviewRequestError(error instanceof Error ? error.message : String(error), workspacePath)
      }
    },
  })

  registerToolWithDescriptor(server, {
    descriptor: requireDescriptor('workspace_memory_list_review_requests'),
    schema: {
      workspacePath: z.string().min(1).describe('Absolute path to the workspace root whose pending memory review requests should be listed.'),
      query: z.string().optional().describe('Optional case-insensitive query matched against request fields.'),
      limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Maximum number of requests to return. Default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}.`),
    },
    handler: async ({ workspacePath, query, limit }) => {
      const requestStore = await openWorkspaceMemoryReviewRequestStore(runtime, workspacePath)
      const requests = requestStore.list({ query, limit })

      return {
        content: [textContent(`Found ${requests.length} pending workspace memory review request${requests.length === 1 ? '' : 's'}.`)],
        structuredContent: {
          status: 'ok',
          trust: REVIEW_REQUEST_TRUST_BOUNDARY,
          workspaceKey: workspaceKeyFromPath(workspacePath),
          requests,
        },
      }
    },
  })

  registerToolWithDescriptor(server, {
    descriptor: requireDescriptor('workspace_memory_read_review_request'),
    schema: {
      workspacePath: z.string().min(1).describe('Absolute path to the workspace root whose pending memory review request should be read.'),
      id: z.string().min(1).describe('Pending review request id returned by workspace_memory_request_review or workspace_memory_list_review_requests.'),
    },
    handler: async ({ workspacePath, id }) => {
      const requestStore = await openWorkspaceMemoryReviewRequestStore(runtime, workspacePath)
      const request = requestStore.read(id)
      if (!request)
        return workspaceMemoryReviewRequestError(`Workspace memory review request not found: ${id}`, workspacePath)

      return {
        content: [textContent(`Read workspace memory review request ${id} as governance data, not executable instructions.`)],
        structuredContent: {
          status: 'ok',
          trust: REVIEW_REQUEST_TRUST_BOUNDARY,
          workspaceKey: workspaceKeyFromPath(workspacePath),
          request,
        },
      }
    },
  })
}

async function openWorkspaceMemoryStore(runtime: ComputerUseServerRuntime, workspacePath: string): Promise<WorkspaceMemoryStore> {
  const workspaceKey = workspaceKeyFromPath(workspacePath)
  const store = new WorkspaceMemoryStore(
    join(runtime.config.sessionRoot, 'workspace-memory', `${workspaceKey}.jsonl`),
    { workspacePath, sourceRunId: 'mcp_workspace_memory_review_surface' },
  )
  await store.init()
  return store
}

async function openWorkspaceMemoryReviewRequestStore(runtime: ComputerUseServerRuntime, workspacePath: string): Promise<WorkspaceMemoryReviewRequestStore> {
  const workspaceKey = workspaceKeyFromPath(workspacePath)
  const store = new WorkspaceMemoryReviewRequestStore(
    join(runtime.config.sessionRoot, 'workspace-memory-review-requests', `${workspaceKey}.jsonl`),
    { workspacePath },
  )
  await store.init()
  return store
}

function filterWorkspaceMemoryEntries(
  entries: readonly WorkspaceMemoryEntry[],
  options: { status: WorkspaceMemoryStatus | 'all', query?: string, limit?: number },
): WorkspaceMemoryEntry[] {
  const normalizedQuery = options.query?.replace(WHITESPACE_RE, ' ').trim().toLowerCase()
  const limit = normalizeListLimit(options.limit)

  return entries
    .filter(entry => options.status === 'all' || entry.status === options.status)
    .filter(entry => !normalizedQuery || workspaceMemoryEntryHaystack(entry).includes(normalizedQuery))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined)
    return DEFAULT_LIST_LIMIT
  if (!Number.isFinite(limit))
    return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)))
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

function toWorkspaceMemorySummary(entry: WorkspaceMemoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    status: entry.status,
    kind: entry.kind,
    statement: entry.statement,
    evidenceExcerpt: entry.evidence.slice(0, EVIDENCE_EXCERPT_MAX_CHARS),
    confidence: entry.confidence,
    tags: entry.tags,
    relatedFiles: entry.relatedFiles,
    humanVerified: entry.humanVerified,
    review: entry.review,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

function toWorkspaceMemoryPublicEntry(entry: WorkspaceMemoryEntry): Record<string, unknown> {
  return {
    ...toWorkspaceMemorySummary(entry),
    evidence: entry.evidence,
    sourceRunId: entry.sourceRunId,
    source: entry.source,
  }
}

function workspaceMemoryError(message: string, workspacePath: string) {
  return {
    isError: true,
    content: [textContent(`Workspace memory request failed: ${message}`)],
    structuredContent: {
      status: 'error',
      trust: TRUST_BOUNDARY,
      workspaceKey: workspaceKeyFromPath(workspacePath),
      error: message,
    },
  }
}

function workspaceMemoryReviewRequestError(message: string, workspacePath: string) {
  return {
    isError: true,
    content: [textContent(`Workspace memory review request failed: ${message}`)],
    structuredContent: {
      status: 'error',
      trust: REVIEW_REQUEST_TRUST_BOUNDARY,
      workspaceKey: workspaceKeyFromPath(workspacePath),
      error: message,
    },
  }
}
