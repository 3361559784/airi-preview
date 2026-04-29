import type { PlanSpec, PlanState } from './contract'
import type { PlanEvidenceObservation } from './reconciliation'

import { describe, expect, it } from 'vitest'

import { reconcilePlanEvidence } from './reconciliation'
import { derivePlanStateTransitionProposal } from './state-transition'

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
        intent: 'Approve follow-up.',
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
    evidenceRefs: [],
    blockers: [],
    ...overrides,
  }
}

function observation(stepId: string, status: 'satisfied' | 'failed' = 'satisfied'): PlanEvidenceObservation {
  return {
    stepId,
    source: 'tool_result',
    status,
    summary: `${stepId} ${status}`,
    toolName: stepId === 'validate' ? 'terminal_exec' : 'coding_read_file',
  }
}

function proposal(params: {
  plan?: PlanSpec
  state: PlanState
  observations: PlanEvidenceObservation[]
}) {
  const spec = params.plan ?? plan()
  const reconciliation = reconcilePlanEvidence({
    plan: spec,
    state: params.state,
    observations: params.observations,
  })
  return derivePlanStateTransitionProposal({
    plan: spec,
    state: params.state,
    reconciliation,
  })
}

describe('plan state transition proposal contract', () => {
  it('proposes advancing the current step when in-progress evidence is satisfied', () => {
    const result = proposal({
      state: state(),
      observations: [observation('inspect')],
    })

    expect(result).toEqual({
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
    })
  })

  it('proposes marking a step failed when current-run evidence failed', () => {
    const result = proposal({
      state: state({ currentStepId: 'validate', completedSteps: ['inspect'] }),
      observations: [
        observation('inspect'),
        observation('validate', 'failed'),
      ],
    })

    expect(result).toMatchObject({
      proposal: 'mark_failed',
      stepId: 'validate',
      mayMutatePlanState: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.proposedOperations).toEqual([
      expect.objectContaining({ kind: 'append_failed_step', stepId: 'validate' }),
      expect.objectContaining({ kind: 'clear_current_step', stepId: 'validate' }),
    ])
  })

  it('proposes require_approval without fabricating human approval', () => {
    const result = proposal({
      state: state({ currentStepId: 'approve', completedSteps: ['inspect', 'validate'] }),
      observations: [
        observation('inspect'),
        observation('validate'),
      ],
    })

    expect(result).toMatchObject({
      proposal: 'require_approval',
      stepId: 'approve',
      proposedOperations: [
        {
          kind: 'append_blocker',
          stepId: 'approve',
          summary: 'Awaiting approval: approval recorded',
        },
      ],
      mayMutatePlanState: false,
    })
  })

  it('proposes ready_for_final_verification only as a proposal, not completion authority', () => {
    const result = proposal({
      state: state({
        currentStepId: undefined,
        completedSteps: ['inspect', 'validate'],
        skippedSteps: ['approve'],
      }),
      observations: [
        observation('inspect'),
        observation('validate'),
      ],
    })

    expect(result).toMatchObject({
      proposal: 'ready_for_final_verification',
      reason: 'All non-skipped plan steps have matched current-run evidence.',
      proposedOperations: [],
      mayMutatePlanState: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })

  it('proposes replan for structurally inconsistent state or blockers', () => {
    const blockerResult = proposal({
      state: state({ blockers: ['Need new route.'] }),
      observations: [observation('inspect')],
    })
    const inconsistentResult = proposal({
      state: state({ completedSteps: ['missing-step'] }),
      observations: [],
    })

    expect(blockerResult).toMatchObject({
      proposal: 'replan',
      reason: 'Plan state has blockers that require replanning.',
    })
    expect(inconsistentResult).toMatchObject({
      proposal: 'replan',
      reason: 'Plan state references unknown step: missing-step',
      stepId: 'missing-step',
    })
  })

  it('proposes noop when evidence is incomplete and no deterministic transition is available', () => {
    const result = proposal({
      state: state(),
      observations: [],
    })

    expect(result).toEqual({
      scope: 'current_run_plan_state_transition_proposal',
      proposal: 'noop',
      reason: 'Plan evidence is not complete yet.',
      stepId: 'inspect',
      proposedOperations: [],
      mayMutatePlanState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })

  it('does not mutate plan state or reconciliation inputs', () => {
    const spec = plan()
    const currentState = state()
    const observations = [observation('inspect')]
    const reconciliation = reconcilePlanEvidence({ plan: spec, state: currentState, observations })
    const before = JSON.stringify({ spec, currentState, reconciliation })

    derivePlanStateTransitionProposal({
      plan: spec,
      state: currentState,
      reconciliation,
    })

    expect(JSON.stringify({ spec, currentState, reconciliation })).toBe(before)
  })
})
