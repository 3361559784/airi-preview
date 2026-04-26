import type { ArchiveContextStore } from '../archived-context/store'
import type { ExecuteAction } from '../server/action-executor'
import type { ComputerUseServerRuntime } from '../server/runtime'
import type { WorkspaceMemoryStore } from '../workspace-memory/store'
import type { CodingRunnerEventEmitter } from './events'

import { errorMessageFrom } from '@moeru/std'
import { tool as xsaiTool } from '@xsai/tool'
import { z } from 'zod'

import { registerComputerUseTools } from '../server/register-tools'
import { initializeGlobalRegistry } from '../server/tool-descriptors'

const ALLOWED_CODING_TOOLS = [
  'coding_read_file',
  'coding_search_text',
  'coding_search_symbol',
  'coding_find_references',
  'coding_select_target',
  'coding_plan_changes',
  'coding_analyze_impact',
  'coding_validate_hypothesis',
  'coding_diagnose_changes',
  'coding_review_changes',
  'coding_apply_patch',
  'coding_compress_context',
  'coding_report_status',
  'terminal_exec',
  'terminal_get_state',
  'terminal_reset_state',
]

function compactBackend(name: string, structured: any) {
  // Same logic as soak, or simply pass through
  return structured.backendResult || structured
}

export interface BuildXsaiCodingToolsOptions {
  events?: CodingRunnerEventEmitter
  archiveStore?: ArchiveContextStore
  workspaceMemoryStore?: WorkspaceMemoryStore
  runId?: string
}

export async function buildXsaiCodingTools(
  runtime: ComputerUseServerRuntime,
  executeAction: ExecuteAction,
  options: BuildXsaiCodingToolsOptions = {},
) {
  initializeGlobalRegistry()
  const xsaiToolPromises: Promise<any>[] = []

  const mockServer = {
    tool: (...args: any[]) => {
      const name = args[0]
      if (!ALLOWED_CODING_TOOLS.includes(name)) {
        return
      }

      const description = args[1]
      const shape = args[2]
      const handler = args[3]

      xsaiToolPromises.push(xsaiTool({
        name,
        description,
        parameters: z.object(shape),
        execute: async (input: any) => {
          await options.events?.emit('tool_call_started', {
            toolName: name,
            argsSummary: summarizeArgs(input),
          })

          try {
            const mcpResult = await handler(input)
            const textContent = (mcpResult.content || []).map((c: any) => c.text).join('\n')
            const structured = mcpResult.structuredContent || {}
            const status = structured.status || (mcpResult.isError ? 'error' : 'ok')
            const summary = textContent.slice(0, 500)
            const error = mcpResult.isError ? textContent : undefined
            await options.events?.emit('tool_call_completed', {
              toolName: name,
              ok: !mcpResult.isError,
              status,
              summary,
              error,
            })
            return JSON.stringify({
              tool: name,
              args: input,
              ok: !mcpResult.isError,
              status,
              summary,
              error,
              backend: compactBackend(name, structured),
            })
          }
          catch (err: unknown) {
            const msg = errorMessageFrom(err) || String(err)
            await options.events?.emit('tool_call_completed', {
              toolName: name,
              ok: false,
              status: 'exception',
              summary: msg.slice(0, 500),
              error: msg,
            })
            return JSON.stringify({
              tool: name,
              args: input,
              ok: false,
              status: 'exception',
              summary: msg.slice(0, 500),
              error: msg,
            })
          }
        },
      }))
    },
  } as any

  registerComputerUseTools({
    server: mockServer,
    runtime,
    executeAction,
    enableTestTools: false,
  })

  if (options.archiveStore && options.runId) {
    xsaiToolPromises.push(xsaiTool({
      name: 'coding_search_archived_context',
      description: 'Search archived transcript context from this coding run. Use this when earlier details were compacted out of the active prompt.',
      parameters: z.object({
        query: z.string().min(1).describe('Keyword or phrase to search for in archived context.'),
        limit: z.number().int().min(1).max(10).optional().describe('Maximum number of archive hits to return.'),
      }),
      execute: async (input: { query: string, limit?: number }) => {
        return executeInternalTool('coding_search_archived_context', input, options.events, async () => {
          const hits = await options.archiveStore!.search(options.runId!, input.query, input.limit ?? 5)
          return {
            status: 'ok',
            summary: `Found ${hits.length} archived context hit(s).`,
            backend: { hits },
          }
        })
      },
    }))

    xsaiToolPromises.push(xsaiTool({
      name: 'coding_read_archived_context',
      description: 'Read one archived transcript context artifact returned by coding_search_archived_context.',
      parameters: z.object({
        artifactId: z.string().describe('Artifact id returned by coding_search_archived_context, e.g. 10-12-compacted.md.'),
      }),
      execute: async (input: { artifactId: string }) => {
        return executeInternalTool('coding_read_archived_context', input, options.events, async () => {
          const content = await options.archiveStore!.readArtifact(options.runId!, input.artifactId)
          return {
            status: 'ok',
            summary: content.slice(0, 500),
            backend: { artifactId: input.artifactId, content },
          }
        })
      },
    }))
  }

  if (options.workspaceMemoryStore) {
    xsaiToolPromises.push(xsaiTool({
      name: 'coding_search_workspace_memory',
      description: 'Search governed workspace memory. Default search returns only active memory; includeProposed is for reviewing unpromoted proposals.',
      parameters: z.object({
        query: z.string().min(1).describe('Keyword, file path, tag, or phrase to search.'),
        includeProposed: z.boolean().optional().describe('Include proposed, unverified memory entries. Defaults to false.'),
        limit: z.number().int().min(1).max(10).optional().describe('Maximum number of memory hits to return.'),
      }),
      execute: async (input: { query: string, includeProposed?: boolean, limit?: number }) => {
        return executeInternalTool('coding_search_workspace_memory', input, options.events, async () => {
          const hits = options.workspaceMemoryStore!.search(input.query, {
            includeProposed: input.includeProposed,
            limit: input.limit ?? 5,
          })
          return {
            status: 'ok',
            summary: `Found ${hits.length} workspace memory hit(s).`,
            backend: { hits },
          }
        })
      },
    }))

    xsaiToolPromises.push(xsaiTool({
      name: 'coding_read_workspace_memory',
      description: 'Read a governed workspace memory entry by id returned from coding_search_workspace_memory.',
      parameters: z.object({
        id: z.string().min(1).describe('Workspace memory entry id.'),
      }),
      execute: async (input: { id: string }) => {
        return executeInternalTool('coding_read_workspace_memory', input, options.events, async () => {
          const entry = options.workspaceMemoryStore!.read(input.id)
          if (!entry)
            throw new Error(`Workspace memory entry not found: ${input.id}`)
          return {
            status: 'ok',
            summary: entry.statement.slice(0, 500),
            backend: { entry },
          }
        })
      },
    }))

    xsaiToolPromises.push(xsaiTool({
      name: 'coding_propose_workspace_memory',
      description: 'Propose a durable workspace memory entry. Proposals are not injected into prompts until explicitly promoted outside the model loop.',
      parameters: z.object({
        kind: z.enum(['constraint', 'fact', 'pitfall', 'command', 'file_note']),
        statement: z.string().min(1).describe('Concise, stable project knowledge statement.'),
        evidence: z.string().min(1).describe('Concrete evidence for the statement. Avoid speculation.'),
        confidence: z.enum(['low', 'medium', 'high']).optional().describe('Confidence in the statement. Defaults to low.'),
        tags: z.array(z.string()).optional().describe('Search tags.'),
        relatedFiles: z.array(z.string()).optional().describe('Repo-relative related files.'),
      }),
      execute: async (input: {
        kind: 'constraint' | 'fact' | 'pitfall' | 'command' | 'file_note'
        statement: string
        evidence: string
        confidence?: 'low' | 'medium' | 'high'
        tags?: string[]
        relatedFiles?: string[]
      }) => {
        return executeInternalTool('coding_propose_workspace_memory', input, options.events, async () => {
          const entry = await options.workspaceMemoryStore!.propose(input)
          return {
            status: 'proposed',
            summary: `Proposed workspace memory: ${entry.statement}`,
            backend: { entry },
          }
        })
      },
    }))
  }

  return Promise.all(xsaiToolPromises)
}

function summarizeArgs(input: unknown): string {
  try {
    return JSON.stringify(input).slice(0, 500)
  }
  catch {
    return '[unserializable arguments]'
  }
}

async function executeInternalTool(
  name: string,
  input: unknown,
  events: CodingRunnerEventEmitter | undefined,
  handler: () => Promise<{ status: string, summary: string, backend: unknown }>,
): Promise<string> {
  await events?.emit('tool_call_started', {
    toolName: name,
    argsSummary: summarizeArgs(input),
  })

  try {
    const result = await handler()
    await events?.emit('tool_call_completed', {
      toolName: name,
      ok: true,
      status: result.status,
      summary: result.summary,
    })
    return JSON.stringify({
      tool: name,
      args: input,
      ok: true,
      status: result.status,
      summary: result.summary,
      backend: result.backend,
    })
  }
  catch (err) {
    const msg = errorMessageFrom(err) || String(err)
    await events?.emit('tool_call_completed', {
      toolName: name,
      ok: false,
      status: 'exception',
      summary: msg.slice(0, 500),
      error: msg,
    })
    return JSON.stringify({
      tool: name,
      args: input,
      ok: false,
      status: 'exception',
      summary: msg.slice(0, 500),
      error: msg,
    })
  }
}
