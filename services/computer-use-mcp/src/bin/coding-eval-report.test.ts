import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { persistCodingEvalReport, resolveCodingEvalReportPath } from './coding-eval-report'

describe('coding eval report persistence', () => {
  it('does not write when report path is unset or blank', async () => {
    await expect(persistCodingEvalReport({ ok: true })).resolves.toEqual({ wrote: false })
    await expect(persistCodingEvalReport({ ok: true }, { reportPath: '   ' })).resolves.toEqual({ wrote: false })
  })

  it('resolves relative report paths against the provided cwd', async () => {
    expect(resolveCodingEvalReportPath('reports/eval.json', '/tmp/airi-eval')).toBe('/tmp/airi-eval/reports/eval.json')
    expect(resolveCodingEvalReportPath('/tmp/absolute-eval.json', '/tmp/airi-eval')).toBe('/tmp/absolute-eval.json')
    expect(resolveCodingEvalReportPath('', '/tmp/airi-eval')).toBeUndefined()
  })

  it('creates parent directories and writes pretty JSON with a trailing newline', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coding-eval-report-test-'))
    const result = await persistCodingEvalReport({
      codingLiveFailureReplaySummary: {
        totalRows: 1,
        entries: [{ nextFollowUp: 'test(computer-use-mcp): add deterministic replay' }],
      },
    }, {
      cwd,
      reportPath: 'nested/report.json',
    })

    expect(result).toEqual({
      wrote: true,
      path: join(cwd, 'nested', 'report.json'),
    })
    await expect(readFile(result.path!, 'utf8')).resolves.toBe([
      '{',
      '  "codingLiveFailureReplaySummary": {',
      '    "totalRows": 1,',
      '    "entries": [',
      '      {',
      '        "nextFollowUp": "test(computer-use-mcp): add deterministic replay"',
      '      }',
      '    ]',
      '  }',
      '}',
      '',
    ].join('\n'))
  })
})
