import type { PlanSpec, PlanState } from './contract'
import type { PlanStateTransitionProposal } from './state-transition'

import { describe, expect, it } from 'vitest'

import { reviewPlanStateTransitionProposal } from './host-entrypoint'

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

describe('host-owned plan orchestration entrypoint contract', () => {
  it('accepts a valid transition proposal as an audited record without mutating plan state', () => {
    const currentState = state()
    const before = JSON.stringify(currentState)
    const result = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: currentState,
      proposal: transition(),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Evidence satisfied current step.',
      },
    })

    expect(result).toEqual({
      scope: 'current_run_plan_host_orchestration_entrypoint',
      status: 'accepted',
      decision: 'accept_transition',
      actor: 'host-orchestrator',
      rationale: 'Evidence satisfied current step.',
      proposalKind: 'advance_step',
      problems: [],
      acceptedOperations: transition().proposedOperations,
      mayMutatePlanState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(JSON.stringify(currentState)).toBe(before)
  })

  it('rejects a valid proposal without accepting operations', () => {
    const result = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: state(),
      proposal: transition(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Host wants a different route.',
      },
    })

    expect(result).toMatchObject({
      status: 'rejected',
      decision: 'reject_transition',
      acceptedOperations: [],
      mayMutatePlanState: false,
    })
  })

  it('requires non-empty host actor and rationale', () => {
    const result = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: state(),
      proposal: transition(),
      hostDecision: {
        decision: 'accept_transition',
        actor: '  ',
        rationale: '',
      },
    })

    expect(result.status).toBe('blocked')
    expect(result.problems).toEqual([
      expect.objectContaining({ reason: 'empty_actor' }),
      expect.objectContaining({ reason: 'empty_rationale' }),
    ])
    expect(result.acceptedOperations).toEqual([])
  })

  it('blocks transition operations that reference missing or conflicting steps', () => {
    const result = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: state({ failedSteps: ['inspect'] }),
      proposal: transition({
        proposedOperations: [
          {
            kind: 'append_completed_step',
            stepId: 'inspect',
            summary: 'Cannot complete failed step.',
          },
          {
            kind: 'set_current_step',
            stepId: 'missing',
            summary: 'Missing step.',
          },
        ],
      }),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Try to apply invalid transition.',
      },
    })

    expect(result.status).toBe('blocked')
    expect(result.problems).toEqual([
      expect.objectContaining({ reason: 'transition_step_conflict', stepId: 'inspect' }),
      expect.objectContaining({ reason: 'plan_step_missing', stepId: 'missing' }),
    ])
    expect(result.acceptedOperations).toEqual([])
  })

  it('does not allow accepting noop or ready-for-final-verification as state mutations', () => {
    const noopResult = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: state(),
      proposal: transition({ proposal: 'noop', proposedOperations: [] }),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Nothing to apply.',
      },
    })
    const readyResult = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: state({ currentStepId: undefined, completedSteps: ['inspect', 'validate'] }),
      proposal: transition({
        proposal: 'ready_for_final_verification',
        proposedOperations: [],
      }),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Ready for final gate.',
      },
    })

    expect(noopResult).toMatchObject({
      status: 'blocked',
      problems: [expect.objectContaining({ reason: 'invalid_noop_acceptance' })],
    })
    expect(readyResult).toMatchObject({
      status: 'blocked',
      problems: [expect.objectContaining({ reason: 'invalid_ready_for_final_verification_acceptance' })],
    })
  })

  it('allows request_replan as a rejected decision record', () => {
    const result = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: state(),
      proposal: transition(),
      hostDecision: {
        decision: 'request_replan',
        actor: 'host-orchestrator',
        rationale: 'Need a new plan.',
      },
    })

    expect(result).toMatchObject({
      status: 'rejected',
      decision: 'request_replan',
      acceptedOperations: [],
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })

  it('allows rejecting an invalid proposal because no operations are applied', () => {
    const result = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: state({ failedSteps: ['inspect'] }),
      proposal: transition({
        proposedOperations: [
          {
            kind: 'append_completed_step',
            stepId: 'inspect',
            summary: 'Would be invalid if accepted.',
          },
        ],
      }),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Reject invalid proposal.',
      },
    })

    expect(result).toMatchObject({
      status: 'rejected',
      problems: [],
      acceptedOperations: [],
      mayMutatePlanState: false,
    })
  })
})
