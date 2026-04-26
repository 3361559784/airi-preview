import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ActionInvocation } from '../types'
import type { ExecuteAction } from './action-executor'
import type { ComputerUseServerRuntime } from './runtime'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as xsaiGenerate from '@xsai/generate-text'
import * as xsaiTool from '@xsai/tool'

import { RunStateManager } from '../state'
import { TaskMemoryManager } from '../task-memory/manager'
import {
  createDisplayInfo,
  createLocalExecutionTarget,
  createTerminalState,
  createTestConfig,
} from '../test-fixtures'
import { registerComputerUseTools } from './register-tools'
import { createRuntimeCoordinator } from './runtime-coordinator'

vi.mock('@xsai/generate-text', async () => {
  const actual = await vi.importActual<typeof import('@xsai/generate-text')>('@xsai/generate-text')
  return {
    ...actual,
    generateText: vi.fn(),
  }
})

vi.mock('@xsai/tool', async () => {
  const actual = await vi.importActual<typeof import('@xsai/tool')>('@xsai/tool')
  return {
    ...actual,
    tool: vi.fn(),
  }
})

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

function createMockServer() {
  const handlers = new Map<string, ToolHandler>()

  return {
    server: {
      tool(...args: unknown[]) {
        const name = args[0] as string
        const handler = args.at(-1) as ToolHandler
        handlers.set(name, handler)
      },
    } as unknown as McpServer,
    async invoke(name: string, args: Record<string, unknown> = {}) {
      const handler = handlers.get(name)
      if (!handler) {
        throw new Error(`Missing registered tool: ${name}`)
      }

      return await handler(args)
    },
    hasTool(name: string) {
      return handlers.has(name)
    },
  }
}

function makeExecutedResult(action: ActionInvocation): CallToolResult {
  return {
    isError: false,
    content: [{ type: 'text', text: `${action.kind} ok` }],
    structuredContent: {
      status: 'executed',
      action: action.kind,
      backendResult: {},
    },
  }
}

describe('registerComputerUseTools: workflow_coding_runner', () => {
  let runtime: ComputerUseServerRuntime

  beforeEach(() => {
    runtime = {
      config: createTestConfig({ approvalMode: 'never' }),
      stateManager: new RunStateManager(),
      session: {
        createPendingAction: vi.fn(),
        getPendingAction: vi.fn(),
        listPendingActions: vi.fn(() => []),
        removePendingAction: vi.fn(),
        record: vi.fn().mockResolvedValue(undefined),
        getBudgetState: vi.fn(() => ({ operationsExecuted: 0, operationUnitsConsumed: 0 })),
        getLastScreenshot: vi.fn(() => undefined),
        getSnapshot: vi.fn(() => ({ operationsExecuted: 0, operationUnitsConsumed: 0, pendingActions: [] })),
        getRecentTrace: vi.fn(() => []),
      },
      executor: {
        getExecutionTarget: vi.fn().mockResolvedValue(createLocalExecutionTarget()),
        getForegroundContext: vi.fn().mockResolvedValue({ available: false, platform: 'darwin' }),
        getDisplayInfo: vi.fn().mockResolvedValue(createDisplayInfo({ platform: 'darwin' })),
        getPermissionInfo: vi.fn().mockResolvedValue({}),
        describe: vi.fn(() => ({ kind: 'dry-run', notes: [] })),
      },
      terminalRunner: {
        getState: vi.fn(() => createTerminalState()),
        describe: vi.fn(() => ({ kind: 'local-shell-runner', notes: [] })),
      },
      browserDomBridge: {
        getStatus: vi.fn(() => ({
          enabled: false,
          connected: false,
          host: '127.0.0.1',
          port: 8765,
          pendingRequests: 0,
        })),
      },
      cdpBridgeManager: {
        probeAvailability: vi.fn().mockResolvedValue({
          endpoint: 'http://localhost:9222',
          connected: false,
          connectable: false,
        }),
      },
      taskMemory: new TaskMemoryManager(),
    } as unknown as ComputerUseServerRuntime
    runtime.coordinator = createRuntimeCoordinator(runtime)

    vi.mocked(xsaiGenerate.generateText).mockReset()
    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => ({
      messages: [
        ...opts.messages,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_123',
            function: { name: 'coding_report_status', arguments: '{"status":"completed"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: JSON.stringify({ tool: 'coding_report_status', args: { status: 'completed' }, ok: true, status: 'completed' }),
        },
      ],
    }) as any)

    vi.mocked(xsaiTool.tool).mockReset()
    vi.mocked(xsaiTool.tool).mockImplementation((def: any) => Promise.resolve(def))
  })

  it('registers workflow_coding_runner as a parallel experimental tool', async () => {
    const executeAction = vi.fn<ExecuteAction>(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, hasTool } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    expect(hasTool('workflow_coding_runner')).toBe(true)
  })

  it('smoke test: executes workflow_coding_runner preflights and runs LLM loop gracefully', async () => {
    const executeAction = vi.fn<ExecuteAction>(async (action: ActionInvocation) => makeExecutedResult(action))
    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    const result = await invoke('workflow_coding_runner', {
      workspacePath: '/tmp/project',
      taskGoal: 'Refactor test',
    })

    expect(result.isError).toBe(false)
    const structured = result.structuredContent as Record<string, any>

    // Returns structural values
    expect(structured.status).toBe('completed')
    expect(structured.totalSteps).toBeGreaterThanOrEqual(1)
    expect(structured.turnsLogLength).toBeGreaterThanOrEqual(1)

    // Check executeAction array
    const actionKinds = executeAction.mock.calls.map(call => call[0].kind)
    expect(actionKinds[0]).toBe('coding_review_workspace')
    expect(actionKinds[1]).toBe('coding_capture_validation_baseline')

    expect(executeAction.mock.calls[0][0]).toMatchObject({
      kind: 'coding_review_workspace',
      input: { workspacePath: '/tmp/project' },
    })
    expect(executeAction.mock.calls[0][1]).toBe('coding_review_workspace')

    expect(executeAction.mock.calls[1][0]).toMatchObject({
      kind: 'coding_capture_validation_baseline',
      input: { workspacePath: '/tmp/project', createTemporaryWorktree: true },
    })
    expect(executeAction.mock.calls[1][1]).toBe('coding_capture_validation_baseline')
  })

  it('smoke test: aborts fast when coding_review_workspace bootstrap fails', async () => {
    const executeAction = vi.fn<ExecuteAction>(async (action: ActionInvocation) => {
      if (action.kind === 'coding_review_workspace') {
        return { isError: true, content: [{ type: 'text', text: 'workspace error mocked' }] }
      }
      return makeExecutedResult(action)
    })

    const { server, invoke } = createMockServer()

    registerComputerUseTools({
      server,
      runtime,
      executeAction,
      enableTestTools: false,
    })

    const result = await invoke('workflow_coding_runner', {
      workspacePath: '/tmp/project',
      taskGoal: 'Refactor test',
    })

    expect(result.isError).toBe(true)
    const structured = result.structuredContent as Record<string, any>
    expect(structured.status).toBe('failed')
    expect(structured.totalSteps).toBe(0)
    expect(structured.lastError).toContain('workspace error mocked')
  })
})
