import type { CodingRunState } from '../state'

import { describe, expect, it } from 'vitest'

import { evaluateCodingVerificationGate } from './verification-gate'

function createCodingState(overrides?: Partial<CodingRunState>): CodingRunState {
  return {
    workspacePath: '/tmp/project',
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
      resolvedAt: new Date().toISOString(),
    },
    lastChangeReview: {
      status: 'ready_for_next_file',
      filesReviewed: ['src/example.ts'],
      diffSummary: '1 file changed',
      validationSummary: 'ok',
      validationCommand: 'pnpm test',
      baselineComparison: 'unknown',
      detectedRisks: [],
      unresolvedIssues: [],
      recommendedNextAction: 'report completion',
    },
    ...overrides,
  }
}

function createReportOnlyCodingState(overrides?: Partial<CodingRunState>): CodingRunState {
  return createCodingState({
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
    lastCodingReport: {
      status: 'completed',
      summary: 'Workspace analysis completed with source-backed report evidence.',
      filesTouched: [],
      commandsRun: [],
      checks: [],
      nextStep: 'No code changes required.',
    },
    ...overrides,
  })
}

describe('coding verification gate', () => {
  it('passes when review is ready, validation evidence exists, and no pending plan/session work', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState(),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm test',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.workflowOutcome).toBe('completed')
    expect(decision.finalReportStatus).toBe('completed')
  })

  it('returns needs_follow_up when review status is needs_follow_up', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastChangeReview: {
          status: 'needs_follow_up',
          filesReviewed: ['src/example.ts'],
          diffSummary: 'needs follow-up',
          validationSummary: 'follow-up',
          validationCommand: 'pnpm test',
          baselineComparison: 'unknown',
          detectedRisks: ['unresolved_issues_remain'],
          unresolvedIssues: ['need follow-up'],
          recommendedNextAction: 'fix remaining issues',
        },
      }),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm test',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('unresolved_issues_remain')
    expect(decision.workflowOutcome).toBe('failed')
  })

  it('fails with amend when diagnosis requires amend', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastChangeDiagnosis: {
          rootCauseType: 'incomplete_change',
          confidence: 0.8,
          evidence: ['incomplete'],
          affectedFiles: ['src/example.ts'],
          nextAction: 'amend',
          recommendedAction: 'amend plan',
          shouldAmendPlan: true,
          shouldAbortPlan: false,
        },
      }),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm test',
        terminalExitCode: 1,
      },
    })

    expect(decision.decision).toBe('amend')
    expect(decision.reasonCode).toBe('amend_required')
    expect(decision.workflowOutcome).toBe('failed')
  })

  it('fails with abort when diagnosis requires abort', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastChangeDiagnosis: {
          rootCauseType: 'validation_environment_issue',
          confidence: 0.8,
          evidence: ['timeout'],
          affectedFiles: ['src/example.ts'],
          nextAction: 'abort',
          recommendedAction: 'abort',
          shouldAmendPlan: false,
          shouldAbortPlan: true,
        },
      }),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm test',
        terminalExitCode: 124,
      },
    })

    expect(decision.decision).toBe('abort')
    expect(decision.reasonCode).toBe('abort_required')
    expect(decision.workflowOutcome).toBe('failed')
  })

  it('does not allow completion when review is missing and validation evidence is missing', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastChangeReview: undefined,
        lastScopedValidationCommand: undefined,
      }),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: false,
      },
    })

    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('review_missing')
    expect(decision.workflowOutcome).toBe('failed')
  })

  it('passes report-only completion with structured analysis evidence and no terminal validation', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState(),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: false,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.workflowOutcome).toBe('completed')
    expect(decision.verificationEvidenceSummary.isReportOnlyCompletion).toBe(true)
    expect(decision.verificationEvidenceSummary.reportOnlyEvidence).toContain('compressed_context')
    expect(decision.verificationEvidenceSummary.matchedTriggers).not.toContain('no_validation_run')
  })

  it('passes report-only completion with structured analysis evidence after directory probe commands', () => {
    // ROOT CAUSE:
    //
    // DeepSeek analysis/report live eval read files, compressed context, and
    // reported completion without touching files, but a later `ls` probe was
    // treated as `verification_bad_faith`.
    //
    // For analysis/report-only tasks, directory probes are source discovery
    // context, not mutation validation. The gate should rely on report-only
    // runtime evidence instead of requiring `node check.js`-style validation.
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState(),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'ls -la /tmp/project',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.workflowOutcome).toBe('completed')
    expect(decision.reasonCode).toBe('gate_pass')
    expect(decision.verificationEvidenceSummary.isReportOnlyCompletion).toBe(true)
    expect(decision.verificationEvidenceSummary.reportOnlyEvidence).toContain('compressed_context')
    expect(decision.verificationEvidenceSummary.matchedTriggers).not.toContain('verification_bad_faith')
  })

  it('does not let report-only evidence complete while plan work is still pending', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState({
        currentPlan: {
          maxPlannedFiles: 1,
          diffBaselineFiles: [],
          steps: [{ filePath: 'src/example.ts', intent: 'behavior_fix', source: 'explicit', status: 'pending' }],
          reason: 'pending edit plan',
        },
      }),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: false,
      },
    })

    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('pending_planner_work')
    expect(decision.workflowOutcome).toBe('failed')
  })

  it('marks mismatch as recheck-eligible only once', () => {
    const state = createCodingState({
      lastChangeReview: {
        status: 'ready_for_next_file',
        filesReviewed: ['src/example.ts'],
        diffSummary: 'ok',
        validationSummary: 'ok',
        validationCommand: 'pnpm some-other-script',
        baselineComparison: 'unknown',
        detectedRisks: [],
        unresolvedIssues: [],
        recommendedNextAction: 'done',
      },
      lastScopedValidationCommand: {
        command: 'pnpm test',
        scope: 'workspace',
        reason: 'targeted validation',
        resolvedAt: new Date().toISOString(),
      },
    })

    const firstDecision = evaluateCodingVerificationGate({
      codingState: state,
      workflowKind: 'coding_loop',
      recheckAttempted: false,
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm some-other-script',
        terminalExitCode: 0,
      },
    })
    expect(firstDecision.decision).toBe('recheck_once')
    expect(firstDecision.reasonCode).toBe('validation_command_mismatch')

    const secondDecision = evaluateCodingVerificationGate({
      codingState: state,
      workflowKind: 'coding_loop',
      recheckAttempted: true,
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm some-other-script',
        terminalExitCode: 0,
      },
    })
    expect(secondDecision.decision).toBe('needs_follow_up')
    expect(secondDecision.reasonCode).toBe('validation_command_mismatch')
  })

  it('treats bad faith commands as immediate hard failure, skipping recheck', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastScopedValidationCommand: {
          command: 'pnpm test',
          scope: 'workspace',
          reason: 'targeted validation',
          resolvedAt: new Date().toISOString(),
        },
      }),
      workflowKind: 'coding_loop',
      recheckAttempted: false,
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'echo "all good"',
        terminalExitCode: 0,
      },
    })
    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('accepts repo-specific validation commands when terminal and scoped evidence align', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastScopedValidationCommand: {
          command: './scripts/check-one-file.sh src/example.ts',
          scope: 'file',
          reason: 'project-specific verifier',
          resolvedAt: new Date().toISOString(),
        },
        lastChangeReview: {
          status: 'ready_for_next_file',
          filesReviewed: ['src/example.ts'],
          diffSummary: 'ok',
          validationSummary: 'custom verifier passed',
          validationCommand: './scripts/check-one-file.sh src/example.ts',
          baselineComparison: 'unknown',
          detectedRisks: [],
          unresolvedIssues: [],
          recommendedNextAction: 'done',
        },
      }),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: './scripts/check-one-file.sh src/example.ts',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.reasonCode).toBe('gate_pass')
  })

  it('accepts file-targeted custom validation command even when scoped command is missing', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastScopedValidationCommand: undefined,
        lastChangeReview: {
          status: 'ready_for_next_file',
          filesReviewed: ['src/example.ts'],
          diffSummary: 'ok',
          validationSummary: 'custom verifier passed',
          validationCommand: './scripts/check-one-file.sh src/example.ts',
          baselineComparison: 'unknown',
          detectedRisks: [],
          unresolvedIssues: [],
          recommendedNextAction: 'done',
        },
      }),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: './scripts/check-one-file.sh src/example.ts',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.reasonCode).toBe('gate_pass')
  })

  it('accepts aligned project-level validation command even when scoped command is missing', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastScopedValidationCommand: undefined,
        lastChangeReview: {
          status: 'ready_for_next_file',
          filesReviewed: ['index.ts'],
          diffSummary: 'ok',
          validationSummary: 'node check.js passed',
          validationCommand: 'node check.js',
          baselineComparison: 'unknown',
          detectedRisks: [],
          unresolvedIssues: [],
          recommendedNextAction: 'done',
        },
      }),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'node check.js',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.reasonCode).toBe('gate_pass')
  })

  it('accepts aligned project-level validation command even when a scoped suggestion exists', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastScopedValidationCommand: {
          command: 'pnpm exec eslint "index.ts"',
          scope: 'file',
          filePath: 'index.ts',
          reason: 'fallback scoped validation suggestion',
          resolvedAt: new Date().toISOString(),
        },
        lastChangeReview: {
          status: 'ready_for_next_file',
          filesReviewed: ['index.ts'],
          diffSummary: 'ok',
          validationSummary: 'node check.js passed',
          validationCommand: 'node check.js',
          baselineComparison: 'unknown',
          detectedRisks: [],
          unresolvedIssues: [],
          recommendedNextAction: 'done',
        },
      }),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'node check.js',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.reasonCode).toBe('gate_pass')
  })

  it('rejects divergent validation commands when scoped command is missing', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastScopedValidationCommand: undefined,
        lastChangeReview: {
          status: 'ready_for_next_file',
          filesReviewed: ['index.ts'],
          diffSummary: 'ok',
          validationSummary: 'different command passed',
          validationCommand: 'node check.js',
          baselineComparison: 'unknown',
          detectedRisks: [],
          unresolvedIssues: [],
          recommendedNextAction: 'done',
        },
      }),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm test',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('recheck_once')
    expect(decision.reasonCode).toBe('validation_command_mismatch')
  })

  it('treats patch_verification_mismatch as recheck-ineligible hard failure', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastChangeReview: {
          status: 'ready_for_next_file',
          filesReviewed: ['src/example.ts'],
          diffSummary: 'mismatch',
          validationSummary: 'ok',
          validationCommand: 'pnpm test',
          baselineComparison: 'unknown',
          detectedRisks: ['patch_verification_mismatch'],
          unresolvedIssues: [],
          recommendedNextAction: 'fix mismatch',
        },
      }),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm test',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('patch_verification_mismatch')
    expect(decision.workflowOutcome).toBe('failed')
  })

  it('treats node -e as bad faith', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState(),
      workflowKind: 'coding_loop',
      recheckAttempted: false,
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'node -e "console.log(\'ok\')"',
        terminalExitCode: 0,
      },
    })
    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('treats python -c as bad faith', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState(),
      workflowKind: 'coding_loop',
      recheckAttempted: false,
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'python -c "print(1)"',
        terminalExitCode: 0,
      },
    })
    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('treats `true` command as bad faith', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState(),
      workflowKind: 'coding_loop',
      recheckAttempted: false,
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'true',
        terminalExitCode: 0,
      },
    })
    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('treats printf as bad faith', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState(),
      workflowKind: 'coding_loop',
      recheckAttempted: false,
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'printf "PASS"',
        terminalExitCode: 0,
      },
    })
    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('passes report-only completion with pwd source discovery probe', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState(),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pwd',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.reasonCode).toBe('gate_pass')
    expect(decision.verificationEvidenceSummary.matchedTriggers).not.toContain('verification_bad_faith')
  })

  it('passes report-only completion with cat source discovery probe', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState(),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'cat src/example.ts',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('pass')
    expect(decision.reasonCode).toBe('gate_pass')
    expect(decision.verificationEvidenceSummary.matchedTriggers).not.toContain('verification_bad_faith')
  })

  it('rejects report-only completion when source discovery chains another command', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState(),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'ls -la && node -e "console.log(1)"',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('rejects report-only completion when cat redirects output', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState(),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'cat src/example.ts > copied.ts',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('rejects report-only completion with echo shortcut', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState(),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'echo "not verifiable"',
        terminalExitCode: 0,
      },
    })
    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('rejects report-only completion with inline node shortcut', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createReportOnlyCodingState(),
      workflowKind: 'coding_agentic_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'node -e "console.log(1)"',
        terminalExitCode: 0,
      },
    })

    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('rejects ls in edit-task', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState(),
      workflowKind: 'coding_loop',
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'ls -la',
        terminalExitCode: 0,
      },
    })
    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('verification_bad_faith')
  })

  it('rejects when terminal exit code is non-zero but review says ready', () => {
    const decision = evaluateCodingVerificationGate({
      codingState: createCodingState({
        lastChangeReview: {
          status: 'ready_for_next_file',
          filesReviewed: ['src/example.ts'],
          diffSummary: 'ok',
          validationSummary: 'ok',
          validationCommand: 'pnpm test',
          baselineComparison: 'unknown',
          detectedRisks: [],
          unresolvedIssues: [],
          recommendedNextAction: 'done',
        },
      }),
      workflowKind: 'coding_loop',
      recheckAttempted: false,
      terminalEvidence: {
        hasTerminalResult: true,
        terminalCommand: 'pnpm test',
        terminalExitCode: 1,
      },
    })
    expect(decision.decision).toBe('needs_follow_up')
    expect(decision.reasonCode).toBe('terminal_exit_nonzero')
  })
})
