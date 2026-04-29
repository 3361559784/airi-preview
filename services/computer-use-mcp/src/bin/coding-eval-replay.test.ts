import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { describe, expect, it } from 'vitest'

import { buildCodingEvalReplayRow, inferEvalProviderLabel, summarizeCodingEvalReplayRows } from './coding-eval-replay'

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
        status: 'failed',
        totalSteps: 4,
        lastError: 'BUDGET_EXHAUSTED after terminal cwd detour',
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

  it('does not build failure replay rows for completed runner results', () => {
    const row = buildCodingEvalReplayRow({
      source: { label: 'baseline-edit' },
      result: makeToolResult({
        runId: 'run-eval-completed',
        status: 'completed',
        totalSteps: 12,
      }),
      transcriptTools: [
        {
          entryId: 1,
          tool: 'coding_search_text',
          args: { query: 'DEBUG_MODE', targetPath: '.' },
          ok: true,
          status: 'ok',
          backend: { total: 8 },
        },
        {
          entryId: 2,
          tool: 'terminal_exec',
          args: { command: 'node check.js', cwd: '/tmp/workspace' },
          ok: true,
          status: 'executed',
          backend: {
            command: 'node check.js',
            effectiveCwd: '/tmp/workspace',
            exitCode: 0,
            timedOut: false,
            stdout: 'Check Passed',
          },
        },
      ],
    })

    expect(row).toBeUndefined()
    expect(summarizeCodingEvalReplayRows(row ? [row] : [])).toEqual({
      totalRows: 0,
      completedRows: 0,
      failedRows: 0,
      providerObservationRows: 0,
      runtimeFollowUpRows: 0,
      deterministicReplayRows: 0,
      unknownRows: 0,
      entries: [],
    })
  })

  it('maps outside-workspace validation detours from live eval reports', () => {
    const row = buildCodingEvalReplayRow({
      source: {
        label: 'baseline-edit',
        provider: 'api.deepseek.com',
        model: 'deepseek-v4-pro',
      },
      result: makeToolResult({
        runId: 'run-eval-outside-workspace',
        status: 'failed',
        totalSteps: 15,
        lastError: 'BUDGET_EXHAUSTED: coding runner reached maxSteps=15 without an accepted terminal report. lastTool=coding_search_text lastFailure=MCP error -32602: Search targetPath /Users/liuziheng/airi-coding-line is outside workspace /var/folders/xsai-governor-eval-kymz7M',
      }),
      transcriptTools: [
        {
          entryId: 11,
          tool: 'coding_search_text',
          args: {
            query: 'DEBUG_MODE',
            targetPath: '/Users/liuziheng/airi-coding-line',
          },
          ok: false,
          status: 'exception',
          error: 'MCP error -32602: Search targetPath /Users/liuziheng/airi-coding-line is outside workspace /var/folders/xsai-governor-eval-kymz7M',
        },
      ],
    })

    expect(row).toMatchObject({
      runId: 'run-eval-outside-workspace',
      status: 'failed',
      totalSteps: 15,
      failureClass: 'outside_workspace_validation_detour',
      disposition: 'deterministic_replay_first',
    })
    expect(row?.classificationSummary).toContain('workspace guard')
    expect(row?.toolHistory).toEqual([
      {
        index: 0,
        role: 'tool',
        toolName: 'coding_search_text',
        resultOk: false,
        status: 'exception',
        argsPreview: '{"query":"DEBUG_MODE","targetPath":"/Users/liuziheng/airi-coding-line"}',
        summary: undefined,
        error: 'MCP error -32602: Search targetPath /Users/liuziheng/airi-coding-line is outside workspace /var/folders/xsai-governor-eval-kymz7M',
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

  it('preserves source metadata without using it as classification authority', () => {
    const row = buildCodingEvalReplayRow({
      source: {
        label: 'provider-capacity-looking-run',
        provider: 'api.deepseek.com',
        model: 'deepseek-v4-pro',
        logPath: '/tmp/coding-eval-provider.log',
      },
      result: makeToolResult({
        runId: 'run-eval-source-metadata',
        status: 'failed',
        totalSteps: 2,
        lastError: 'model stopped for an unexplained reason',
      }),
      transcriptTools: [],
    })

    expect(row).toMatchObject({
      source: {
        label: 'provider-capacity-looking-run',
        provider: 'api.deepseek.com',
        model: 'deepseek-v4-pro',
        logPath: '/tmp/coding-eval-provider.log',
      },
      failureClass: 'unknown',
      disposition: 'deterministic_replay_first',
    })
  })

  it('summarizes replay rows into follow-up mapping entries', () => {
    const rows = [
      buildCodingEvalReplayRow({
        source: { label: 'baseline-edit' },
        result: makeToolResult({
          runId: 'run-eval-outside-workspace',
          status: 'failed',
          totalSteps: 15,
          lastError: 'BUDGET_EXHAUSTED: coding runner reached maxSteps=15 without an accepted terminal report. lastTool=coding_search_text lastFailure=MCP error -32602: Search targetPath /Users/liuziheng/airi-coding-line is outside workspace /var/folders/xsai-governor-eval-kymz7M',
        }),
        transcriptTools: [],
      }),
      buildCodingEvalReplayRow({
        source: { label: 'analysis-report' },
        result: makeToolResult({
          runId: 'run-eval-archive',
          status: 'failed',
          totalSteps: 10,
          lastError: 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search',
        }),
        transcriptTools: [],
      }),
      buildCodingEvalReplayRow({
        source: { label: 'provider-smoke' },
        result: makeToolResult({
          runId: 'run-eval-provider',
          status: 'failed',
          totalSteps: 1,
          lastError: 'Remote sent 429 response: upstream load saturated',
        }),
        transcriptTools: [],
      }),
    ].filter((row): row is NonNullable<typeof row> => Boolean(row))

    expect(summarizeCodingEvalReplayRows(rows)).toEqual({
      totalRows: 3,
      completedRows: 0,
      failedRows: 3,
      providerObservationRows: 1,
      runtimeFollowUpRows: 1,
      deterministicReplayRows: 1,
      unknownRows: 0,
      entries: [
        {
          label: 'baseline-edit',
          runId: 'run-eval-outside-workspace',
          status: 'failed',
          failureClass: 'outside_workspace_validation_detour',
          disposition: 'deterministic_replay_first',
          failureSignal: 'BUDGET_EXHAUSTED: coding runner reached maxSteps=15 without an accepted terminal report. lastTool=coding_search_text lastFailure=MCP error -32602: Search targetPath /Users/liuziheng/airi-coding-line is outside workspace /var/folders/xsai-governor-eval-kymz7M',
          nextFollowUp: 'fix(coding-runner): constrain validation recovery to workspace cwd',
          deterministicAnchor: 'src/bin/coding-eval-replay.test.ts outside-workspace validation detour classification',
        },
        {
          label: 'analysis-report',
          runId: 'run-eval-archive',
          status: 'failed',
          failureClass: 'archive_recall_finalization',
          disposition: 'runtime_follow_up_if_repeated',
          failureSignal: 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search',
          nextFollowUp: 'fix(coding-runner): recover analysis report after archive recall denial',
          deterministicAnchor: 'src/coding-runner/coding-runner.test.ts archive recall finalization cases',
        },
        {
          label: 'provider-smoke',
          runId: 'run-eval-provider',
          status: 'failed',
          failureClass: 'provider_capacity_or_latency',
          disposition: 'provider_observation_only',
          failureSignal: 'Remote sent 429 response: upstream load saturated',
          nextFollowUp: 'docs(computer-use-mcp): record provider matrix observation',
          deterministicAnchor: 'coding-provider-eval-observations.md provider matrix notes',
        },
      ],
    })
  })

  it('summarizes unknown rows with a deterministic replay fallback follow-up', () => {
    const row = buildCodingEvalReplayRow({
      source: { label: 'unmapped' },
      result: makeToolResult({
        runId: 'run-eval-unknown',
        status: 'failed',
        totalSteps: 2,
        lastError: 'model stopped for an unexplained reason',
      }),
      transcriptTools: [],
    })

    expect(summarizeCodingEvalReplayRows(row ? [row] : [])).toMatchObject({
      unknownRows: 1,
      deterministicReplayRows: 1,
      entries: [{
        label: 'unmapped',
        failureClass: 'unknown',
        nextFollowUp: 'test(computer-use-mcp): add deterministic replay for unmapped coding live failure',
        deterministicAnchor: undefined,
      }],
    })
  })

  it('infers provider labels from base URLs without requiring valid URLs', () => {
    expect(inferEvalProviderLabel('https://api.deepseek.com/v1')).toBe('api.deepseek.com')
    expect(inferEvalProviderLabel('not-a-url')).toBe('not-a-url')
    expect(inferEvalProviderLabel(undefined)).toBeUndefined()
  })
})
