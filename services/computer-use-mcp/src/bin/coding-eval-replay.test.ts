import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { describe, expect, it } from 'vitest'

import { buildCodingEvalReplayRow, inferEvalProviderLabel } from './coding-eval-replay'

function makeToolResult(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: 'runner finished' }],
    structuredContent,
  }
}

describe('coding eval replay adapter', () => {
  it('builds replay rows from MCP structured result and transcript tool records', () => {
    const row = buildCodingEvalReplayRow({
      source: {
        label: 'baseline-edit',
        provider: 'api.deepseek.com',
        model: 'deepseek-v4-pro',
      },
      result: makeToolResult({
        runId: 'run-eval-1',
        status: 'failed',
        totalSteps: 15,
        lastError: 'BUDGET_EXHAUSTED after archive finalization detour',
      }),
      transcriptTools: [
        {
          entryId: 1,
          tool: 'coding_read_archived_context',
          args: { artifactId: '0-2-compacted.md' },
          ok: false,
          status: 'exception',
          error: 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search',
        },
      ],
    })

    expect(row).toMatchObject({
      runId: 'run-eval-1',
      source: {
        label: 'baseline-edit',
        provider: 'api.deepseek.com',
        model: 'deepseek-v4-pro',
      },
      status: 'failed',
      totalSteps: 15,
      failureClass: 'archive_recall_finalization',
      disposition: 'runtime_follow_up_if_repeated',
      failureSignal: 'BUDGET_EXHAUSTED after archive finalization detour',
    })
    expect(row?.toolHistory).toEqual([
      {
        index: 0,
        role: 'tool',
        toolName: 'coding_read_archived_context',
        resultOk: false,
        status: 'exception',
        argsPreview: '{"artifactId":"0-2-compacted.md"}',
        summary: undefined,
        error: 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search',
      },
    ])
  })

  it('preserves terminal cwd evidence from transcript backend records', () => {
    const row = buildCodingEvalReplayRow({
      source: { label: 'baseline-edit' },
      result: makeToolResult({
        runId: 'run-eval-2',
        status: 'completed',
        totalSteps: 4,
      }),
      transcriptTools: [
        {
          entryId: 2,
          tool: 'terminal_exec',
          args: { command: 'cat index.ts', cwd: '/Users/liuziheng/airi' },
          ok: false,
          status: 'exception',
          error: 'cat: index.ts: No such file or directory',
          backend: {
            command: 'cat index.ts',
            effectiveCwd: '/Users/liuziheng/airi',
            terminalState: { effectiveCwd: '/tmp/fixture' },
            exitCode: 1,
            timedOut: false,
            stderr: 'cat: index.ts: No such file or directory',
          },
        },
      ],
    })

    expect(row?.failureClass).toBe('cwd_terminal_detour')
    expect(row?.terminalEvidence).toEqual([
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

  it('returns undefined for non-runner tool results', () => {
    expect(buildCodingEvalReplayRow({
      source: { label: 'agentic-loop' },
      result: makeToolResult({ status: 'ok' }),
      transcriptTools: [],
    })).toBeUndefined()
  })

  it('infers provider labels from base URLs without requiring valid URLs', () => {
    expect(inferEvalProviderLabel('https://api.deepseek.com/v1')).toBe('api.deepseek.com')
    expect(inferEvalProviderLabel('not-a-url')).toBe('not-a-url')
    expect(inferEvalProviderLabel(undefined)).toBeUndefined()
  })
})
