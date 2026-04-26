import type { CodingRunnerEventEnvelope } from './types'

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as xsaiGenerate from '@xsai/generate-text'
import * as xsaiTool from '@xsai/tool'

import { ArchiveContextStore } from '../archived-context/store'
import { TaskMemoryManager } from '../task-memory/manager'
import { InMemoryTranscriptStore, TranscriptStore } from '../transcript/store'
import { workspaceKeyFromPath, WorkspaceMemoryStore } from '../workspace-memory/store'
import { createCodingRunnerEventEmitter } from './events'
import { createCodingRunner } from './service'
import { buildXsaiCodingTools } from './tool-runtime'
import { createTranscriptRuntime } from './transcript-runtime'

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

function createGateReadyState(overrides: Record<string, any> = {}) {
  const hasTerminalOverride = Object.hasOwn(overrides, 'lastTerminalResult')
  const coding = {
    workspacePath: '/test',
    gitSummary: 'clean',
    recentReads: [],
    recentEdits: [],
    recentCommandResults: [],
    recentSearches: [],
    pendingIssues: [],
    lastScopedValidationCommand: {
      command: 'pnpm test',
      scope: 'workspace',
      reason: 'test',
      resolvedAt: '2026-04-26T00:00:00.000Z',
    },
    lastChangeReview: {
      status: 'ready_for_next_file',
      filesReviewed: ['src/example.ts'],
      diffSummary: 'ok',
      validationSummary: 'ok',
      validationCommand: 'pnpm test',
      baselineComparison: 'unknown',
      detectedRisks: [],
      unresolvedIssues: [],
      recommendedNextAction: 'report completion',
    },
    validationBaseline: {
      workspacePath: '/test',
      capturedAt: '2026-04-26T00:00:00.000Z',
      baselineDirtyFiles: [],
      workspaceMetadata: {
        sourceWorkspacePath: '/test',
        worktreePath: '/test',
      },
    },
    ...overrides.coding,
  }

  return {
    coding,
    lastTerminalResult: hasTerminalOverride
      ? overrides.lastTerminalResult
      : {
          command: 'pnpm test',
          effectiveCwd: '/test',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 10,
          timedOut: false,
        },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'coding' && key !== 'lastTerminalResult')),
  }
}

function mockGenerateCompletedReport(summary = 'done') {
  vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => ({
    messages: [
      ...opts.messages,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_report',
          function: { name: 'coding_report_status', arguments: '{"status":"completed"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_report',
        content: JSON.stringify({
          tool: 'coding_report_status',
          args: { status: 'completed', summary },
          ok: true,
          status: 'ok',
          backend: { status: 'completed' },
        }),
      },
    ],
  }) as any)
}

describe('codingRunner', () => {
  const config = {
    model: 'test-model',
    baseURL: 'http://test',
    apiKey: 'test-key',
    systemPromptBase: 'test-system',
    maxSteps: 5,
    stepTimeoutMs: 1000,
  }

  const createdSessionRoots: string[] = []

  const createMockDeps = (sessionRoot?: string) => {
    const actualSessionRoot = sessionRoot ?? join(tmpdir(), `coding-runner-test-session-${randomUUID()}`)
    if (!sessionRoot)
      createdSessionRoots.push(actualSessionRoot)

    const taskMemory = new TaskMemoryManager()
    let runState = createGateReadyState()
    const mockRuntime = {
      config: {
        sessionRoot: actualSessionRoot,
      },
      stateManager: {
        getState: vi.fn(() => runState),
        updateCodingState: vi.fn((update: Record<string, any>) => {
          runState = {
            ...runState,
            coding: {
              ...runState.coding,
              ...update,
            },
          }
        }),
        updateTaskMemory: vi.fn(),
      },
      session: {
        getRecentTrace: vi.fn().mockReturnValue([]),
      },
      taskMemory,
    } as any

    const mockExecuteAction = vi.fn().mockImplementation(async (action: any) => {
      if (action?.kind === 'coding_review_workspace' || action?.kind === 'coding_capture_validation_baseline') {
        return { isError: false, content: [] }
      }
      return { isError: false, content: [] }
    })
    return { mockRuntime, mockExecuteAction }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(xsaiGenerate.generateText).mockReset()
    vi.mocked(xsaiTool.tool).mockReset()
    vi.mocked(xsaiTool.tool).mockImplementation((def: any) => Promise.resolve(def))
  })

  afterEach(async () => {
    await Promise.all(createdSessionRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('default transcript runtime returns file-backed TranscriptStore', async () => {
    const { mockRuntime } = createMockDeps()
    const { store } = await createTranscriptRuntime(mockRuntime, 'test-run-id', '/test', false)
    expect(store).toBeInstanceOf(TranscriptStore)
    expect(store).not.toBeInstanceOf(InMemoryTranscriptStore)
  })

  it('test mode transcript runtime returns InMemoryTranscriptStore', async () => {
    const { mockRuntime } = createMockDeps()
    const { store } = await createTranscriptRuntime(mockRuntime, 'test-run-id', '/test', true)
    expect(store).toBeInstanceOf(InMemoryTranscriptStore)
  })

  it('should successfully complete when coding_report_status returns completed', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()

    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => {
      // Assert that runner-owned task memory is injected into the system prompt.
      expect(opts.system).toContain('Goal: Complete the task')

      return {
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
            content: JSON.stringify({
              tool: 'coding_report_status',
              args: { status: 'completed' },
              ok: true,
              status: 'ok',
              backend: { status: 'completed' },
            }),
          },
        ],
      } as any
    })

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Complete the task' })

    expect(result.status).toBe('completed')
    expect(result.turns.length).toBeGreaterThan(0)
    expect(result.turns.at(-1)?.toolName).toBe('coding_report_status')
    expect(result.transcriptMetadata).toBeDefined()
  })

  it('blocks model-reported completion when runtime review evidence is missing', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const events: CodingRunnerEventEnvelope[] = []
    mockRuntime.stateManager.getState.mockReturnValue(createGateReadyState({
      coding: {
        lastChangeReview: undefined,
      },
    }))
    mockGenerateCompletedReport('claimed done')

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({
      workspacePath: '/test',
      taskGoal: 'Complete without review',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('Verification Gate blocked completion')
    expect(result.error).toContain('reason=review_missing')
    expect(mockRuntime.taskMemory.get()?.recentFailureReason).toContain('Verification Gate blocked completion')
    expect(events.map(event => event.kind)).toContain('report_status')
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'verification_gate_evaluated',
      payload: expect.objectContaining({
        reportedStatus: 'completed',
        gateDecision: 'needs_follow_up',
        reasonCode: 'review_missing',
        runnerFinalStatus: 'failed',
        recheckAttempted: false,
      }),
    }))
  })

  it('runs one bounded verification recheck when terminal evidence is missing and completes if recheck passes', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const events: CodingRunnerEventEnvelope[] = []
    const state = createGateReadyState({ lastTerminalResult: undefined })
    mockRuntime.stateManager.getState.mockImplementation(() => state)
    mockExecuteAction.mockImplementation(async (action: any) => {
      if (action.kind === 'terminal_exec') {
        state.lastTerminalResult = {
          command: 'pnpm test',
          effectiveCwd: '/test',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 10,
          timedOut: false,
        }
      }
      return { isError: false, content: [], structuredContent: { status: 'executed', action: action.kind } }
    })
    mockGenerateCompletedReport('done after recheck')

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({
      workspacePath: '/test',
      taskGoal: 'Complete with recheck',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(result.status).toBe('completed')
    expect(mockExecuteAction).toHaveBeenCalledWith(
      {
        kind: 'terminal_exec',
        input: {
          command: 'auto',
          cwd: '/test',
          timeoutMs: 60_000,
        },
      },
      'workflow_coding_runner_verification_recheck_terminal_exec',
    )
    expect(mockExecuteAction).toHaveBeenCalledWith(
      {
        kind: 'coding_review_changes',
        input: {},
      },
      'workflow_coding_runner_verification_recheck_review_changes',
    )
    expect(events.map(event => event.kind)).toContain('verification_recheck_started')
    expect(events.map(event => event.kind)).toContain('verification_recheck_completed')
    expect(events.filter(event => event.kind === 'verification_gate_evaluated').map(event => (event.payload as any).gateDecision)).toEqual(['recheck_once', 'pass'])
  })

  it('fails when the bounded verification recheck does not produce passing evidence', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const state = createGateReadyState({ lastTerminalResult: undefined })
    mockRuntime.stateManager.getState.mockImplementation(() => state)
    mockExecuteAction.mockImplementation(async (action: any) => {
      if (action.kind === 'terminal_exec') {
        return { isError: true, content: [{ type: 'text', text: 'auto validation unavailable' }] }
      }
      return { isError: false, content: [], structuredContent: { status: 'executed', action: action.kind } }
    })
    mockGenerateCompletedReport('done without proof')

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Complete with failed recheck' })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('bounded verification recheck failed while executing auto validation command')
    expect(mockRuntime.taskMemory.get()?.recentFailureReason).toContain('bounded verification recheck failed')
  })

  it('rejects bad-faith terminal evidence before accepting completed status', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    mockRuntime.stateManager.getState.mockReturnValue(createGateReadyState({
      lastTerminalResult: {
        command: 'echo ok',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      },
    }))
    mockGenerateCompletedReport('done with echo')

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Complete with no-op validation' })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('reason=verification_bad_faith')
  })

  it('rejects completed status when the last validation command exited non-zero', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    mockRuntime.stateManager.getState.mockReturnValue(createGateReadyState({
      lastTerminalResult: {
        command: 'pnpm test',
        exitCode: 1,
        stdout: '',
        stderr: 'failed',
        durationMs: 10,
        timedOut: false,
      },
    }))
    mockGenerateCompletedReport('done with failing tests')

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Complete with failing validation' })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('reason=terminal_exit_nonzero')
  })

  it('completes analysis/report-only runs with runtime report evidence without validation recheck', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const events: CodingRunnerEventEnvelope[] = []
    const state = createGateReadyState({
      lastTerminalResult: undefined,
      coding: {
        taskKind: 'analysis_report',
        recentReads: [{ path: 'src/example.ts', range: 'all' }],
        lastScopedValidationCommand: undefined,
        lastChangeReview: undefined,
        lastCompressedContext: {
          goal: 'Explain workspace status',
          filesSummary: 'Read src/example.ts and summarized the relevant implementation facts.',
          recentResultSummary: 'No terminal command was required for this non-mutating report.',
          unresolvedIssues: 'No report blockers found.',
          nextStepRecommendation: 'Return the report to the caller.',
        },
      },
    })
    mockRuntime.stateManager.getState.mockImplementation(() => state)

    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => {
      state.coding.lastCodingReport = {
        status: 'completed',
        summary: 'Workspace analysis completed with source-backed report evidence.',
        filesTouched: [],
        commandsRun: [],
        checks: [],
        nextStep: 'No code changes required.',
      }

      return {
        messages: [
          ...opts.messages,
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_report_only',
              function: { name: 'coding_report_status', arguments: '{"status":"completed"}' },
            }],
          },
          {
            role: 'tool',
            tool_call_id: 'call_report_only',
            content: JSON.stringify({
              tool: 'coding_report_status',
              args: {
                status: 'completed',
                summary: 'Workspace analysis completed with source-backed report evidence.',
              },
              ok: true,
              status: 'ok',
              backend: { status: 'completed' },
            }),
          },
        ],
      } as any
    })

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({
      workspacePath: '/test',
      taskGoal: 'Explain the workspace status',
      taskKind: 'analysis_report',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(result.status).toBe('completed')
    expect(mockExecuteAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'terminal_exec' }),
      'workflow_coding_runner_verification_recheck_terminal_exec',
    )
    expect(events.filter(event => event.kind === 'verification_gate_evaluated')).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'verification_gate_evaluated',
      payload: expect.objectContaining({
        gateDecision: 'pass',
        runnerFinalStatus: 'completed',
      }),
    }))
  })

  it('does not complete when coding_report_status wrapper result is rejected', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const events: CodingRunnerEventEnvelope[] = []

    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => ({
      messages: [
        ...opts.messages,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_denied',
            function: { name: 'coding_report_status', arguments: '{"status":"completed"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_denied',
          content: JSON.stringify({
            tool: 'coding_report_status',
            args: { status: 'completed' },
            ok: false,
            status: 'exception',
            error: 'Completion Denied: missing mutation proof',
            backend: { status: 'completed' },
          }),
        },
      ],
    }) as any)

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({
      workspacePath: '/test',
      taskGoal: 'Complete without proof',
      maxSteps: 1,
      runId: 'run-denied-report',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(result.status).toBe('timeout')
    expect(result.turns.at(-1)).toMatchObject({
      role: 'tool',
      toolName: 'coding_report_status',
      resultOk: false,
    })
    expect(mockRuntime.taskMemory.get()?.recentFailureReason).toContain('Completion Denied')
    expect(events.map(event => event.kind)).not.toContain('report_status')
  })

  it('treats rejected auto filesTouched completion report as tool failure, not completed status', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const events: CodingRunnerEventEnvelope[] = []

    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => ({
      messages: [
        ...opts.messages,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_auto_denied',
            function: { name: 'coding_report_status', arguments: '{"status":"completed","filesTouched":["auto"]}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_auto_denied',
          content: JSON.stringify({
            tool: 'coding_report_status',
            args: { status: 'completed', filesTouched: ['auto'] },
            ok: false,
            status: 'exception',
            error: 'Completion Denied: auto filesTouched lacks verifiable mutation proofs',
          }),
        },
      ],
    }) as any)

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({
      workspacePath: '/test',
      taskGoal: 'Complete with auto proof bypass',
      maxSteps: 1,
      runId: 'run-auto-denied-report',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(result.status).toBe('timeout')
    expect(result.turns.at(-1)).toMatchObject({
      role: 'tool',
      toolName: 'coding_report_status',
      resultOk: false,
    })
    expect(mockRuntime.taskMemory.get()?.recentFailureReason).toContain('auto filesTouched lacks verifiable mutation proofs')
    expect(events.map(event => event.kind)).not.toContain('report_status')
    expect(events.map(event => event.kind)).not.toContain('verification_gate_evaluated')
  })

  it('syncs task memory from task start and coding_report_status', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()

    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => ({
      messages: [
        ...opts.messages,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_123',
            function: {
              name: 'coding_report_status',
              arguments: JSON.stringify({
                status: 'completed',
                summary: 'implemented safely',
                filesTouched: ['src/a.ts'],
                commandsRun: ['pnpm test'],
                checks: ['unit tests passed'],
                nextStep: '',
              }),
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: JSON.stringify({
            tool: 'coding_report_status',
            args: {
              status: 'completed',
              summary: 'implemented safely',
              filesTouched: ['src/a.ts'],
              commandsRun: ['pnpm test'],
              checks: ['unit tests passed'],
              nextStep: '',
            },
            ok: true,
            status: 'completed',
          }),
        },
      ],
    }) as any)

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Wire memory' })

    expect(result.status).toBe('completed')
    expect(mockRuntime.taskMemory.get()).toMatchObject({
      status: 'done',
      goal: 'Wire memory',
      confirmedFacts: ['unit tests passed'],
      artifacts: [
        { label: 'src/a.ts', value: 'src/a.ts', kind: 'file' },
        { label: 'pnpm test', value: 'pnpm test', kind: 'tool' },
      ],
    })
    expect(mockRuntime.stateManager.updateTaskMemory).toHaveBeenCalled()
  })

  it('emits monotonic runner lifecycle events for a completed task', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const events: CodingRunnerEventEnvelope[] = []

    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => {
      return {
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
            content: JSON.stringify({
              tool: 'coding_report_status',
              args: { status: 'completed', summary: 'done' },
              ok: true,
              status: 'completed',
            }),
          },
        ],
      } as any
    })

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({
      workspacePath: '/test',
      taskGoal: 'Complete the task',
      runId: 'run-events',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(result.status).toBe('completed')
    expect(result.runId).toBe('run-events')
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
    expect(events.every(event => event.runId === 'run-events')).toBe(true)
    expect(events.map(event => event.kind)).toEqual([
      'run_started',
      'preflight_started',
      'preflight_completed',
      'preflight_started',
      'preflight_completed',
      'step_started',
      'report_status',
      'verification_gate_evaluated',
      'run_finished',
    ])
    expect(events.at(-1)).toMatchObject({
      kind: 'run_finished',
      payload: { finalStatus: 'completed', totalSteps: 1 },
    })
  })

  it('emits tool start and completion events from the xsai tool adapter', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const events: CodingRunnerEventEnvelope[] = []
    const emitter = createCodingRunnerEventEmitter('run-tools', (event) => {
      events.push(event)
    })

    const tools = await buildXsaiCodingTools(mockRuntime, mockExecuteAction, { events: emitter })
    const readFile = tools.find((toolDef: any) => toolDef.name === 'coding_read_file')
    expect(readFile).toBeDefined()

    await readFile.execute({ workspacePath: '/test', path: 'missing.ts' })

    expect(events.map(event => event.kind)).toEqual(['tool_call_started', 'tool_call_completed'])
    expect(events[0]).toMatchObject({
      runId: 'run-tools',
      seq: 0,
      payload: { toolName: 'coding_read_file' },
    })
    expect(events[1]).toMatchObject({
      runId: 'run-tools',
      seq: 1,
      payload: { toolName: 'coding_read_file' },
    })
  })

  it('adds internal archived-context recall tools when an archive store is provided', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const tmpRoot = await mkdtemp(join(tmpdir(), 'coding-runner-archive-tools-'))
    const archiveStore = new ArchiveContextStore(tmpRoot)
    const runId = 'run-archive-tools'
    const events: CodingRunnerEventEnvelope[] = []

    try {
      await archiveStore.init(runId, runId)
      await archiveStore.writeCandidates([{
        reason: 'compacted',
        originalKind: 'tool_interaction',
        entryIdRange: [10, 12],
        summary: 'Config rename context',
        normalizedContent: 'Earlier work renamed DEBUG_MODE to CONFIG_DEBUG_MODE in config.ts.',
        createdAt: '2026-04-20T00:00:00.000Z',
        tags: ['coding_apply_patch'],
      }], runId, runId)

      const tools = await buildXsaiCodingTools(mockRuntime, mockExecuteAction, {
        archiveStore,
        runId,
        events: createCodingRunnerEventEmitter(runId, (event) => {
          events.push(event)
        }),
      })

      const searchTool = tools.find((toolDef: any) => toolDef.name === 'coding_search_archived_context')
      const readTool = tools.find((toolDef: any) => toolDef.name === 'coding_read_archived_context')
      expect(searchTool).toBeDefined()
      expect(readTool).toBeDefined()

      const searchResult = JSON.parse(await searchTool.execute({ query: 'CONFIG_DEBUG_MODE' }))
      expect(searchResult.backend.hits).toHaveLength(1)
      expect(searchResult.backend.hits[0].artifactId).toBe('10-12-compacted.md')

      const readResult = JSON.parse(await readTool.execute({ artifactId: '10-12-compacted.md' }))
      expect(readResult.backend.content).toContain('CONFIG_DEBUG_MODE')
      expect(events.map(event => event.kind)).toEqual([
        'tool_call_started',
        'tool_call_completed',
        'tool_call_started',
        'tool_call_completed',
      ])
    }
    finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('adds governed workspace memory tools without promoting proposals into default search', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    const tmpRoot = await mkdtemp(join(tmpdir(), 'coding-runner-workspace-memory-tools-'))
    const workspaceMemoryStore = new WorkspaceMemoryStore(join(tmpRoot, 'workspace-memory.jsonl'), {
      workspacePath: join(tmpRoot, 'repo'),
      sourceRunId: 'run-workspace-memory-tools',
    })

    try {
      await workspaceMemoryStore.init()
      const tools = await buildXsaiCodingTools(mockRuntime, mockExecuteAction, {
        workspaceMemoryStore,
        events: createCodingRunnerEventEmitter('run-workspace-memory-tools'),
      })

      const proposeTool = tools.find((toolDef: any) => toolDef.name === 'coding_propose_workspace_memory')
      const searchTool = tools.find((toolDef: any) => toolDef.name === 'coding_search_workspace_memory')
      const readTool = tools.find((toolDef: any) => toolDef.name === 'coding_read_workspace_memory')
      expect(proposeTool).toBeDefined()
      expect(searchTool).toBeDefined()
      expect(readTool).toBeDefined()

      const proposed = JSON.parse(await proposeTool.execute({
        kind: 'constraint',
        statement: 'Use pnpm filters for computer-use-mcp tests.',
        evidence: 'The package has a filtered test target.',
        confidence: 'medium',
        tags: ['pnpm'],
      }))

      expect(proposed.status).toBe('proposed')
      expect(proposed.backend.entry.status).toBe('proposed')

      const defaultSearch = JSON.parse(await searchTool.execute({ query: 'pnpm' }))
      expect(defaultSearch.backend.hits).toEqual([])

      const proposedSearch = JSON.parse(await searchTool.execute({ query: 'pnpm', includeProposed: true }))
      expect(proposedSearch.backend.hits).toHaveLength(1)

      const readResult = JSON.parse(await readTool.execute({ id: proposed.backend.entry.id }))
      expect(readResult.backend.entry.statement).toContain('pnpm filters')
    }
    finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('injects only active workspace memory into the coding turn prompt', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'coding-runner-workspace-memory-prompt-'))
    const workspacePath = join(tmpRoot, 'repo')
    const { mockRuntime, mockExecuteAction } = createMockDeps(tmpRoot)
    const seedStore = new WorkspaceMemoryStore(
      join(tmpRoot, 'workspace-memory', `${workspaceKeyFromPath(workspacePath)}.jsonl`),
      { workspacePath, sourceRunId: 'seed-run' },
    )

    try {
      await seedStore.init()
      const active = await seedStore.propose({
        kind: 'constraint',
        statement: 'For pnpm test tasks, use the @proj-airi/computer-use-mcp workspace filter.',
        evidence: 'The package tests are run through pnpm -F @proj-airi/computer-use-mcp test.',
        confidence: 'high',
      })
      await seedStore.updateStatus(active.id, 'active', true)
      await seedStore.propose({
        kind: 'pitfall',
        statement: 'Unpromoted pnpm proposal must not enter the prompt.',
        evidence: 'This entry is intentionally left proposed.',
      })

      vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => {
        expect(opts.system).toContain('【Governed Workspace Memory】')
        expect(opts.system).toContain('@proj-airi/computer-use-mcp workspace filter')
        expect(opts.system).not.toContain('Unpromoted pnpm proposal')
        return {
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
        } as any
      })

      const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
      const result = await runner.runCodingTask({
        workspacePath,
        taskGoal: 'Fix pnpm test tasks',
      })

      expect(result.status).toBe('completed')
    }
    finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('should explicitly append only delta payload avoiding duplication on a two-turn task', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()

    let callCount = 0
    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => {
      callCount++
      if (callCount === 1) {
        return {
          messages: [
            ...opts.messages,
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_turn1',
                function: { name: 'coding_read_file', arguments: '{}' },
              }],
            },
            {
              role: 'tool',
              tool_call_id: 'call_turn1',
              content: JSON.stringify({ tool: 'coding_read_file', ok: true, status: 'ok' }),
            },
          ],
        } as any
      }
      else {
        return {
          messages: [
            ...opts.messages,
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_turn2',
                function: { name: 'coding_report_status', arguments: '{"status":"failed"}' },
              }],
            },
            {
              role: 'tool',
              tool_call_id: 'call_turn2',
              content: JSON.stringify({ tool: 'coding_report_status', args: { status: 'failed' }, ok: true, status: 'failed' }),
            },
          ],
        } as any
      }
    })

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Test Delta Append' })

    expect(result.totalSteps).toBe(2)
    expect(result.status).toBe('failed') // derived cleanly from parsed tool payload 'status'
    expect(result.turns.length).toBe(2)
  })

  it('injects failed tool results into next-step task memory for recovery', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()

    let callCount = 0
    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => {
      callCount++
      if (callCount === 1) {
        return {
          messages: [
            ...opts.messages,
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_patch_fail',
                function: { name: 'coding_apply_patch', arguments: '{}' },
              }],
            },
            {
              role: 'tool',
              tool_call_id: 'call_patch_fail',
              content: JSON.stringify({
                tool: 'coding_apply_patch',
                args: { filePath: 'src/a.ts' },
                ok: false,
                status: 'failed',
                error: 'PATCH_MISMATCH: oldString not found',
              }),
            },
          ],
        } as any
      }

      expect(opts.system).toContain('Recent failure: coding_apply_patch failed: PATCH_MISMATCH')
      return {
        messages: [
          ...opts.messages,
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_report',
              function: { name: 'coding_report_status', arguments: '{"status":"completed"}' },
            }],
          },
          {
            role: 'tool',
            tool_call_id: 'call_report',
            content: JSON.stringify({
              tool: 'coding_report_status',
              args: { status: 'completed' },
              ok: true,
              status: 'ok',
              backend: { status: 'completed' },
            }),
          },
        ],
      } as any
    })

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Recover from patch mismatch' })

    expect(result.status).toBe('completed')
    expect(result.totalSteps).toBe(2)
    expect(callCount).toBe(2)
  })

  it('should fail when loop ends on text-only assistant output without terminal report', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()

    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => {
      return {
        messages: [
          ...opts.messages,
          { role: 'assistant', content: 'I am done with the task implicitly.' },
        ],
      } as any
    })

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Do something' })

    expect(result.status).toBe('failed')
    expect(result.turns.length).toBe(1)
    expect(result.turns[0].role).toBe('assistant')
  })

  it('should abort and return failed if coding_review_workspace fails', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    mockExecuteAction.mockImplementation(async (action: any) => {
      if (action?.kind === 'coding_review_workspace') {
        return { isError: true, content: ['workspace review failed'] }
      }
      return { isError: false, content: [] }
    })

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Do something' })

    expect(result.status).toBe('failed')
    expect(result.totalSteps).toBe(0)
    expect(result.error).toContain('coding_review_workspace returned error')
  })

  it('should abort and return failed if coding_capture_validation_baseline fails', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()
    mockExecuteAction.mockImplementation(async (action: any) => {
      if (action?.kind === 'coding_capture_validation_baseline') {
        return { isError: true, content: ['baseline failed'] }
      }
      return { isError: false, content: [] }
    })

    const runner = createCodingRunner(config, { runtime: mockRuntime, executeAction: mockExecuteAction, useInMemoryTranscript: true })
    const result = await runner.runCodingTask({ workspacePath: '/test', taskGoal: 'Do something' })

    expect(result.status).toBe('failed')
    expect(result.totalSteps).toBe(0)
    expect(result.error).toContain('coding_capture_validation_baseline returned error')
  })
})
