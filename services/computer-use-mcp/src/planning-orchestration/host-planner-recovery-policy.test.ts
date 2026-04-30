import type {
  PlanSessionRecoveryReplayClass,
  PlanSessionRecoveryReplayRow,
} from './session-replay'

import { describe, expect, it } from 'vitest'

import {
  derivePlanHostPlannerRecoveryPolicy,
  PLAN_HOST_PLANNER_RECOVERY_POLICY_BOUNDARY_LINES,
} from './host-planner-recovery-policy'

function replay(overrides: Partial<PlanSessionRecoveryReplayRow> = {}): PlanSessionRecoveryReplayRow {
  return {
    scope: 'current_run_plan_session_recovery_replay',
    source: 'host_plan_runtime_session',
    sessionId: 'session-policy-1',
    generation: 2,
    activeGoalPreview: 'Inspect and validate source.',
    activeCurrentStepId: 'validate',
    eventCount: 1,
    transitionCount: 1,
    replacementCount: 0,
    failureClass: 'unknown',
    classificationSummary: 'Unmapped plan session recovery signal.',
    deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts unknown recovery fallback',
    nextFollowUp: 'test(computer-use-mcp): add deterministic replay for unmapped plan session recovery',
    eventHistory: [],
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
    ...overrides,
  }
}

function transitionReplay(
  failureClass: Extract<PlanSessionRecoveryReplayClass, 'transition_blocked' | 'transition_rejected' | 'replan_requested'>,
  status: string,
  problemReasons: string[] = [],
): PlanSessionRecoveryReplayRow {
  return replay({
    failureClass,
    latestEvent: {
      sequence: 1,
      generation: 2,
      kind: 'transition',
      status,
      problemReasons,
      proposalKind: failureClass === 'replan_requested' ? 'replan' : 'advance_step',
      stateUpdated: false,
    },
    eventHistory: [{
      sequence: 1,
      generation: 2,
      kind: 'transition',
      status,
      problemReasons,
      proposalKind: failureClass === 'replan_requested' ? 'replan' : 'advance_step',
      stateUpdated: false,
    }],
  })
}

describe('host planner recovery policy contract', () => {
  it('is deterministic and does not mutate replay input', () => {
    const row = transitionReplay('replan_requested', 'replan_requested')
    const before = structuredClone(row)

    const first = derivePlanHostPlannerRecoveryPolicy({ replay: row })
    const second = derivePlanHostPlannerRecoveryPolicy({ replay: row })

    expect(second).toEqual(first)
    expect(row).toEqual(before)
  })

  it('allows host-requested replan to request a host-supplied replacement plan', () => {
    const policy = derivePlanHostPlannerRecoveryPolicy({
      replay: transitionReplay('replan_requested', 'replan_requested'),
    })

    expect(policy).toMatchObject({
      scope: 'current_run_plan_host_planner_recovery_policy',
      source: 'plan_session_recovery_replay',
      sessionId: 'session-policy-1',
      generation: 2,
      replayFailureClass: 'replan_requested',
      decision: 'request_replacement_plan',
      mayRequestReplacementPlan: true,
      requiresHostApproval: false,
      failsRecoveryAttempt: false,
      deterministicReplayRequired: false,
      replacementPlanRequest: {
        scope: 'current_run_plan_replacement_plan_request',
        sessionId: 'session-policy-1',
        generation: 2,
        activeGoalPreview: 'Inspect and validate source.',
        activeCurrentStepId: 'validate',
        trigger: 'replan_requested',
        acceptsHostSuppliedPlanSpecOnly: true,
        mayCreatePlanSpec: false,
        mayMutatePlanState: false,
        mutatesPersistentState: false,
        mayExecute: false,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
      mayCreatePlanSpec: false,
      mayMutatePlanState: false,
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(policy.replacementPlanRequest?.boundaries).toEqual(PLAN_HOST_PLANNER_RECOVERY_POLICY_BOUNDARY_LINES)
    expect(policy.replacementPlanRequest).not.toHaveProperty('replacementPlan')
    expect(policy.replacementPlanRequest).not.toHaveProperty('plan')
  })

  it('allows workflow blocked/skipped replay rows to request replacement route planning', () => {
    const blocked = derivePlanHostPlannerRecoveryPolicy({
      replay: replay({
        failureClass: 'workflow_execution_blocked',
        workflowRun: {
          status: 'skipped',
          executionStatus: 'blocked',
          executed: false,
          reconciliationIncluded: false,
          problemReasons: ['reconciliation_not_included'],
        },
      }),
    })
    const skipped = derivePlanHostPlannerRecoveryPolicy({
      replay: replay({
        failureClass: 'workflow_reconciliation_skipped',
        workflowRun: {
          status: 'skipped',
          executionStatus: 'completed',
          executed: true,
          reconciliationIncluded: false,
          problemReasons: ['missing_transition_proposal'],
        },
      }),
    })

    expect(blocked).toMatchObject({
      decision: 'request_replacement_plan',
      replacementPlanRequest: { trigger: 'workflow_execution_blocked' },
    })
    expect(skipped).toMatchObject({
      decision: 'request_replacement_plan',
      replacementPlanRequest: { trigger: 'workflow_reconciliation_skipped' },
    })
  })

  it('requires host approval for rejected transitions and host-entry blocked transitions', () => {
    const rejected = derivePlanHostPlannerRecoveryPolicy({
      replay: transitionReplay('transition_rejected', 'rejected', ['apply_problem']),
    })
    const blockedAtHostEntry = derivePlanHostPlannerRecoveryPolicy({
      replay: transitionReplay('transition_blocked', 'blocked', ['host_entry_problem', 'apply_problem']),
    })

    expect(rejected).toMatchObject({
      decision: 'require_host_approval',
      requiredHostAction: 'review_rejected_transition',
      mayRequestReplacementPlan: false,
      requiresHostApproval: true,
    })
    expect(rejected.replacementPlanRequest).toBeUndefined()
    expect(blockedAtHostEntry).toMatchObject({
      decision: 'require_host_approval',
      requiredHostAction: 'fix_blocked_transition',
      mayRequestReplacementPlan: false,
      requiresHostApproval: true,
    })
  })

  it('fails recovery attempts for apply-only blocked transitions and blocked replacements', () => {
    const applyBlocked = derivePlanHostPlannerRecoveryPolicy({
      replay: transitionReplay('transition_blocked', 'blocked', ['apply_problem']),
    })
    const replacementBlocked = derivePlanHostPlannerRecoveryPolicy({
      replay: replay({
        failureClass: 'replacement_blocked',
        latestEvent: {
          sequence: 1,
          generation: 2,
          kind: 'replacement',
          status: 'blocked',
          problemReasons: ['recovery_not_replan_required'],
          activeRuntimeReplaced: false,
        },
      }),
    })

    expect(applyBlocked).toMatchObject({
      decision: 'fail_recovery_attempt',
      requiredHostAction: 'inspect_recovery_failure',
      failsRecoveryAttempt: true,
      mayRequestReplacementPlan: false,
    })
    expect(replacementBlocked).toMatchObject({
      decision: 'fail_recovery_attempt',
      requiredHostAction: 'inspect_recovery_failure',
      failsRecoveryAttempt: true,
      mayRequestReplacementPlan: false,
    })
  })

  it('routes unknown replay rows back to deterministic replay before runtime recovery', () => {
    const policy = derivePlanHostPlannerRecoveryPolicy({
      replay: replay({
        failureClass: 'unknown',
        nextFollowUp: 'test(computer-use-mcp): add deterministic replay for unmapped plan session recovery',
      }),
    })

    expect(policy).toMatchObject({
      decision: 'deterministic_replay_required',
      requiredHostAction: 'add_deterministic_replay',
      deterministicReplayRequired: true,
      nextFollowUp: 'test(computer-use-mcp): add deterministic replay for unmapped plan session recovery',
      mayRequestReplacementPlan: false,
      requiresHostApproval: false,
      failsRecoveryAttempt: false,
    })
  })

  it('does not produce memory export, session mutation, execution, or proof authority shapes', () => {
    const policy = derivePlanHostPlannerRecoveryPolicy({
      replay: transitionReplay('replan_requested', 'replan_requested'),
    })

    expect(policy).not.toHaveProperty('workspaceKey')
    expect(policy).not.toHaveProperty('memoryId')
    expect(policy).not.toHaveProperty('humanVerified')
    expect(policy).not.toHaveProperty('replacementPlan')
    expect(policy).not.toHaveProperty('transition')
    expect(policy).toMatchObject({
      mayCreatePlanSpec: false,
      mayMutatePlanState: false,
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })
})
