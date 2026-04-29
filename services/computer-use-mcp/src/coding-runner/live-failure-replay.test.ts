import type { CodingRunnerEventEnvelope, CodingRunnerResult } from './types'

import { describe, expect, it } from 'vitest'

import { normalizeCodingLiveFailureReplay } from './live-failure-replay'

function makeResult(overrides: Partial<CodingRunnerResult> = {}): CodingRunnerResult {
  return {
    runId: 'run-live-1',
    status: 'failed',
    totalSteps: 1,
    turns: [],
    ...overrides,
  }
}

function makeEvent<T extends CodingRunnerEventEnvelope['kind']>(
  kind: T,
  payload: Extract<CodingRunnerEventEnvelope, { kind: T }>['payload'],
  seq = 1,
): Extract<CodingRunnerEventEnvelope, { kind: T }> {
  return {
    runId: 'run-live-1',
    seq,
    at: `2026-04-28T00:00:0${seq}.000Z`,
    kind,
    payload,
  } as Extract<CodingRunnerEventEnvelope, { kind: T }>
}

describe('coding live failure replay normalizer', () => {
  it('is deterministic and does not mutate runner result or event inputs', () => {
    const result = makeResult({
      totalSteps: 3,
      error: 'TEXT_ONLY_FINAL: assistant ended without coding_report_status',
      turns: [
        {
          role: 'tool',
          toolName: 'terminal_exec',
          toolArgs: { command: 'node check.js', cwd: '/tmp/workspace' },
          resultOk: true,
          rawText: JSON.stringify({
            tool: 'terminal_exec',
            ok: true,
            status: 'executed',
            summary: 'node check.js passed',
            backend: {
              command: 'node check.js',
              effectiveCwd: '/tmp/workspace',
              terminalState: { effectiveCwd: '/Users/liuziheng/airi' },
              exitCode: 0,
              timedOut: false,
              stdout: 'Check Passed',
            },
          }),
        },
        { role: 'assistant', rawText: 'Everything is done.' },
      ],
    })
    const events = [
      makeEvent('assistant_message', { text: 'Everything is done.' }),
      makeEvent('run_finished', {
        finalStatus: 'failed',
        totalSteps: 3,
        error: 'TEXT_ONLY_FINAL',
      }, 2),
    ]
    const source = {
      label: 'deepseek baseline',
      provider: 'deepseek',
      model: 'deepseek-chat',
      logPath: '/tmp/coding-baseline.log',
    }
    const resultBefore = structuredClone(result)
    const eventsBefore = structuredClone(events)
    const sourceBefore = structuredClone(source)

    const first = normalizeCodingLiveFailureReplay({ result, events, source })
    const second = normalizeCodingLiveFailureReplay({ result, events, source })

    expect(second).toEqual(first)
    expect(result).toEqual(resultBefore)
    expect(events).toEqual(eventsBefore)
    expect(source).toEqual(sourceBefore)
  })

  it('normalizes text-only final failures into a bounded replay row', () => {
    const row = normalizeCodingLiveFailureReplay({
      source: {
        label: 'deepseek baseline',
        provider: 'deepseek',
        model: 'deepseek-chat',
        logPath: '/tmp/coding-baseline.log',
      },
      result: makeResult({
        totalSteps: 15,
        error: 'TEXT_ONLY_FINAL: assistant ended without coding_report_status',
        turns: [
          { role: 'assistant', rawText: 'Everything is done. Here is a summary.' },
        ],
      }),
      events: [
        makeEvent('assistant_message', { text: 'Everything is done. Here is a summary.' }),
        makeEvent('run_finished', {
          finalStatus: 'failed',
          totalSteps: 15,
          error: 'TEXT_ONLY_FINAL',
        }, 2),
      ],
    })

    expect(row).toMatchObject({
      runId: 'run-live-1',
      source: {
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
      status: 'failed',
      totalSteps: 15,
      failureClass: 'report_only_text_final',
      disposition: 'runtime_follow_up_if_repeated',
    })
    expect(row.classificationSummary).toContain('coding_report_status')
    expect(row.failureSignal).toBe('TEXT_ONLY_FINAL: assistant ended without coding_report_status')
    expect(row.eventKinds).toEqual(['assistant_message', 'run_finished'])
    expect(row.toolHistory).toEqual([
      {
        index: 0,
        role: 'assistant',
        toolName: undefined,
        resultOk: undefined,
        status: undefined,
        argsPreview: undefined,
        summary: undefined,
        error: undefined,
      },
    ])
  })

  it('preserves tool history order, names, statuses, summaries, and errors', () => {
    const row = normalizeCodingLiveFailureReplay({
      result: makeResult({
        turns: [
          {
            role: 'tool',
            toolName: 'coding_search_text',
            toolArgs: { query: 'DEBUG_MODE' },
            resultOk: true,
            rawText: JSON.stringify({
              tool: 'coding_search_text',
              ok: true,
              status: 'ok',
              summary: 'found 2 matches',
              args: { query: 'DEBUG_MODE' },
            }),
          },
          {
            role: 'tool',
            toolName: 'coding_read_archived_context',
            resultOk: false,
            rawText: JSON.stringify({
              tool: 'coding_read_archived_context',
              ok: false,
              status: 'exception',
              summary: 'archive read denied',
              error: 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search',
            }),
          },
        ],
      }),
    })

    expect(row.failureClass).toBe('archive_recall_finalization')
    expect(row.toolHistory).toEqual([
      {
        index: 0,
        role: 'tool',
        toolName: 'coding_search_text',
        resultOk: true,
        status: 'ok',
        argsPreview: '{"query":"DEBUG_MODE"}',
        summary: 'found 2 matches',
        error: undefined,
      },
      {
        index: 1,
        role: 'tool',
        toolName: 'coding_read_archived_context',
        resultOk: false,
        status: 'exception',
        argsPreview: undefined,
        summary: 'archive read denied',
        error: 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search',
      },
    ])
  })

  it('extracts terminal cwd detour evidence without treating a completed run as failed', () => {
    const row = normalizeCodingLiveFailureReplay({
      result: makeResult({
        status: 'completed',
        totalSteps: 4,
        turns: [
          {
            role: 'tool',
            toolName: 'terminal_exec',
            toolArgs: { command: 'cat index.ts', cwd: '/Users/liuziheng/airi' },
            resultOk: false,
            rawText: JSON.stringify({
              tool: 'terminal_exec',
              ok: false,
              status: 'exception',
              summary: 'terminal_exec failed: No such file or directory',
              error: 'cat: index.ts: No such file or directory',
              args: { command: 'cat index.ts', cwd: '/Users/liuziheng/airi' },
              backend: {
                command: 'cat index.ts',
                effectiveCwd: '/Users/liuziheng/airi',
                terminalState: { effectiveCwd: '/tmp/fixture' },
                exitCode: 1,
                timedOut: false,
                stdout: '',
                stderr: 'cat: index.ts: No such file or directory',
              },
            }),
          },
          {
            role: 'tool',
            toolName: 'coding_report_status',
            resultOk: true,
            rawText: JSON.stringify({
              tool: 'coding_report_status',
              ok: true,
              status: 'ok',
              summary: 'completed accepted',
            }),
          },
        ],
      }),
    })

    expect(row.status).toBe('completed')
    expect(row.failureClass).toBe('cwd_terminal_detour')
    expect(row.disposition).toBe('deterministic_replay_first')
    expect(row.failureSignal).toBe('cat: index.ts: No such file or directory')
    expect(row.terminalEvidence).toEqual([
      {
        turnIndex: 0,
        command: 'cat index.ts',
        effectiveCwd: '/Users/liuziheng/airi',
        terminalStateEffectiveCwd: '/tmp/fixture',
        exitCode: 1,
        timedOut: false,
        stdoutPreview: undefined,
        stderrPreview: 'cat: index.ts: No such file or directory',
      },
    ])
  })

  it('keeps archive recall denial ahead of budget exhaustion and records latest failed tool', () => {
    const row = normalizeCodingLiveFailureReplay({
      result: makeResult({
        error: 'BUDGET_EXHAUSTED after archive finalization detour',
        turns: [
          {
            role: 'tool',
            toolName: 'terminal_exec',
            resultOk: false,
            rawText: JSON.stringify({
              tool: 'terminal_exec',
              ok: false,
              error: 'cat: index.ts: No such file or directory',
            }),
          },
          {
            role: 'tool',
            toolName: 'coding_read_archived_context',
            resultOk: false,
            rawText: JSON.stringify({
              tool: 'coding_read_archived_context',
              ok: false,
              status: 'exception',
              error: 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search',
            }),
          },
        ],
      }),
    })

    expect(row.failureClass).toBe('archive_recall_finalization')
    expect(row.failureSignal).toBe('BUDGET_EXHAUSTED after archive finalization detour')
    expect(row.toolHistory.map(entry => [entry.toolName, entry.error])).toEqual([
      ['terminal_exec', 'cat: index.ts: No such file or directory'],
      ['coding_read_archived_context', 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search'],
    ])
  })

  it('uses the latest failed tool as failure signal when the result has no explicit error', () => {
    const row = normalizeCodingLiveFailureReplay({
      result: makeResult({
        turns: [
          {
            role: 'tool',
            toolName: 'terminal_exec',
            resultOk: false,
            rawText: JSON.stringify({
              tool: 'terminal_exec',
              ok: false,
              error: 'old failure',
            }),
          },
          {
            role: 'tool',
            toolName: 'coding_read_archived_context',
            resultOk: false,
            rawText: JSON.stringify({
              tool: 'coding_read_archived_context',
              ok: false,
              error: 'ARCHIVE_RECALL_DENIED: latest failure',
            }),
          },
        ],
      }),
    })

    expect(row.failureClass).toBe('archive_recall_finalization')
    expect(row.failureSignal).toBe('ARCHIVE_RECALL_DENIED: latest failure')
  })

  it('records the latest verification gate evidence from events', () => {
    const row = normalizeCodingLiveFailureReplay({
      result: makeResult({
        error: 'Verification Gate blocked completion. reason=verification_bad_faith',
      }),
      events: [
        makeEvent('verification_gate_evaluated', {
          reportedStatus: 'completed',
          gateDecision: 'abort',
          reasonCode: 'review_missing',
          runnerFinalStatus: 'failed',
          explanation: 'review missing',
          recheckAttempted: false,
        }),
        makeEvent('verification_gate_evaluated', {
          reportedStatus: 'completed',
          gateDecision: 'abort',
          reasonCode: 'verification_bad_faith',
          runnerFinalStatus: 'failed',
          explanation: 'report-only evidence was misread',
          recheckAttempted: false,
        }, 2),
      ],
    })

    expect(row.failureClass).toBe('report_only_verification_gate')
    expect(row.verificationGate).toEqual({
      reportedStatus: 'completed',
      gateDecision: 'abort',
      reasonCode: 'verification_bad_faith',
      runnerFinalStatus: 'failed',
      explanation: 'report-only evidence was misread',
      recheckAttempted: false,
    })
  })

  it('maps provider capacity errors to provider observations', () => {
    const row = normalizeCodingLiveFailureReplay({
      result: makeResult({
        error: 'Remote sent 429 response: {"error":{"code":"model_price_error","message":"upstream load saturated"}}',
      }),
    })

    expect(row.failureClass).toBe('provider_capacity_or_latency')
    expect(row.disposition).toBe('provider_observation_only')
    expect(row.classificationSummary).toContain('Provider capacity')
  })

  it('bounds tool argument and output previews', () => {
    const longText = 'x'.repeat(700)
    const row = normalizeCodingLiveFailureReplay({
      result: makeResult({
        turns: [
          {
            role: 'tool',
            toolName: 'terminal_exec',
            toolArgs: { command: longText },
            resultOk: false,
            rawText: JSON.stringify({
              tool: 'terminal_exec',
              ok: false,
              error: longText,
              backend: {
                command: longText,
                stderr: longText,
              },
            }),
          },
        ],
      }),
    })

    expect(row.toolHistory[0]?.argsPreview).toHaveLength(500)
    expect(row.toolHistory[0]?.error).toHaveLength(500)
    expect(row.terminalEvidence[0]?.stderrPreview).toHaveLength(500)
  })
})
