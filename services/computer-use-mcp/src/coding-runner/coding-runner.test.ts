import { describe, expect, it, vi, beforeEach } from 'vitest'

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

import * as xsaiGenerate from '@xsai/generate-text'
import * as xsaiTool from '@xsai/tool'

import { createCodingRunner } from './service'
import { createTranscriptRuntime } from './transcript-runtime'
import { InMemoryTranscriptStore, TranscriptStore } from '../transcript/store'

describe('CodingRunner', () => {
  const config = {
    model: 'test-model',
    baseURL: 'http://test',
    apiKey: 'test-key',
    systemPromptBase: 'test-system',
    maxSteps: 5,
    stepTimeoutMs: 1000,
  }

  const createMockDeps = () => {
    const mockRuntime = {
      config: {
        sessionRoot: '/tmp/phony_test_session',
      },
      stateManager: {
        getState: vi.fn().mockReturnValue({}),
      },
      session: {
        getRecentTrace: vi.fn().mockReturnValue([]),
      },
      taskMemory: {
        toContextString: vi.fn().mockReturnValue('mock_task_memory_content'),
      },
    } as any

    let executeActionCount = 0
    const mockExecuteAction = vi.fn().mockImplementation(async (action: any, toolName?: string) => {
      executeActionCount++
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

  it('default transcript runtime returns file-backed TranscriptStore', async () => {
    const { mockRuntime } = createMockDeps()
    const { store } = await createTranscriptRuntime(mockRuntime, 'test-run-id', false)
    expect(store).toBeInstanceOf(TranscriptStore)
    expect(store).not.toBeInstanceOf(InMemoryTranscriptStore)
  })

  it('test mode transcript runtime returns InMemoryTranscriptStore', async () => {
    const { mockRuntime } = createMockDeps()
    const { store } = await createTranscriptRuntime(mockRuntime, 'test-run-id', true)
    expect(store).toBeInstanceOf(InMemoryTranscriptStore)
  })

  it('should successfully complete when coding_report_status returns completed', async () => {
    const { mockRuntime, mockExecuteAction } = createMockDeps()

    vi.mocked(xsaiGenerate.generateText).mockImplementation(async (opts: any) => {
      // Assert that taskMemoryString is injected into the system prompt
      expect(opts.system).toContain('mock_task_memory_content')
      
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
      } else {
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
