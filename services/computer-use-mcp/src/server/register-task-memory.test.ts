import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { describe, expect, it, vi } from 'vitest'

import { TaskMemoryManager } from '../task-memory/manager'
import { registerTaskMemoryTools } from './register-task-memory'

type ToolHandler = (input: Record<string, unknown>) => Promise<CallToolResult>

function createMockServer() {
  const handlers = new Map<string, ToolHandler>()

  return {
    server: {
      tool(...args: unknown[]) {
        const name = args[0] as string
        const handler = args.at(-1) as ToolHandler
        handlers.set(name, handler)
        return { disable: vi.fn() }
      },
    } as unknown as McpServer,
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
      const handler = handlers.get(name)
      if (!handler)
        throw new Error(`Tool not registered: ${name}`)

      return await handler(args)
    },
  }
}

function createMockRuntime() {
  return {
    taskMemory: new TaskMemoryManager(),
    stateManager: {
      updateTaskMemory: vi.fn(),
      clearTaskMemory: vi.fn(),
    },
  } as any
}

describe('registerTaskMemoryTools', () => {
  it('does not expose internal evidencePins in structured task memory results', async () => {
    const { server, invoke } = createMockServer()
    const runtime = createMockRuntime()

    registerTaskMemoryTools(server, runtime)

    runtime.taskMemory.update({
      goal: 'Internal evidence run',
      evidencePins: ['tool_failure:coding_apply_patch: PATCH_MISMATCH'],
    }, { sourceTurnId: 'runner:pin', sourceTurnIndex: 1 })

    const getResult = await invoke('task_memory_get')
    expect(getResult.structuredContent).toMatchObject({ goal: 'Internal evidence run' })
    expect(getResult.structuredContent).not.toHaveProperty('evidencePins')

    const updateResult = await invoke('task_memory_update', {
      status: 'active',
      currentStep: 'continue',
      sourceTurnId: 'manual:update',
      sourceTurnIndex: 2,
    })
    expect(updateResult.structuredContent).toMatchObject({ currentStep: 'continue' })
    expect(updateResult.structuredContent).not.toHaveProperty('evidencePins')
  })
})
