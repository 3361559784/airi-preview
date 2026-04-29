import type { CodingLiveFailureClass } from './live-failure-corpus'

import { describe, expect, it } from 'vitest'

import {
  classifyCodingLiveFailureText,
  CODING_LIVE_FAILURE_REPLAY_CORPUS,

  findCodingLiveFailureReplayCase,
} from './live-failure-corpus'

const EXPECTED_REPLAY_CLASSES: Exclude<CodingLiveFailureClass, 'unknown'>[] = [
  'archive_recall_finalization',
  'completion_denied_missing_mutation_proof',
  'cwd_terminal_detour',
  'outside_workspace_validation_detour',
  'provider_capacity_or_latency',
  'report_only_text_final',
  'report_only_tool_adherence',
  'report_only_verification_gate',
  'shell_misuse_recovery',
  'stalled_exploration_governor',
]

describe('coding live failure replay corpus', () => {
  it('keeps corpus ids and deterministic anchors explicit', () => {
    const ids = CODING_LIVE_FAILURE_REPLAY_CORPUS.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    const failureClasses = CODING_LIVE_FAILURE_REPLAY_CORPUS.map(entry => entry.failureClass)
    expect(new Set(failureClasses).size).toBe(failureClasses.length)

    for (const entry of CODING_LIVE_FAILURE_REPLAY_CORPUS) {
      expect(entry.observedSignal).not.toHaveLength(0)
      expect(entry.deterministicAnchor).toMatch(/\.ts|\.md/)
      expect(entry.nextFollowUp).toMatch(/^(test|fix|docs)\(/)
      expect(entry.sample).not.toHaveLength(0)
    }
  })

  it('has exactly one replay case and follow-up for each non-unknown failure class', () => {
    const entriesByClass = new Map<CodingLiveFailureClass, number>()
    for (const entry of CODING_LIVE_FAILURE_REPLAY_CORPUS) {
      entriesByClass.set(entry.failureClass, (entriesByClass.get(entry.failureClass) ?? 0) + 1)
      expect(entry.nextFollowUp.trim()).not.toBe('')
      expect(entry.deterministicAnchor.trim()).not.toBe('')
    }

    expect([...entriesByClass.keys()].sort()).toEqual([...EXPECTED_REPLAY_CLASSES].sort())
    for (const failureClass of EXPECTED_REPLAY_CLASSES)
      expect(entriesByClass.get(failureClass)).toBe(1)
    expect(entriesByClass.has('unknown')).toBe(false)
  })

  it('classifies every corpus sample into its recorded failure class and disposition', () => {
    for (const entry of CODING_LIVE_FAILURE_REPLAY_CORPUS) {
      expect(classifyCodingLiveFailureText(entry.sample)).toMatchObject({
        failureClass: entry.failureClass,
        disposition: entry.disposition,
      })
    }
  })

  it('maps every known failure class back to its replay case', () => {
    for (const entry of CODING_LIVE_FAILURE_REPLAY_CORPUS) {
      expect(findCodingLiveFailureReplayCase(entry.failureClass)).toEqual(entry)
    }

    expect(findCodingLiveFailureReplayCase('unknown')).toBeUndefined()
  })

  it('maps report-only unavailable tool errors to tool adherence before generic text-only final', () => {
    const result = classifyCodingLiveFailureText(
      'TEXT_ONLY_FINAL: report-only correction requested an unavailable tool. lastError=Model tried to call unavailable tool "coding_read_file", Available tools: coding_report_status.',
    )

    expect(result.failureClass).toBe('report_only_tool_adherence')
    expect(result.summary).toContain('outside the current correction surface')
  })

  it('maps archive denial with budget exhaustion to archive finalization, not generic budget failure', () => {
    const result = classifyCodingLiveFailureText(
      'BUDGET_EXHAUSTED after coding_read_archived_context failed: ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search.',
    )

    expect(result.failureClass).toBe('archive_recall_finalization')
    expect(result.summary).toContain('analysis/report finalization')
  })

  it('keeps archive and text-only classifier markers case-insensitive', () => {
    expect(classifyCodingLiveFailureText(
      'archive_recall_finalization_failed: correction ended without coding_report_status',
    ).failureClass).toBe('archive_recall_finalization')

    expect(classifyCodingLiveFailureText(
      'text_only_final: report-only correction ended without accepted report',
    ).failureClass).toBe('report_only_text_final')
  })

  it('keeps provider capacity and latency outside runner-runtime failure classes', () => {
    expect(classifyCodingLiveFailureText(
      'Remote sent 429 response: {"error":{"code":"model_price_error","message":"upstream load saturated"}}',
    )).toMatchObject({
      failureClass: 'provider_capacity_or_latency',
      disposition: 'provider_observation_only',
    })

    expect(classifyCodingLiveFailureText('STEP_TIMEOUT while waiting for first model turn')).toMatchObject({
      failureClass: 'provider_capacity_or_latency',
      disposition: 'provider_observation_only',
    })

    expect(classifyCodingLiveFailureText('upstream load saturated while running fake-completion')).toMatchObject({
      failureClass: 'provider_capacity_or_latency',
      disposition: 'provider_observation_only',
    })
  })

  it('maps wrong-cwd terminal noise to deterministic replay first', () => {
    const result = classifyCodingLiveFailureText(
      'terminal_exec cat index.ts failed with cat: index.ts: No such file or directory; terminalState.effectiveCwd=/Users/liuziheng/airi',
    )

    expect(result.failureClass).toBe('cwd_terminal_detour')
    expect(result.disposition).toBe('deterministic_replay_first')
  })

  it('maps outside-workspace validation detours to deterministic replay first', () => {
    const result = classifyCodingLiveFailureText(
      'BUDGET_EXHAUSTED: coding runner reached maxSteps=15 without an accepted terminal report. lastTool=coding_search_text lastFailure=MCP error -32602: Search targetPath /Users/liuziheng/airi-coding-line is outside workspace /var/folders/xsai-governor-eval-kymz7M',
    )

    expect(result.failureClass).toBe('outside_workspace_validation_detour')
    expect(result.disposition).toBe('deterministic_replay_first')
    expect(result.summary).toContain('workspace guard')
  })

  it('returns unknown for unmapped failures and asks for replay before runtime changes', () => {
    const result = classifyCodingLiveFailureText('model stopped for an unexplained reason')

    expect(result.failureClass).toBe('unknown')
    expect(result.disposition).toBe('deterministic_replay_first')
    expect(result.summary).toContain('deterministic replay')
  })
})
