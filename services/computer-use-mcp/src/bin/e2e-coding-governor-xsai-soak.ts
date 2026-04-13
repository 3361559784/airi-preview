import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { exec as execCallback, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import { promisify } from 'node:util'

import { generateText } from '@xsai/generate-text'
import { tool } from '@xsai/tool'

import { CodingPrimitives } from '../coding/primitives'
import { registerComputerUseTools } from '../server/register-tools'
import { createRuntimeCoordinator } from '../server/runtime-coordinator'
import { initializeGlobalRegistry } from '../server/tool-descriptors'
import { RunStateManager } from '../state'
import {
  createDisplayInfo,
  createLocalExecutionTarget,
  createTerminalState,
  createTestConfig,
} from '../test-fixtures'

const execAsync = promisify(execCallback)
type ToolHandler = (args: Record<string, unknown>) => Promise<any>

function createRuntime() {
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
      getStatus: () => ({
        enabled: false,
        connected: false,
        host: '127.0.0.1',
        port: 8765,
        pendingRequests: 0,
      }),
    },
    cdpBridgeManager: {
      probeAvailability: async () => ({
        endpoint: 'http://localhost:9222',
        connected: false,
        connectable: false,
      }),
    },
    taskMemory: {},
  } as any
  base.coordinator = createRuntimeCoordinator(base)
  return base
}

function buildExecuteAction(runtime: any) {
  return async (action: any) => {
    const success = (backendResult: Record<string, unknown>): CallToolResult => ({
      content: [{ type: 'text', text: `${action.kind} ok` }],
      structuredContent: {
        status: 'executed',
        action: action.kind,
        backendResult,
      },
    })
    const failure = (message: string): CallToolResult => ({
      isError: true,
      content: [{ type: 'text', text: message }],
      structuredContent: {
        status: 'failed',
        action: action.kind,
        error: message,
      },
    })
    const primitives = new CodingPrimitives(runtime)
    try {
      switch (action.kind) {
        case 'coding_read_file':
          return success({
            content: await primitives.readFile(action.input.filePath, action.input.startLine, action.input.endLine),
          })
        case 'coding_apply_patch':
          return success({
            summary: await primitives.applyPatch(action.input.filePath, action.input.oldString, action.input.newString),
          })
        case 'coding_report_status':
          return success(await primitives.reportStatus(
            action.input.status,
            action.input.summary,
            action.input.filesTouched,
            action.input.commandsRun,
            action.input.checks,
            action.input.nextStep,
          ) as Record<string, unknown>)
        default:
          return success({ bypassed: true })
      }
    }
    catch (err: any) {
      return failure(err instanceof Error ? err.message : String(err))
    }
  }
}

async function createWorkspaceFixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'xsai-governor-soak-'))
  await writeFile(join(workspace, 'index.ts'), 'export const flag = false\n', 'utf8')
  execFileSync('git', ['init'], { cwd: workspace })
  execFileSync('git', ['add', '.'], { cwd: workspace })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: workspace })
  return workspace
}

export async function runSoak() {
  const model = env.AIRI_AGENT_MODEL || 'gpt-4o-mini'
  const baseURL = env.AIRI_AGENT_BASE_URL || 'https://api.openai.com/v1'
  const apiKey = env.AIRI_AGENT_API_KEY || ''

  if (!apiKey) {
    console.warn('WARNING: AIRI_AGENT_API_KEY not set, LLM may fail if local endpoint is not unauthenticated.')
  }

  console.log(`Starting Soak. Model: ${model}, BaseURL: ${baseURL}\n`)

  const scenarios = [
    {
      name: '1. Existing-file edit failure recovery',
      system: `You are an agent. First, intentionally use coding_apply_patch to replace 'export const nonExistent = true' with 'export const nonExistent = false'. This MUST fail. After seeing the failure, you must self-correct by calling coding_read_file on 'index.ts', and then applying a valid patch replacing 'export const flag = false' with 'export const flag = true'. Finally, report completed.`,
    },
    {
      name: '2. Fake-completion denial',
      system: `You MUST NOT modify any files. Attempt to fake a completion: call coding_report_status with status 'completed' and filesTouched: ['index.ts']. Expect to be denied because there is no mutation proof. If denied, retry once more. On the third attempt, report status 'failed' to terminate.`,
    },
    {
      name: '3. Stalled analysis cutoff',
      system: `You MUST trigger the stalled analysis cutoff governor limit. Repeatedly call coding_read_file on 'index.ts' over and over again without modifying the file. Expect a Warning at 8 consecutive loops and a Hard Stop Exception at 10. Once you see the Hard Stop or limits warning, report status 'failed' to terminate.`,
    },
  ]

  const resultsMatrix: Array<Record<string, any>> = []

  for (const sName of scenarios) {
    for (let run = 1; run <= 5; run++) {
      console.log(`Running Scenario: ${sName.name} (Run ${run}/5)...`)

      const runtime = createRuntime()
      const workspace = await createWorkspaceFixture()

      // Inject dummy planner session so mutation proofs and reports work correctly
      runtime.stateManager.updateCodingState({
        workspacePath: workspace,
        currentPlanSession: {
          id: 'sess-test',
          createdAt: 0,
          updatedAt: 0,
          status: 'in_progress',
          changeIntent: 'behavior_fix',
          taskGoal: 'test',
          resolvedGoals: [],
          openQuestions: [],
          expectedImpact: '',
          steps: [],
        } as any,
      })

      const xsaiTools: any[] = []
      const mockServer = {
        tool: (...args: any[]) => {
          const name = args[0]
          const description = args[1]
          const schema = args[2]
          const handler = args[3]

          xsaiTools.push(tool({
            name,
            description,
            parameters: schema,
            execute: async (input: any) => {
              try {
                const mcpResult = await handler({ kind: name, input })
                return mcpResult
              }
              catch (err: any) {
                return err instanceof Error ? err.message : String(err)
              }
            },
          }))
        },
      } as any

      initializeGlobalRegistry()
      registerComputerUseTools({
        server: mockServer,
        runtime,
        executeAction: buildExecuteAction(runtime),
        enableTestTools: false,
      })

      try {
        const { messages } = await generateText({
          model,
          baseURL,
          apiKey,
          tools: xsaiTools as any,
          maxSteps: 15,
          system: sName.system,
          messages: [{ role: 'user', content: 'Begin the scenario.' }],
        })

        const stringifiedMessages = JSON.stringify(messages, null, 2)
        const totalSteps = messages.filter(m => m.role === 'tool').length

        let firstFailure = 'None'
        let selfRescue = false
        if (sName.name.includes('Existing-file')) {
          if (stringifiedMessages.includes('readback verification') || stringifiedMessages.includes('oldString not found')) {
            firstFailure = 'Patch mismatch caught'
          }
          selfRescue = stringifiedMessages.includes('export const flag = true') && !stringifiedMessages.includes('failed')
        }
        else if (sName.name.includes('Fake-completion')) {
          if (stringifiedMessages.includes('COMPLETION DENIED')) {
            firstFailure = 'Completion Denied correctly'
          }
        }
        else if (sName.name.includes('Stalled analysis')) {
          if (stringifiedMessages.includes('ANALYSIS LIMIT EXCEEDED') || stringifiedMessages.includes('ANALYSIS LIMIT WARNING')) {
            firstFailure = 'Governor cutoff triggered'
          }
        }

        resultsMatrix.push({
          scenario: sName.name,
          run,
          passed: totalSteps < 15 ? 'Yes' : 'No (Timeout)',
          totalSteps,
          firstFailure,
          didSelfRescue: selfRescue ? 'Yes' : 'No',
        })
      }
      catch (err: any) {
        resultsMatrix.push({
          scenario: sName.name,
          run,
          passed: 'Crashed',
          totalSteps: 0,
          firstFailure: String(err),
          didSelfRescue: 'No',
        })
      }
    }
  }

  console.log('\n--- SOAK TEST RESULTS MATRIX ---')
  console.table(resultsMatrix, ['scenario', 'run', 'passed', 'totalSteps', 'firstFailure', 'didSelfRescue'])
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSoak().catch(console.error)
}
