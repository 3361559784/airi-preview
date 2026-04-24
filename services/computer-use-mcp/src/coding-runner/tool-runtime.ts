import type { ExecuteAction } from '../server/action-executor'
import type { ComputerUseServerRuntime } from '../server/runtime'

import { tool as xsaiTool } from '@xsai/tool'
import { z } from 'zod'

import { registerComputerUseTools } from '../server/register-tools'
import { initializeGlobalRegistry } from '../server/tool-descriptors'

const ALLOWED_CODING_TOOLS = [
  'coding_review_workspace',
  'coding_read_file',
  'coding_search_text',
  'coding_search_symbol',
  'coding_find_references',
  'coding_select_target',
  'coding_plan_changes',
  'coding_analyze_impact',
  'coding_validate_hypothesis',
  'coding_diagnose_changes',
  'coding_capture_validation_baseline',
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

export async function buildXsaiCodingTools(
  runtime: ComputerUseServerRuntime,
  executeAction: ExecuteAction
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
          try {
            const mcpResult = await handler(input)
            const textContent = (mcpResult.content || []).map((c: any) => c.text).join('\n')
            const structured = mcpResult.structuredContent || {}
            return JSON.stringify({
              tool: name,
              args: input,
              ok: !mcpResult.isError,
              status: structured.status || (mcpResult.isError ? 'error' : 'ok'),
              summary: textContent.slice(0, 500),
              error: mcpResult.isError ? textContent : undefined,
              backend: compactBackend(name, structured),
            })
          }
          catch (err: any) {
            const msg = err instanceof Error ? err.message : String(err)
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

  return Promise.all(xsaiToolPromises)
}
