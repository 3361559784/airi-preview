import type { PlanSpec, PlanState } from './contract'
import type { PlanStateTransitionProposal } from './state-transition'

import { describe, expect, it } from 'vitest'

import { createPlanHostRuntimeState } from './host-runtime-state'

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
    evidenceRefs: [
      {
        stepId: 'inspect',
        source: 'tool_result',
        summary: 'Read file.',
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

function acceptDecision() {
  return {
    decision: 'accept_transition' as const,
    actor: 'host-orchestrator',
    rationale: 'Evidence satisfied current step.',
  }
}

describe('host-owned plan runtime state holder', () => {
  it('persists accepted transition state inside the current-run runtime instance only', () => {
    const initialState = state()
    const runtime = createPlanHostRuntimeState({
      plan: plan(),
      initialState,
    })
    const before = JSON.stringify(initialState)
    const record = runtime.transition({
      proposal: transition(),
      hostDecision: acceptDecision(),
    })

    expect(record).toMatchObject({
      scope: 'current_run_plan_host_runtime_transition_record',
      sequence: 1,
      stateUpdated: true,
      previousState: initialState,
      nextState: {
        currentStepId: 'validate',
        completedSteps: ['inspect'],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: initialState.evidenceRefs,
        blockers: [],
      },
      transition: {
        status: 'applied',
        mayExecute: false,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(runtime.getState()).toMatchObject({
      currentStepId: 'validate',
      completedSteps: ['inspect'],
    })
    expect(JSON.stringify(initialState)).toBe(before)
  })

  it('does not update runtime state for rejected, replan, or blocked transitions', () => {
    const runtime = createPlanHostRuntimeState({
      plan: plan(),
      initialState: state(),
    })

    const rejected = runtime.transition({
      proposal: transition(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Reject route.',
      },
    })
    const replan = runtime.transition({
      proposal: transition(),
      hostDecision: {
        decision: 'request_replan',
        actor: 'host-orchestrator',
        rationale: 'Need a new route.',
      },
    })
    const blocked = runtime.transition({
      proposal: transition(),
      hostDecision: {
        decision: 'accept_transition',
        actor: '',
        rationale: '',
      },
    })

    expect(rejected).toMatchObject({ sequence: 1, stateUpdated: false, transition: { status: 'rejected' } })
    expect(replan).toMatchObject({ sequence: 2, stateUpdated: false, transition: { status: 'replan_requested' } })
    expect(blocked).toMatchObject({ sequence: 3, stateUpdated: false, transition: { status: 'blocked' } })
    expect(runtime.getState()).toEqual(state())
    expect(runtime.getHistory().map(record => record.stateUpdated)).toEqual([false, false, false])
  })

  it('returns defensive copies for state, snapshot, and history', () => {
    const runtime = createPlanHostRuntimeState({
      plan: plan(),
      initialState: state(),
    })
    runtime.transition({
      proposal: transition(),
      hostDecision: acceptDecision(),
    })

    const leakedState = runtime.getState()
    leakedState.completedSteps.push('leaked')
    const leakedHistory = runtime.getHistory()
    leakedHistory[0]!.nextState.completedSteps.push('leaked-history')
    const leakedSnapshot = runtime.getSnapshot()
    leakedSnapshot.state.completedSteps.push('leaked-snapshot')
    leakedSnapshot.plan.steps[0]!.allowedTools.push('leaked-tool')

    expect(runtime.getState().completedSteps).toEqual(['inspect'])
    expect(runtime.getHistory()[0]!.nextState.completedSteps).toEqual(['inspect'])
    expect(runtime.getSnapshot()).toMatchObject({
      scope: 'current_run_plan_host_runtime_state',
      transitionCount: 1,
      state: {
        currentStepId: 'validate',
        completedSteps: ['inspect'],
      },
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(runtime.getSnapshot().plan.steps[0]!.allowedTools).toEqual(['coding_read_file'])
  })

  it('can apply a second accepted transition from the persisted current state', () => {
    const runtime = createPlanHostRuntimeState({
      plan: plan(),
      initialState: state(),
    })
    runtime.transition({
      proposal: transition(),
      hostDecision: acceptDecision(),
    })
    const second = runtime.transition({
      proposal: transition({
        proposal: 'advance_step',
        reason: 'Current step validate has satisfied expected evidence.',
        stepId: 'validate',
        nextStepId: undefined,
        proposedOperations: [
          {
            kind: 'append_completed_step',
            stepId: 'validate',
            summary: 'Mark plan step validate completed.',
          },
          {
            kind: 'clear_current_step',
            stepId: 'validate',
            summary: 'Clear current step; no further pending step is available.',
          },
        ],
      }),
      hostDecision: {
        ...acceptDecision(),
        rationale: 'Validation evidence satisfied current step.',
      },
    })

    expect(second).toMatchObject({
      sequence: 2,
      stateUpdated: true,
      previousState: {
        currentStepId: 'validate',
        completedSteps: ['inspect'],
      },
      nextState: {
        completedSteps: ['inspect', 'validate'],
        failedSteps: [],
        skippedSteps: [],
        blockers: [],
      },
    })
    expect(runtime.getState()).toMatchObject({
      completedSteps: ['inspect', 'validate'],
      failedSteps: [],
      skippedSteps: [],
      blockers: [],
    })
    expect(runtime.getState().currentStepId).toBeUndefined()
  })
})
