import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ActionInvocation } from '../types'
import type { ExecuteAction } from './action-executor'
import type { ComputerUseServerRuntime } from './runtime'

import { exec as execCallback } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { CodingPrimitives } from '../coding/primitives'
import { RunStateManager } from '../state'
import {
  createDisplayInfo,
  createLocalExecutionTarget,
  createTerminalState,
  createTestConfig,
} from '../test-fixtures'
import { registerComputerUseTools } from './register-tools'
import { createRuntimeCoordinator } from './runtime-coordinator'
import { initializeGlobalRegistry } from './tool-descriptors'

const execAsync = promisify(execCallback)

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>

type SoakScenario
  = | 'existing_file_recovery_success'
    | 'existing_file_recovery_fail_blocked'
    | 'fake_completion_denial_success'
    | 'fake_completion_denial_fail'
    | 'stalled_analysis_warning'
    | 'stalled_analysis_hard_stop'

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
  }
}

function success(action: ActionInvocation, backendResult: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: `${action.kind} ok` }],
    structuredContent: {
      status: 'executed',
      action: action.kind,
      backendResult,
    },
  }
}

function failure(action: ActionInvocation, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: {
      status: 'failed',
      action: action.kind,
      error: message,
    },
  }
}

function createRuntime(): ComputerUseServerRuntime {
  const base = {
    config: createTestConfig({ approvalMode: 'never' }),
    stateManager: new RunStateManager(),
    session: {
      createPendingAction: () => ({ id: 'approval_1' }),
      getPendingAction: () => undefined,
      listPendingActions: () => [],
      removePendingAction: () => {},
      record: async () => undefined,
      getBudgetState: () => ({ operationsExecuted: 0, operationUnitsConsumed: 0 }),
      getLastScreenshot: () => undefined,
      getSnapshot: () => ({ operationsExecuted: 0, operationUnitsConsumed: 0, pendingActions: [] }),
    },
    executor: {
      getExecutionTarget: async () => createLocalExecutionTarget(),
      getForegroundContext: async () => ({ available: false, platform: 'darwin' as const }),
      getDisplayInfo: async () => createDisplayInfo({ platform: 'darwin' }),
      getPermissionInfo: async () => ({}),
      describe: () => ({ kind: 'dry-run', notes: [] }),
    },
    terminalRunner: {
      getState: () => createTerminalState(),
      describe: () => ({ kind: 'local-shell-runner', notes: [] }),
    },
    browserDomBridge: {
      getStatus: () => ({ enabled: false, connected: false, host: '127.0.0.1', port: 8765, pendingRequests: 0 }),
    },
    cdpBridgeManager: {
      probeAvailability: async () => ({ endpoint: 'http://localhost:9222', connected: false, connectable: false }),
    },
    taskMemory: {},
  } as unknown as ComputerUseServerRuntime
  base.coordinator = createRuntimeCoordinator(base)
  return base
}

async function createWorkspaceFixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'airi-governor-soak-'))

  await writeFile(
    join(workspace, 'index.ts'),
    'export const count = 0\nexport const step = 1\n',
    'utf8',
  )
  return workspace
}

function buildExecuteAction(
  runtime: ComputerUseServerRuntime,
  scenario: SoakScenario,
  stateOverride: Record<string, any>,
): ExecuteAction {
  let patchAttempts = 0
  let readAttempts = 0

  return async (action) => {
    const primitives = new CodingPrimitives(runtime)

    try {
      switch (action.kind) {
        case 'coding_report_status': {
          const result = await primitives.reportStatus(
            action.input.status,
            action.input.summary,
            action.input.filesTouched,
            action.input.commandsRun,
            action.input.checks,
            action.input.nextStep,
          )
          return success(action, result as Record<string, unknown>)
        }
        case 'coding_apply_patch': {
          patchAttempts++

          if (scenario === 'existing_file_recovery_success') {
            if (patchAttempts === 1) {
              const errMsg = `oldString not found in file exactly as provided. Please check for formatting differences or use coding_read_file to get the exact string.\n\nHint: I found a visually similar block in the file. Did you mean to replace exactly this segment?\n\n<exact_match>\nexport const count = 0\n</exact_match>\n\n`
              return failure(action, errMsg)
            }
            // Second try success
            const summary = await primitives.applyPatch(action.input.filePath, 'export const count = 0', 'export const count = 1')
            return success(action, { summary })
          }

          if (scenario === 'existing_file_recovery_fail_blocked') {
            if (patchAttempts <= 2) {
              return failure(action, `oldString not found in file exactly as provided.`)
            }
            // Simulated behavior: model reports blocked
            const codingState = runtime.stateManager.getState().coding
            runtime.stateManager.updateCodingState({
              recentEdits: codingState?.recentEdits || [],
            })
            return failure(action, 'Failed multiple times')
          }

          if (scenario === 'fake_completion_denial_success') {
            // we simulate a valid patch but omitted touched files, or no patch.
            // the failure corpus testing calls report status directly to test gates.
          }

          const summary = await primitives.applyPatch(action.input.filePath, action.input.oldString, action.input.newString)
          return success(action, { summary })
        }
        case 'coding_read_file': {
          readAttempts++
          const content = await primitives.readFile(action.input.filePath, action.input.startLine, action.input.endLine)
          return success(action, { content })
        }
        // ... pass through all other commands naturally ...
        // Using same mock proxy as in primitives tests
        default:
          return success(action, { note: 'mock passed through' })
      }
    }
    catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('McpError: Completion Denied')) {
          return failure(action, error.message)
        }
        if (error.message.includes('ANALYSIS LIMIT WARNING')) {
          return failure(action, error.message)
        }
        if (error.message.includes('ANALYSIS LIMIT EXCEEDED')) {
          return failure(action, error.message)
        }
      }
      return failure(action, error instanceof Error ? error.message : String(error))
    }
  }
}

async function runScenario(scenario: SoakScenario) {
  initializeGlobalRegistry()
  const runtime = createRuntime()
  const workspace = await createWorkspaceFixture()
  const { server, invoke } = createMockServer()
  const stateOverride = {}

  registerComputerUseTools({
    server,
    runtime,
    executeAction: buildExecuteAction(runtime, scenario, stateOverride),
    enableTestTools: false,
  })

  return {
    workspace,
    runtime,
    invoke,
    primitives: new CodingPrimitives(runtime),
  }
}

describe('workflow_coding governor soak determinisitic', () => {
  // 1. Existing-file edit failure recovery
  describe('s1: Existing-file edit failure recovery', () => {
    it('1.1 recovers successfully after first patch fails', async () => {
      const { invoke, primitives, runtime, workspace } = await runScenario('existing_file_recovery_success')
      runtime.stateManager.updateCodingState({ workspacePath: workspace })

      const act1 = await invoke('coding_apply_patch', {
        filePath: 'index.ts',
        oldString: 'export count = 0', // wrong
        newString: 'export count = 1',
      })
      expect(act1.isError).toBe(true)
      expect((act1.content[0] as any).text).toContain('<exact_match>')

      const act2 = await invoke('coding_apply_patch', {
        filePath: 'index.ts',
        oldString: 'export count = 0', // second try override handled by mock
        newString: 'export count = 1',
      })
      expect(act2.isError).toBeFalsy()
      const edit = runtime.stateManager.getState().coding?.recentEdits?.at(-1)
      expect(edit?.mutationProof?.readbackVerified).toBe(true)
    })

    it('1.2 gives up after consecutive bad guesses', async () => {
      const { invoke } = await runScenario('existing_file_recovery_fail_blocked')

      const act1 = await invoke('coding_apply_patch', { filePath: 'index.ts', oldString: 'x', newString: 'y' })
      const act2 = await invoke('coding_apply_patch', { filePath: 'index.ts', oldString: 'y', newString: 'x' })
      const act3 = await invoke('coding_apply_patch', { filePath: 'index.ts', oldString: 'z', newString: 'a' })

      expect(act1.isError).toBe(true)
      expect(act2.isError).toBe(true)
      expect(act3.isError).toBe(true)
    })
  })

  // 2. Fake-completion denial
  describe('s2: Fake-completion denial', () => {
    it('2.1 denies completion without proof and model goes back to in_progress', async () => {
      const { invoke, runtime } = await runScenario('fake_completion_denial_success')
      runtime.stateManager.updateCodingState({
        currentPlanSession: { id: 's1', steps: [], reason: '', changeIntent: 'behavior_fix' } as any,
      })

      await expect(invoke('coding_report_status', {
        status: 'completed',
        filesTouched: ['index.ts'],
        summary: 'done',
      })).rejects.toThrowError('Completion Denied')

      // Mock reaction: switch to in_progress
      const act2 = await invoke('coding_report_status', {
        status: 'in_progress',
        filesTouched: [],
        nextStep: 'let me fix it',
      })
      expect(act2.isError).toBeFalsy()
    })

    it('2.2 denies empty filesTouched when intent is mutating', async () => {
      const { invoke, runtime } = await runScenario('fake_completion_denial_success')
      runtime.stateManager.updateCodingState({
        currentPlanSession: { id: 's2', steps: [], reason: '', changeIntent: 'refactor' } as any,
      })

      await expect(invoke('coding_report_status', {
        status: 'completed',
        filesTouched: [],
        summary: 'done', // "no files touched" -> caught by gate
      })).rejects.toThrowError('Completion Denied')
    })
  })

  // 3. Stalled analysis cutoff
  describe('s3: Stalled analysis cutoff', () => {
    it('3.1 fires Warning threshold at 8 then Hard Stop at 10', async () => {
      const { invoke, runtime, workspace } = await runScenario('stalled_analysis_warning')
      runtime.stateManager.updateCodingState({ workspacePath: workspace })

      for (let i = 0; i < 7; i++) {
        const act = await invoke('coding_read_file', { filePath: 'index.ts' })
        expect(act.isError).toBeFalsy()
      }

      await expect(invoke('coding_read_file', { filePath: 'index.ts' })).rejects.toThrowError('ANALYSIS LIMIT WARNING')

      await expect(invoke('coding_read_file', { filePath: 'index.ts' })).rejects.toThrowError('ANALYSIS LIMIT WARNING')
      await expect(invoke('coding_read_file', { filePath: 'index.ts' })).rejects.toThrowError('ANALYSIS LIMIT EXCEEDED')
    })

    it('3.2 correctly resets threshold when patch state advances', async () => {
      const { invoke, runtime, workspace } = await runScenario('stalled_analysis_warning')
      runtime.stateManager.updateCodingState({ workspacePath: workspace })

      for (let i = 0; i < 7; i++) {
        await invoke('coding_read_file', { filePath: 'index.ts' })
      }

      // Patch resets the counter
      await invoke('coding_apply_patch', {
        filePath: 'index.ts',
        oldString: 'export const count = 0',
        newString: 'export const count = 1',
      })

      const act8 = await invoke('coding_read_file', { filePath: 'index.ts' })
      expect(act8.isError).toBeFalsy() // should not throw warning because it was reset
    })
  })
})
