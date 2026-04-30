import type { PlanSpec, PlanState } from './contract'
import type { PlanStateTransitionProposal } from './state-transition'

import { describe, expect, it } from 'vitest'

import { runHostPlanStateTransition } from './host-runtime'

function plan(): PlanSpec {
  return {
    goal: 'Inspect and validate.',
    steps: [
      {
        id: 'inspect',
        lane: 'coding',
        intent: 'Inspect files.',
        allowedTools: ['coding_read_file'],
        expectedEvidence: [{ source: 'tool_result', description: 'file read' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
      {
        id: 'validate',
        lane: 'terminal',
        intent: 'Run validation.',
        allowedTools: ['terminal_exec'],
        expectedEvidence: [{ source: 'tool_result', description: 'validation result' }],
        riskLevel: 'medium',
        approvalRequired: false,
      },
    ],
  }
}

function state(overrides: Partial<PlanState> = {}): PlanState {
  return {
    currentStepId: 'inspect',
    completedSteps: [],
    failedSteps: [],
    skippedSteps: [],
    evidenceRefs: [],
    blockers: [],
    ...overrides,
  }
}

function transition(overrides: Partial<PlanStateTransitionProposal> = {}): PlanStateTransitionProposal {
  return {
    scope: 'current_run_plan_state_transition_proposal',
    proposal: 'advance_step',
    reason: 'Current step inspect has satisfied expected evidence.',
    stepId: 'inspect',
    nextStepId: 'validate',
    proposedOperations: [
      {
        kind: 'append_completed_step',
        stepId: 'inspect',
        summary: 'Mark plan step inspect completed.',
      },
      {
        kind: 'set_current_step',
        stepId: 'validate',
        summary: 'Advance current step to validate.',
      },
    ],
    mayMutatePlanState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
    ...overrides,
  }
}

describe('host-owned plan runtime transition boundary', () => {
  it('reviews and applies an accepted transition to a returned state copy', () => {
    const currentState = state()
    const before = JSON.stringify(currentState)
    const result = runHostPlanStateTransition({
      plan: plan(),
      state: currentState,
      proposal: transition(),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Evidence satisfied current step.',
      },
    })

    expect(result).toMatchObject({
      scope: 'current_run_plan_host_runtime_transition',
      status: 'applied',
      proposalKind: 'advance_step',
      nextState: {
        currentStepId: 'validate',
        completedSteps: ['inspect'],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      },
      hostEntry: {
        status: 'accepted',
        decision: 'accept_transition',
        acceptedOperations: transition().proposedOperations,
        mayMutatePlanState: false,
      },
      applyResult: {
        status: 'applied',
        appliesTo: 'returned_plan_state_copy',
        mutatesInputPlanState: false,
        mutatesPersistentState: false,
      },
      problems: [],
      mutatesInputPlanState: false,
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(JSON.stringify(currentState)).toBe(before)
    expect(result.nextState).not.toBe(currentState)
  })

  it('returns rejected without applying state when host rejects the proposal', () => {
    const currentState = state()
    const result = runHostPlanStateTransition({
      plan: plan(),
      state: currentState,
      proposal: transition(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Need a different next step.',
      },
    })

    expect(result).toMatchObject({
      status: 'rejected',
      nextState: currentState,
      hostEntry: {
        status: 'rejected',
        acceptedOperations: [],
      },
      applyResult: {
        status: 'skipped',
        appliedOperations: [],
      },
      problems: [expect.objectContaining({ reason: 'apply_problem' })],
    })
    expect(result.nextState).not.toBe(currentState)
  })

  it('returns replan_requested without inventing a plan-state mutation', () => {
    const result = runHostPlanStateTransition({
      plan: plan(),
      state: state(),
      proposal: transition(),
      hostDecision: {
        decision: 'request_replan',
        actor: 'host-orchestrator',
        rationale: 'Existing route is stale.',
      },
    })

    expect(result).toMatchObject({
      status: 'replan_requested',
      hostEntry: {
        status: 'rejected',
        decision: 'request_replan',
        acceptedOperations: [],
      },
      applyResult: {
        status: 'skipped',
        appliedOperations: [],
      },
      mayExecute: false,
    })
  })

  it('blocks invalid accepted transitions before applying operations', () => {
    const result = runHostPlanStateTransition({
      plan: plan(),
      state: state({ failedSteps: ['inspect'] }),
      proposal: transition(),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Try to complete a failed step.',
      },
    })

    expect(result.status).toBe('blocked')
    expect(result.nextState).toMatchObject({
      currentStepId: 'inspect',
      completedSteps: [],
      failedSteps: ['inspect'],
    })
    expect(result.hostEntry.problems).toEqual([
      expect.objectContaining({ reason: 'transition_step_conflict', stepId: 'inspect' }),
    ])
    expect(result.applyResult).toMatchObject({
      status: 'blocked',
      appliedOperations: [],
    })
    expect(result.problems).toEqual([
      expect.objectContaining({ reason: 'host_entry_problem' }),
      expect.objectContaining({ reason: 'apply_problem' }),
    ])
  })

  it('keeps ready-for-final-verification as gate-owned and non-applicable', () => {
    const result = runHostPlanStateTransition({
      plan: plan(),
      state: state({ currentStepId: undefined, completedSteps: ['inspect', 'validate'] }),
      proposal: transition({
        proposal: 'ready_for_final_verification',
        stepId: undefined,
        nextStepId: undefined,
        proposedOperations: [],
      }),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Ready for final gate.',
      },
    })

    expect(result).toMatchObject({
      status: 'blocked',
      hostEntry: {
        status: 'blocked',
        problems: [expect.objectContaining({ reason: 'invalid_ready_for_final_verification_acceptance' })],
      },
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.nextState).toMatchObject({
      completedSteps: ['inspect', 'validate'],
      failedSteps: [],
    })
  })
})
