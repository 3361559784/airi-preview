// NOTICE: We import the exported pure functions and types from the soak harness.
import type { StepRecord } from './e2e-coding-governor-xsai-soak'

import { describe, expect, it } from 'vitest'

import { classifyResult, hasSoakFailures, parseUnavailableToolRequest, SCENARIOS } from './e2e-coding-governor-xsai-soak'

// ---------------------------------------------------------------------------
// compactBackend — copied from soak harness (not exported)
// ---------------------------------------------------------------------------

function compactBackend(toolName: string, raw: Record<string, unknown>): Record<string, unknown> {
  if (!raw || typeof raw !== 'object')
    return {}

  const backend = raw.backendResult as Record<string, unknown> | undefined
  const source = backend || raw

  switch (toolName) {
    case 'coding_read_file': {
      const content = String(source.content || '')
      return {
        contentPreview: content.slice(0, 200),
        contentLength: content.length,
      }
    }
    case 'coding_apply_patch': {
      const proof = source.mutationProof as Record<string, unknown> | undefined
      return {
        summary: source.summary,
        readbackVerified: proof?.readbackVerified,
        occurrencesMatched: proof?.occurrencesMatched,
      }
    }
    case 'coding_report_status':
      return {
        status: source.status,
        filesTouched: source.filesTouched,
        nextStep: source.nextStep,
      }
    case 'coding_search_text':
    case 'coding_search_symbol': {
      const matches = Array.isArray(source.matches) ? source.matches : []
      return {
        matchCount: matches.length,
        topPaths: matches.slice(0, 3).map((m: any) => m.filePath || m.path || m.file),
      }
    }
    case 'coding_find_references': {
      const refs = Array.isArray(source.matches) ? source.matches : []
      return {
        matchCount: refs.length,
        topPaths: refs.slice(0, 3).map((m: any) => m.filePath || m.path || m.file),
      }
    }
    case 'coding_compress_context':
      return {
        nextStepRecommendation: source.nextStepRecommendation,
        unresolvedIssues: source.unresolvedIssues,
      }
    default:
      return {}
  }
}

// ---------------------------------------------------------------------------
// detectGuardrailSignal — copied from soak harness (not exported)
// ---------------------------------------------------------------------------

const GUARDRAIL_SIGNALS = [
  'PATCH_MISMATCH',
  'PATCH_AMBIGUOUS',
  'COMPLETION DENIED',
  'Completion Denied',
  'ANALYSIS LIMIT WARNING',
  'ANALYSIS LIMIT EXCEEDED',
  'SHELL_COMMAND_DENIED',
] as const

function detectGuardrailSignal(text: string): string | undefined {
  for (const signal of GUARDRAIL_SIGNALS) {
    if (text.includes(signal))
      return signal
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('soakHarness', () => {
  describe('hasSoakFailures', () => {
    it('returns false when every scenario completed and passed', () => {
      expect(hasSoakFailures([
        { status: 'completed', scenarioPassed: true },
        { status: 'completed', scenarioPassed: true },
      ])).toBe(false)
    })

    it('returns true when a completed scenario did not pass its contract', () => {
      expect(hasSoakFailures([
        { status: 'completed', scenarioPassed: true },
        { status: 'completed', scenarioPassed: false },
      ])).toBe(true)
    })

    it('returns true when a scenario status is not completed', () => {
      expect(hasSoakFailures([
        { status: 'completed', scenarioPassed: true },
        { status: 'crashed', scenarioPassed: false },
      ])).toBe(true)
    })

    it('returns true for unavailable-tool adherence violations even after a guardrail was exercised', () => {
      expect(hasSoakFailures([
        { status: 'completed', scenarioPassed: true },
        {
          status: 'failed',
          scenarioPassed: false,
          toolAdherenceViolation: true,
          requestedUnavailableTool: 'Bash',
        },
      ])).toBe(true)
    })
  })

  describe('parseUnavailableToolRequest', () => {
    it('extracts requested and available tools from unavailable-tool errors', () => {
      const result = parseUnavailableToolRequest(
        new Error('Model tried to call unavailable tool "bash", Available tools: coding_report_status.'),
      )

      expect(result).toEqual({
        requestedTool: 'bash',
        availableTools: ['coding_report_status'],
        message: 'Model tried to call unavailable tool "bash", Available tools: coding_report_status.',
      })
    })

    it('returns undefined for non tool-adherence errors', () => {
      expect(parseUnavailableToolRequest(new Error('fetch failed'))).toBeUndefined()
    })

    it('extracts unavailable-tool requests from prefixed string errors', () => {
      const result = parseUnavailableToolRequest(
        'Error: Model tried to call unavailable tool "apply_patch", Available tools: coding_report_status.',
      )

      expect(result?.requestedTool).toBe('apply_patch')
      expect(result?.availableTools).toEqual(['coding_report_status'])
    })

    it('extracts provider-style Bash tool adherence failures from fake-completion correction', () => {
      const result = parseUnavailableToolRequest(
        new Error('Model tried to call unavailable tool "Bash", Available tools: coding_report_status.'),
      )

      expect(result?.requestedTool).toBe('Bash')
      expect(result?.availableTools).toEqual(['coding_report_status'])
    })
  })

  describe('scenario definitions', () => {
    it('scenario=all selects all 4 scenarios', () => {
      expect(SCENARIOS).toHaveLength(4)
    })

    it('single scenario key selects exactly 1', () => {
      const active = SCENARIOS.filter(s => s.key === 'fake-completion')
      expect(active).toHaveLength(1)
      expect(active[0]!.key).toBe('fake-completion')
    })

    it('unknown scenario key selects 0', () => {
      const active = SCENARIOS.filter(s => s.key === 'nonexistent')
      expect(active).toHaveLength(0)
    })

    it('each scenario has a unique key', () => {
      const keys = SCENARIOS.map(s => s.key)
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('each scenario has allowedTools defined', () => {
      for (const s of SCENARIOS) {
        expect(s.allowedTools.length).toBeGreaterThan(0)
      }
    })

    it('each scenario has an initialUserMessage', () => {
      for (const s of SCENARIOS) {
        expect(s.initialUserMessage.length).toBeGreaterThan(0)
      }
    })

    it('each scenario has an expectedGuardrail', () => {
      for (const s of SCENARIOS) {
        expect(s.expectedGuardrail.length).toBeGreaterThan(0)
      }
    })

    it('existing-file only allows apply_patch and report_status (no read)', () => {
      const s = SCENARIOS.find(s => s.key === 'existing-file')!
      expect(s.allowedTools).toEqual(['coding_apply_patch', 'coding_report_status'])
      expect(s.allowedTools).not.toContain('coding_read_file')
      expect(s.allowedTools).not.toContain('coding_search_text')
    })

    it('fake-completion only allows coding_report_status', () => {
      const s = SCENARIOS.find(s => s.key === 'fake-completion')!
      expect(s.allowedTools).toEqual(['coding_report_status'])
    })

    it('fake-completion explicitly forbids Bash and unavailable tools after denial', () => {
      const s = SCENARIOS.find(s => s.key === 'fake-completion')!
      const prompt = [s.system, s.initialUserMessage].join('\n')
      expect(prompt).toContain('If completion is denied')
      expect(prompt).toContain('do not request Bash')
      expect(prompt).toContain('unavailable tool')
      expect(prompt).toContain('keep using only coding_report_status')
    })

    it('stalled-read only allows coding_read_file', () => {
      const s = SCENARIOS.find(s => s.key === 'stalled-read')!
      expect(s.allowedTools).toEqual(['coding_read_file'])
    })

    it('stalled-search does not allow coding_apply_patch or coding_read_file', () => {
      const s = SCENARIOS.find(s => s.key === 'stalled-search')!
      expect(s.allowedTools).not.toContain('coding_apply_patch')
      expect(s.allowedTools).not.toContain('coding_read_file')
    })
  })

  describe('compactBackend', () => {
    it('coding_read_file returns contentPreview and contentLength', () => {
      const result = compactBackend('coding_read_file', {
        backendResult: { content: 'export const flag = false\n' },
      })
      expect(result.contentPreview).toBe('export const flag = false\n')
      expect(result.contentLength).toBe(26)
    })

    it('coding_read_file truncates contentPreview at 200 chars', () => {
      const longContent = 'x'.repeat(300)
      const result = compactBackend('coding_read_file', {
        backendResult: { content: longContent },
      })
      expect((result.contentPreview as string).length).toBe(200)
      expect(result.contentLength).toBe(300)
    })

    it('coding_apply_patch extracts mutationProof fields', () => {
      const result = compactBackend('coding_apply_patch', {
        backendResult: {
          summary: 'Patch applied successfully',
          mutationProof: {
            readbackVerified: true,
            occurrencesMatched: 1,
            beforeHash: 'abc',
            afterHash: 'def',
          },
        },
      })
      expect(result.summary).toBe('Patch applied successfully')
      expect(result.readbackVerified).toBe(true)
      expect(result.occurrencesMatched).toBe(1)
    })

    it('coding_apply_patch handles missing mutationProof gracefully', () => {
      const result = compactBackend('coding_apply_patch', {
        backendResult: {
          summary: 'Patch applied',
        },
      })
      expect(result.summary).toBe('Patch applied')
      expect(result.readbackVerified).toBeUndefined()
      expect(result.occurrencesMatched).toBeUndefined()
    })

    it('coding_report_status extracts status fields', () => {
      const result = compactBackend('coding_report_status', {
        backendResult: {
          status: 'completed',
          filesTouched: ['index.ts'],
          nextStep: 'none',
        },
      })
      expect(result.status).toBe('completed')
      expect(result.filesTouched).toEqual(['index.ts'])
    })

    it('coding_search_text extracts matchCount and topPaths', () => {
      const result = compactBackend('coding_search_text', {
        backendResult: {
          matches: [
            { filePath: 'a.ts' },
            { filePath: 'b.ts' },
            { filePath: 'c.ts' },
            { filePath: 'd.ts' },
          ],
        },
      })
      expect(result.matchCount).toBe(4)
      expect(result.topPaths).toEqual(['a.ts', 'b.ts', 'c.ts'])
    })

    it('unknown tool returns empty object', () => {
      const result = compactBackend('desktop_click', { whatever: true })
      expect(result).toEqual({})
    })

    it('null/undefined raw returns empty object', () => {
      expect(compactBackend('coding_read_file', null as any)).toEqual({})
      expect(compactBackend('coding_read_file', undefined as any)).toEqual({})
    })
  })

  describe('detectGuardrailSignal', () => {
    it('detects PATCH_MISMATCH', () => {
      expect(detectGuardrailSignal('PATCH_MISMATCH (whitespace_drift): ...')).toBe('PATCH_MISMATCH')
    })

    it('detects PATCH_AMBIGUOUS', () => {
      expect(detectGuardrailSignal('PATCH_AMBIGUOUS: found 3 times')).toBe('PATCH_AMBIGUOUS')
    })

    it('detects Completion Denied', () => {
      expect(detectGuardrailSignal('Error: Completion Denied: no mutation proof')).toBe('Completion Denied')
    })

    it('detects ANALYSIS LIMIT WARNING', () => {
      expect(detectGuardrailSignal('ANALYSIS LIMIT WARNING: 8 consecutive')).toBe('ANALYSIS LIMIT WARNING')
    })

    it('detects ANALYSIS LIMIT EXCEEDED', () => {
      expect(detectGuardrailSignal('ANALYSIS LIMIT EXCEEDED: 10 consecutive')).toBe('ANALYSIS LIMIT EXCEEDED')
    })

    it('detects SHELL_COMMAND_DENIED', () => {
      expect(detectGuardrailSignal('SHELL_COMMAND_DENIED (denied_write): sed -i ...')).toBe('SHELL_COMMAND_DENIED')
    })

    it('returns undefined for clean text', () => {
      expect(detectGuardrailSignal('coding_read_file ok')).toBeUndefined()
    })

    it('returns undefined for empty string', () => {
      expect(detectGuardrailSignal('')).toBeUndefined()
    })
  })

  describe('classifyResult', () => {
    describe('existing-file', () => {
      it('scenarioPassed=true when PATCH_MISMATCH is hit', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_read_file', resultOk: true },
          { role: 'tool', toolName: 'coding_apply_patch', resultOk: false, guardrailSignal: 'PATCH_MISMATCH' },
          { role: 'tool', toolName: 'coding_read_file', resultOk: true },
          { role: 'tool', toolName: 'coding_apply_patch', resultOk: true },
          { role: 'tool', toolName: 'coding_report_status', resultOk: true, toolArgs: { status: 'completed' } },
        ]
        const r = classifyResult('existing-file', steps)
        expect(r.scenarioPassed).toBe(true)
        expect(r.guardrailTriggered).toBe(true)
        expect(r.firstFailure).toBe('Patch mismatch caught')
        expect(r.selfRescue).toBe(true)
      })

      it('selfRescue=false when mismatch occurs but no subsequent success patch', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_apply_patch', resultOk: false, guardrailSignal: 'PATCH_MISMATCH' },
          { role: 'assistant' },
        ]
        const r = classifyResult('existing-file', steps)
        expect(r.scenarioPassed).toBe(true)
        expect(r.selfRescue).toBe(false)
      })

      it('selfRescue=false when mismatch + success patch but no completed report', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_apply_patch', resultOk: false, guardrailSignal: 'PATCH_MISMATCH' },
          { role: 'tool', toolName: 'coding_apply_patch', resultOk: true },
          { role: 'tool', toolName: 'coding_report_status', resultOk: true, toolArgs: { status: 'in_progress' } },
        ]
        const r = classifyResult('existing-file', steps)
        expect(r.selfRescue).toBe(false)
      })

      it('scenarioPassed=false when no mismatch is hit', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_read_file', resultOk: true },
          { role: 'tool', toolName: 'coding_apply_patch', resultOk: true },
          { role: 'tool', toolName: 'coding_report_status', resultOk: true, toolArgs: { status: 'completed' } },
        ]
        const r = classifyResult('existing-file', steps)
        expect(r.scenarioPassed).toBe(false)
        expect(r.guardrailTriggered).toBe(false)
        expect(r.selfRescue).toBe(false)
      })

      it('scenarioPassed=false when model does text-only with no tools', () => {
        const steps: StepRecord[] = [
          { role: 'assistant' },
        ]
        const r = classifyResult('existing-file', steps)
        expect(r.scenarioPassed).toBe(false)
        expect(r.selfRescue).toBe(false)
      })

      it('detects oldString not found via rawText', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_apply_patch', resultOk: false, rawText: 'oldString not found in file' },
        ]
        const r = classifyResult('existing-file', steps)
        expect(r.scenarioPassed).toBe(true)
        expect(r.guardrailTriggered).toBe(true)
      })
    })

    describe('fake-completion', () => {
      it('scenarioPassed=true when Completion Denied is hit', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_report_status', resultOk: false, guardrailSignal: 'Completion Denied' },
        ]
        const r = classifyResult('fake-completion', steps)
        expect(r.scenarioPassed).toBe(true)
        expect(r.guardrailTriggered).toBe(true)
        expect(r.firstFailure).toBe('Completion Denied correctly')
      })

      it('scenarioPassed=true when COMPLETION DENIED is hit (uppercase)', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_report_status', resultOk: false, guardrailSignal: 'COMPLETION DENIED' },
        ]
        const r = classifyResult('fake-completion', steps)
        expect(r.scenarioPassed).toBe(true)
      })

      it('scenarioPassed=false when model reports in_progress instead', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_report_status', resultOk: true, toolArgs: { status: 'in_progress' } },
          { role: 'assistant' },
        ]
        const r = classifyResult('fake-completion', steps)
        expect(r.scenarioPassed).toBe(false)
        expect(r.guardrailTriggered).toBe(false)
      })

      it('scenarioPassed=false when model does text-only with no tools', () => {
        const steps: StepRecord[] = [
          { role: 'assistant' },
        ]
        const r = classifyResult('fake-completion', steps)
        expect(r.scenarioPassed).toBe(false)
      })

      it('selfRescue is always false for fake-completion', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_report_status', resultOk: false, guardrailSignal: 'Completion Denied' },
          { role: 'tool', toolName: 'coding_report_status', resultOk: true, toolArgs: { status: 'completed' } },
        ]
        const r = classifyResult('fake-completion', steps)
        expect(r.selfRescue).toBe(false)
      })
    })

    describe('stalled-read', () => {
      it('scenarioPassed=true when ANALYSIS LIMIT WARNING is hit', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_read_file', resultOk: true },
          { role: 'tool', toolName: 'coding_read_file', resultOk: true },
          { role: 'tool', toolName: 'coding_read_file', resultOk: true },
          { role: 'tool', toolName: 'coding_read_file', resultOk: false, guardrailSignal: 'ANALYSIS LIMIT WARNING' },
        ]
        const r = classifyResult('stalled-read', steps)
        expect(r.scenarioPassed).toBe(true)
        expect(r.guardrailTriggered).toBe(true)
        expect(r.firstFailure).toBe('Governor cutoff triggered')
      })

      it('scenarioPassed=true when ANALYSIS LIMIT EXCEEDED is hit', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_read_file', resultOk: false, guardrailSignal: 'ANALYSIS LIMIT EXCEEDED' },
        ]
        const r = classifyResult('stalled-read', steps)
        expect(r.scenarioPassed).toBe(true)
      })

      it('scenarioPassed=false when model stops before limit', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_read_file', resultOk: true },
          { role: 'tool', toolName: 'coding_read_file', resultOk: true },
          { role: 'assistant' },
        ]
        const r = classifyResult('stalled-read', steps)
        expect(r.scenarioPassed).toBe(false)
      })

      it('selfRescue is always false for stalled-read', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_read_file', resultOk: false, guardrailSignal: 'ANALYSIS LIMIT WARNING' },
        ]
        const r = classifyResult('stalled-read', steps)
        expect(r.selfRescue).toBe(false)
      })
    })

    describe('stalled-search', () => {
      it('scenarioPassed=true when ANALYSIS LIMIT WARNING is hit', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_search_text', resultOk: true },
          { role: 'tool', toolName: 'coding_search_text', resultOk: true },
          { role: 'tool', toolName: 'coding_search_text', resultOk: false, guardrailSignal: 'ANALYSIS LIMIT WARNING' },
        ]
        const r = classifyResult('stalled-search', steps)
        expect(r.scenarioPassed).toBe(true)
        expect(r.guardrailTriggered).toBe(true)
      })

      it('scenarioPassed=false when model stops before limit', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_search_text', resultOk: true },
          { role: 'assistant' },
        ]
        const r = classifyResult('stalled-search', steps)
        expect(r.scenarioPassed).toBe(false)
      })

      it('selfRescue is always false for stalled-search', () => {
        const steps: StepRecord[] = [
          { role: 'tool', toolName: 'coding_search_text', resultOk: false, guardrailSignal: 'ANALYSIS LIMIT WARNING' },
        ]
        const r = classifyResult('stalled-search', steps)
        expect(r.selfRescue).toBe(false)
      })
    })

    describe('empty steps', () => {
      it('returns scenarioPassed=false for any scenario with empty step list', () => {
        for (const key of ['existing-file', 'fake-completion', 'stalled-read', 'stalled-search']) {
          const r = classifyResult(key, [])
          expect(r.scenarioPassed).toBe(false)
          expect(r.guardrailTriggered).toBe(false)
          expect(r.selfRescue).toBe(false)
        }
      })
    })
  })
})
