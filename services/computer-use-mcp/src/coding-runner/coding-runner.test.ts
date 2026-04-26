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
    const mockRuntime = {
      config: {
        sessionRoot: actualSessionRoot,
      },
      stateManager: {
        getState: vi.fn().mockReturnValue({}),
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
            content: JSON.stringify({ tool: 'coding_report_status', args: { status: 'completed' }, ok: true, status: 'completed' }),
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
