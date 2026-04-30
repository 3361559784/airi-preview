import type { PlanSpec, PlanState } from './contract'
import type { PlanHostOrchestrationDecisionInput } from './host-entrypoint'
import type { PlanStateTransitionProposal } from './state-transition'

import { describe, expect, it } from 'vitest'

import { reviewPlanStateTransitionProposal } from './host-entrypoint'
import { applyAcceptedPlanStateTransition } from './state-apply'

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
      {
        id: 'approve',
        lane: 'human',
        intent: 'Approve handoff.',
        allowedTools: [],
        expectedEvidence: [{ source: 'human_approval', description: 'approval recorded' }],
        riskLevel: 'high',
        approvalRequired: true,
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
    evidenceRefs: [
      {
        stepId: 'inspect',
        source: 'tool_result',
        summary: 'Read files.',
      },
    ],
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

function acceptedEntry(params: {
  currentState?: PlanState
  proposal?: PlanStateTransitionProposal
  decision?: Partial<PlanHostOrchestrationDecisionInput>
} = {}) {
  return reviewPlanStateTransitionProposal({
    plan: plan(),
    state: params.currentState ?? state(),
    proposal: params.proposal ?? transition(),
    hostDecision: {
      decision: 'accept_transition',
      actor: 'host-orchestrator',
      rationale: 'Apply evidence-backed state transition.',
      ...params.decision,
    },
  })
}

describe('accepted plan state transition apply contract', () => {
  it('applies an accepted advance transition to a returned plan state copy', () => {
    const currentState = state()
    const before = JSON.stringify(currentState)
    const result = applyAcceptedPlanStateTransition({
      state: currentState,
      hostEntry: acceptedEntry({ currentState }),
    })

    expect(result).toEqual({
      scope: 'current_run_plan_state_apply_result',
      status: 'applied',
      nextState: {
        currentStepId: 'validate',
        completedSteps: ['inspect'],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: currentState.evidenceRefs,
        blockers: [],
      },
      appliedOperations: transition().proposedOperations,
      problems: [],
      appliesTo: 'returned_plan_state_copy',
      mutatesInputPlanState: false,
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(JSON.stringify(currentState)).toBe(before)
    expect(result.nextState).not.toBe(currentState)
    expect(result.nextState.evidenceRefs).not.toBe(currentState.evidenceRefs)
  })

  it('applies an accepted failed-step transition without satisfying completion proof', () => {
    const currentState = state({ currentStepId: 'validate', completedSteps: ['inspect'] })
    const failedTransition = transition({
      proposal: 'mark_failed',
      stepId: 'validate',
      nextStepId: undefined,
      proposedOperations: [
        {
          kind: 'append_failed_step',
          stepId: 'validate',
          summary: 'Mark plan step validate failed.',
        },
        {
          kind: 'clear_current_step',
          stepId: 'validate',
          summary: 'Clear failed current step.',
        },
      ],
    })
    const result = applyAcceptedPlanStateTransition({
      state: currentState,
      hostEntry: acceptedEntry({ currentState, proposal: failedTransition }),
    })

    expect(result.status).toBe('applied')
    expect(result.nextState.currentStepId).toBeUndefined()
    expect(result.nextState.completedSteps).toEqual(['inspect'])
    expect(result.nextState.failedSteps).toEqual(['validate'])
    expect(result.maySatisfyVerificationGate).toBe(false)
    expect(result.maySatisfyMutationProof).toBe(false)
  })

  it('applies an accepted approval blocker as current-run state only', () => {
    const approvalTransition = transition({
      proposal: 'require_approval',
      stepId: 'approve',
      nextStepId: undefined,
      proposedOperations: [
        {
          kind: 'append_blocker',
          stepId: 'approve',
          summary: 'Awaiting approval: approval recorded',
        },
      ],
    })
    const currentState = state({ currentStepId: 'approve', completedSteps: ['inspect', 'validate'] })
    const result = applyAcceptedPlanStateTransition({
      state: currentState,
      hostEntry: acceptedEntry({ currentState, proposal: approvalTransition }),
    })

    expect(result).toMatchObject({
      status: 'applied',
      nextState: {
        currentStepId: 'approve',
        completedSteps: ['inspect', 'validate'],
        failedSteps: [],
        blockers: ['Awaiting approval: approval recorded'],
      },
      mutatesPersistentState: false,
      mayExecute: false,
    })
  })

  it('does not apply rejected or blocked host entrypoint records', () => {
    const rejected = reviewPlanStateTransitionProposal({
      plan: plan(),
      state: state(),
      proposal: transition(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Reject this transition.',
      },
    })
    const blocked = acceptedEntry({
      decision: {
        actor: '',
        rationale: '',
      },
    })

    expect(applyAcceptedPlanStateTransition({ state: state(), hostEntry: rejected })).toMatchObject({
      status: 'skipped',
      appliedOperations: [],
      problems: [expect.objectContaining({ reason: 'host_entry_not_accepted' })],
    })
    expect(applyAcceptedPlanStateTransition({ state: state(), hostEntry: blocked })).toMatchObject({
      status: 'blocked',
      appliedOperations: [],
      problems: [expect.objectContaining({ reason: 'host_entry_not_accepted' })],
    })
  })

  it('skips accepted records without operations', () => {
    const currentState = state()
    const entry = acceptedEntry({
      currentState,
      proposal: transition({
        proposedOperations: [
          {
            kind: 'append_blocker',
            stepId: 'inspect',
            summary: 'Temporary operation.',
          },
        ],
      }),
    })
    entry.acceptedOperations = []

    const result = applyAcceptedPlanStateTransition({
      state: currentState,
      hostEntry: entry,
    })

    expect(result).toMatchObject({
      status: 'skipped',
      nextState: currentState,
      appliedOperations: [],
      problems: [expect.objectContaining({ reason: 'empty_accepted_operations' })],
    })
    expect(result.nextState).not.toBe(currentState)
  })

  it('is idempotent for duplicate terminal step and blocker operations', () => {
    const currentState = state({
      currentStepId: 'validate',
      completedSteps: ['inspect'],
      blockers: ['Awaiting approval: approval recorded'],
    })
    const duplicateTransition = transition({
      proposal: 'require_approval',
      stepId: 'approve',
      nextStepId: undefined,
      proposedOperations: [
        {
          kind: 'append_completed_step',
          stepId: 'inspect',
          summary: 'Already completed.',
        },
        {
          kind: 'append_blocker',
          stepId: 'approve',
          summary: 'Awaiting approval: approval recorded',
        },
      ],
    })

    const result = applyAcceptedPlanStateTransition({
      state: currentState,
      hostEntry: acceptedEntry({ currentState, proposal: duplicateTransition }),
    })

    expect(result.status).toBe('applied')
    expect(result.nextState.completedSteps).toEqual(['inspect'])
    expect(result.nextState.blockers).toEqual(['Awaiting approval: approval recorded'])
  })
})
