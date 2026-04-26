import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
/**
 * MANUAL / GATED EVAL HARNESS — NOT STANDARD CI
 *
 * This script is a live evaluation harness that compares two entry points
 * side-by-side under the same fixture:
 *
 *   A) workflow_coding_agentic_loop  — the existing deterministic workflow
 *   B) workflow_coding_runner        — the experimental Transcript V1 runner
 *
 * Pass/fail outcome depends on real LLM behavior via a live API call.
 * It is intentionally NOT deterministic and MUST NOT be used as a
 * standard CI signal.
 *
 * Correct usage:
 *   - Run manually when evaluating promotion of workflow_coding_runner
 *   - Record stdout output as empirical evidence
 *   - Gate separately (e.g. nightly eval job), never in PR pipeline CI
 *
 * Required env:
 *   AIRI_AGENT_API_KEY   — live model API key
 *   AIRI_AGENT_MODEL     — (optional) model name, defaults to gpt-4o-mini
 *   AIRI_AGENT_BASE_URL  — (optional) base URL
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'

import { createExecuteAction } from '../server/action-executor'
import { registerComputerUseTools } from '../server/register-tools'
import { createRuntimeCoordinator } from '../server/runtime-coordinator'
import { RunStateManager } from '../state'
import { TaskMemoryManager } from '../task-memory/manager'
import { createDisplayInfo, createLocalExecutionTarget, createTerminalState, createTestConfig } from '../test-fixtures'

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

async function createWorkspaceFixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'xsai-governor-eval-'))
  // Setup a scenario with an orchestrated related error
  const indexContent = [
    'export const flag = true',
    'export let DEBUG_MODE = true',
    '',
    'interface Config {',
    '  debug: boolean',
    '}',
    '',
    'function createConfig(): Config {',
    '  // Bug: hardcoded to old name',
    '  return { debug: DEBUG_MODE }',
    '}',
    '',
    'export { createConfig }',
  ].join('\n')

  await writeFile(join(workspace, 'index.ts'), indexContent, 'utf8')

  const checkContent = [
    'const fs = require("fs");',
    'try {',
    '  const content = fs.readFileSync("index.ts", "utf8");',
    '  if (!content.includes("CONFIG_DEBUG_MODE")) {',
    '    console.error("Error: CONFIG_DEBUG_MODE not found.");',
    '    process.exit(1);',
    '  }',
    '  if (content.match(/return {\\s*debug:\\s*DEBUG_MODE\\s*}/)) {',
    '    console.error("Error: return statement still utilizes old DEBUG_MODE symbol.");',
    '    process.exit(1);',
    '  }',
    '  console.log("Check Passed");',
    '} catch (err) {',
    '  console.error(err);',
    '  process.exit(1);',
    '}',
  ].join('\n')

  await writeFile(join(workspace, 'check.js'), checkContent, 'utf8')

  return workspace
}

function createRuntime(sessionRoot: string) {
  const traceEntries: any[] = []

  const base = {
    config: {
      ...createTestConfig({ approvalMode: 'never' }),
      sessionRoot,
      // NOTICE: Override executor to 'macos-local' so coding/terminal actions are not
      // blocked by the linux-x11 preflight checks (which require a remote execution target).
      // This eval harness runs locally; coding_* actions are target-agnostic.
      executor: 'macos-local',
    },
    stateManager: new RunStateManager(),
    session: {
      createPendingAction: () => ({ id: 'approval_1' }),
      getPendingAction: () => undefined,
      listPendingActions: () => [],
      removePendingAction: () => {},
      record: async (entry: any) => {
        traceEntries.push({ ...entry, id: `mock-${traceEntries.length}`, at: new Date().toISOString() })
        return undefined
      },
      getRecentTrace: (limit = 50) => traceEntries.slice(-Math.max(limit, 1)),
      getBudgetState: () => ({ operationsExecuted: 0, operationUnitsConsumed: 0 }),
      getLastScreenshot: () => undefined,
      getSnapshot: () => ({ operationsExecuted: 0, operationUnitsConsumed: 0, pendingActions: [] }),
      setTerminalState: () => {},
      getTerminalState: () => createTerminalState(),
      // Required by createExecuteAction after every successful action dispatch
      consumeOperation: (_units?: number) => {},
      setLastScreenshot: (_screenshot: any) => {},
      getPointerPosition: () => undefined,
      setPointerPosition: (_pos: any) => {},
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
      execute: async (input: { command: string, cwd?: string, timeoutMs?: number }) => {
        const effectiveCwd = input.cwd || sessionRoot
        try {
          const stdout = execFileSync(input.command, { cwd: effectiveCwd, shell: true, encoding: 'utf8', timeout: input.timeoutMs })
          return { command: input.command, exitCode: 0, stdout, stderr: '', effectiveCwd, durationMs: 100, timedOut: false }
        }
        catch (err: any) {
          return { command: input.command, exitCode: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || err.message, effectiveCwd, durationMs: 100, timedOut: false }
        }
      },
      resetState: (_reason?: string) => createTerminalState(),
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
    taskMemory: new TaskMemoryManager(),
  } as any
  base.coordinator = createRuntimeCoordinator(base)
  return base
}

// Scaffold
async function runCompare() {
  if (!env.AIRI_AGENT_API_KEY) {
    console.error('Missing AIRI_AGENT_API_KEY')
    process.exit(1)
  }

  console.log('Evaluation scenario scaffold running...')

  // Run Scenario A: deterministic agentic loop
  const workspaceA = await createWorkspaceFixture()
  const runtimeA = createRuntime(workspaceA)
  const executeActionA = createExecuteAction(runtimeA)
  const mockServerA = createMockServer()
  registerComputerUseTools({ server: mockServerA.server, runtime: runtimeA, executeAction: executeActionA, enableTestTools: false })

  console.log('\n--- Running workflow_coding_agentic_loop (Deterministic) ---')
  console.log('Workspace:', workspaceA)
  let resultA: CallToolResult | undefined
  try {
    resultA = await mockServerA.invoke('workflow_coding_agentic_loop', {
      workspacePath: workspaceA,
      taskGoal: 'Change DEBUG_MODE to CONFIG_DEBUG_MODE',
      searchQuery: 'DEBUG_MODE',
      targetSymbol: 'DEBUG_MODE',
      patchOld: 'export let DEBUG_MODE = true',
      patchNew: 'export let CONFIG_DEBUG_MODE = true',
      testCommand: 'node check.js',
      autoApprove: true,
    })
  }
  catch (error) {
    console.error('Agentic Loop crashed:', error)
  }

  // Run Scenario B: LLM-driven coding runner
  const workspaceB = await createWorkspaceFixture()
  const runtimeB = createRuntime(workspaceB)
  const executeActionB = createExecuteAction(runtimeB)
  const mockServerB = createMockServer()
  registerComputerUseTools({ server: mockServerB.server, runtime: runtimeB, executeAction: executeActionB, enableTestTools: false })

  console.log('\n--- Running workflow_coding_runner (Transcript V1) ---')
  console.log('Workspace:', workspaceB)
  let resultB: CallToolResult | undefined
  try {
    resultB = await mockServerB.invoke('workflow_coding_runner', {
      workspacePath: workspaceB,
      taskGoal: 'Rename the variable DEBUG_MODE to CONFIG_DEBUG_MODE. Make sure the code passes the `node check.js` script. If there is an error in createConfig, fix it.',
    })
  }
  catch (error) {
    console.error('Coding Runner crashed:', error)
  }

  console.log('\n=======================================')
  console.log('         EVALUATION REPORT             ')
  console.log('=======================================')

  const report = {
    agenticLoop: {
      isError: resultA?.isError,
      structuredContent: resultA?.structuredContent,
    },
    codingRunner: {
      isError: resultB?.isError,
      structuredContent: resultB?.structuredContent,
    },
  }

  console.log(JSON.stringify(report, null, 2))

  // Evaluation Assertions
  const aStatus = (resultA?.structuredContent as any)?.status
  const bStatus = (resultB?.structuredContent as any)?.status

  if (aStatus === 'completed' && bStatus === 'completed') {
    console.log('\n[PASS] Both successfully passed. Agentic loop recovered against expectation.')
  }
  else if (bStatus === 'completed') {
    console.log('\n[PASS] Coding runner succeeded while static agentic loop predictably failed the cascading update.')
  }
  else {
    console.log('\n[FAIL] Coding runner did not successfully complete the task.')
    process.exit(1) // Fail the integration test coverage
  }
}

runCompare().catch((e) => {
  console.error(e)
  process.exit(1)
})
