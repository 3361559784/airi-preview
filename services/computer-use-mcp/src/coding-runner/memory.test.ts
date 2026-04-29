import type { RunState } from '../state'

import { describe, expect, it } from 'vitest'

import { TASK_MEMORY_LIMITS } from '../task-memory/types'
import {
  buildArchiveRecallFinalizationMemory,
  buildBudgetExhaustedMemory,
  buildReportStatusMemory,
  buildSuccessfulToolEvidenceMemory,
  buildTextOnlyReportRequiredMemory,
  buildToolFailureMemory,
  buildVerificationGateFailureMemory,
  formatEvidencePin,
} from './memory'

function codingState(overrides: Partial<NonNullable<RunState['coding']>> = {}): NonNullable<RunState['coding']> {
  return {
    workspacePath: '/workspace/project',
    gitSummary: 'clean',
    recentReads: [],
    recentEdits: [],
    recentCommandResults: [],
    recentSearches: [],
    pendingIssues: [],
    ...overrides,
  }
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    pendingApprovalCount: 0,
    lastApprovalRejected: false,
    ptySessions: [],
    workflowStepTerminalBindings: [],
    ptyApprovalGrants: [],
    ptyAuditLog: [],
    handoffHistory: [],
    updatedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  }
}

describe('coding runner evidence pin memory', () => {
  it('keeps evidence pin count and formatting limits explicit', () => {
    expect(TASK_MEMORY_LIMITS.evidencePins).toBe(8)

    const pin = formatEvidencePin(
      'tool_failure:coding_apply_patch',
      '\u0000 Patch\n\t failed   because old string was missing',
    )
    expect(pin).toBe('tool_failure:coding_apply_patch: Patch failed because old string was missing')

    expect(formatEvidencePin('terminal_result:node check.js', 'x'.repeat(400))).toHaveLength(240)
  })

  it('builds current failure evidence pins with stable prefixes', () => {
    const budget = buildBudgetExhaustedMemory({
      maxSteps: 15,
      lastToolName: 'coding_search_text',
      lastFailureSummary: 'outside workspace validation detour',
    })
    expect(budget.evidencePins?.[0]).toContain('budget_exhausted:maxSteps=15')
    expect(budget.evidencePins?.[0]).toContain('lastTool=coding_search_text')

    const toolFailure = buildToolFailureMemory({
      toolName: 'coding_apply_patch',
      summary: 'PATCH_MISMATCH',
    })
    expect(toolFailure.evidencePins).toEqual(['tool_failure:coding_apply_patch: PATCH_MISMATCH'])

    const gateFailure = buildVerificationGateFailureMemory({
      reasonCode: 'verification_bad_faith',
      summary: 'Report needs source-backed evidence.',
    })
    expect(gateFailure.evidencePins).toEqual([
      'verification_gate_failed:verification_bad_faith: Report needs source-backed evidence.',
    ])

    const archiveDenial = buildArchiveRecallFinalizationMemory('ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search')
    expect(archiveDenial.evidencePins).toEqual([
      'archive_recall_denied: ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search',
    ])

    const report = buildReportStatusMemory({
      status: 'completed',
      summary: 'Validation passed.',
    })
    expect(report.evidencePins).toEqual(['reported_status:completed: Validation passed.'])
  })

  it('keeps text-only final recovery out of evidence pins', () => {
    const memory = buildTextOnlyReportRequiredMemory('Everything is done.')

    expect(memory.recentFailureReason).toContain('text-only response')
    expect(memory.nextStep).toContain('only coding_report_status')
    expect(memory.nextStep).toContain('Do not request Bash')
    expect(memory.evidencePins).toBeUndefined()
  })

  it('pins successful apply_patch evidence only when mutation proof is verified', () => {
    const memory = buildSuccessfulToolEvidenceMemory({
      toolName: 'coding_apply_patch',
      toolArgs: { filePath: 'src/app.ts' },
      toolBackend: { file: 'src/app.ts' },
      state: runState({
        coding: codingState({
          recentEdits: [{
            path: 'src/app.ts',
            summary: 'updated config flag',
            mutationProof: {
              matchedOldString: 'DEBUG_MODE',
              beforeHash: 'before',
              afterHash: 'after',
              occurrencesMatched: 1,
              readbackVerified: true,
            },
          }],
        }),
      }),
    })

    expect(memory?.evidencePins).toEqual([
      'edit_proof:src/app.ts: readbackVerified=true beforeHash!=afterHash summary=updated config flag',
    ])

    const unverified = buildSuccessfulToolEvidenceMemory({
      toolName: 'coding_apply_patch',
      toolArgs: { filePath: 'src/app.ts' },
      toolBackend: { file: 'src/app.ts' },
      state: runState({
        coding: codingState({
          recentEdits: [{
            path: 'src/app.ts',
            summary: 'updated config flag',
            mutationProof: {
              matchedOldString: 'DEBUG_MODE',
              beforeHash: 'same',
              afterHash: 'same',
              occurrencesMatched: 1,
              readbackVerified: true,
            },
          }],
        }),
      }),
    })

    expect(unverified).toBeUndefined()
  })

  it('pins terminal and review evidence from matching runtime state', () => {
    const terminal = buildSuccessfulToolEvidenceMemory({
      toolName: 'terminal_exec',
      toolArgs: { command: 'node check.js' },
      toolBackend: {},
      state: runState({
        lastTerminalResult: {
          command: 'node check.js',
          stdout: 'ok',
          stderr: '',
          exitCode: 0,
          effectiveCwd: '/workspace/project',
          durationMs: 12,
          timedOut: false,
        },
      }),
    })
    expect(terminal?.evidencePins).toEqual(['terminal_result:node check.js: exitCode=0 timedOut=false'])

    const review = buildSuccessfulToolEvidenceMemory({
      toolName: 'coding_review_changes',
      toolArgs: {},
      toolBackend: { status: 'ready_for_next_file' },
      state: runState({
        coding: codingState({
          lastChangeReview: {
            status: 'ready_for_next_file',
            filesReviewed: ['src/app.ts'],
            diffSummary: 'Renamed debug flag.',
            validationSummary: 'node check.js passed.',
            validationCommand: 'node check.js',
            detectedRisks: [],
            unresolvedIssues: [],
            recommendedNextAction: 'Report completed.',
          },
        }),
      }),
    })
    expect(review?.evidencePins).toEqual([
      'change_review:ready_for_next_file: validation=node check.js unresolved=0',
    ])
  })
})
