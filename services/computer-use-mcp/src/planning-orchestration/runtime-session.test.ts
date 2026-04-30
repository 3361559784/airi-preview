import type { PlanSpec, PlanState } from './contract'
import type { PlanRuntimeRecoveryRequest } from './runtime-recovery'
import type { PlanStateTransitionProposal } from './state-transition'

import { describe, expect, it } from 'vitest'

import { createPlanHostRuntimeSession } from './runtime-session'

function initialPlan(): PlanSpec {
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

function replacementPlan(): PlanSpec {
  return {
    goal: 'Use replacement validation route.',
    steps: [
      {
        id: 'read-replacement',
        lane: 'coding',
        intent: 'Read replacement target.',
        allowedTools: ['coding_read_file'],
        expectedEvidence: [{ source: 'tool_result', description: 'replacement file read' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
      {
        id: 'review-replacement',
        lane: 'coding',
        intent: 'Review replacement target.',
        allowedTools: ['coding_review_changes'],
        expectedEvidence: [{ source: 'tool_result', description: 'replacement review result' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
    ],
  }
}

function initialState(overrides: Partial<PlanState> = {}): PlanState {
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

function replacementState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    currentStepId: 'read-replacement',
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
    reason: 'Current step has satisfied expected evidence.',
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

function replanRecovery(overrides: Partial<PlanRuntimeRecoveryRequest> = {}): PlanRuntimeRecoveryRequest {
  return {
    scope: 'current_run_plan_runtime_recovery_request',
    status: 'replan_required',
    trigger: 'host_requested_replan',
    sourceStatus: 'replan_requested',
    reason: 'Validation path is stale.',
    replanInput: {
      previousGoal: 'Inspect and validate.',
      previousPlan: initialPlan(),
      currentState: {
        currentStepId: 'validate',
        completedSteps: ['inspect'],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      },
      trigger: 'host_requested_replan',
      reason: 'Validation path is stale.',
      blockedSummaries: ['Validation path is stale.'],
      boundaries: ['A host or planner must provide any replacement PlanSpec explicitly.'],
    },
    mayCreatePlanSpec: false,
    mayMutatePlanState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
    ...overrides,
  }
}

describe('host-owned plan runtime session contract', () => {
  it('creates a current-run session over the initial plan runtime holder', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: initialPlan(),
      initialState: initialState(),
    })

    expect(session.getSnapshot()).toMatchObject({
      scope: 'current_run_plan_host_runtime_session',
      sessionId: 'session-1',
      generation: 1,
      initialSnapshot: {
        scope: 'current_run_plan_host_runtime_state',
        plan: initialPlan(),
        state: initialState(),
        transitionCount: 0,
      },
      activeSnapshot: {
        plan: initialPlan(),
        state: initialState(),
        transitionCount: 0,
      },
      eventCount: 0,
      transitionCount: 0,
      replacementCount: 0,
      history: [],
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })

  it('records current-run transition events without satisfying execution or proof gates', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: initialPlan(),
      initialState: initialState(),
    })
    const event = session.transition({
      proposal: transition(),
      hostDecision: acceptDecision(),
    })

    expect(event).toMatchObject({
      scope: 'current_run_plan_host_runtime_session_event',
      sequence: 1,
      generation: 1,
      kind: 'transition',
      transitionRecord: {
        sequence: 1,
        stateUpdated: true,
        transition: { status: 'applied' },
      },
      snapshot: {
        state: {
          currentStepId: 'validate',
          completedSteps: ['inspect'],
        },
        transitionCount: 1,
      },
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(session.getSnapshot()).toMatchObject({
      generation: 1,
      eventCount: 1,
      transitionCount: 1,
      replacementCount: 0,
      activeSnapshot: {
        state: {
          currentStepId: 'validate',
          completedSteps: ['inspect'],
        },
      },
    })
  })

  it('accepts host-supplied replacement plans and switches the active current-run runtime generation', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: initialPlan(),
      initialState: initialState(),
    })
    session.transition({
      proposal: transition(),
      hostDecision: acceptDecision(),
    })
    const replacement = session.replacePlan({
      recovery: replanRecovery(),
      replacementPlan: replacementPlan(),
      initialState: replacementState(),
      actor: 'host-orchestrator',
      rationale: 'Use a safer route.',
    })

    expect(replacement).toMatchObject({
      scope: 'current_run_plan_host_runtime_session_event',
      sequence: 2,
      generation: 2,
      kind: 'replacement',
      activeRuntimeReplaced: true,
      replacement: {
        scope: 'current_run_plan_runtime_replacement',
        status: 'accepted',
        actor: 'host-orchestrator',
        rationale: 'Use a safer route.',
        acceptsHostSuppliedPlanSpecOnly: true,
        mayCreatePlanSpec: false,
        mayMutatePreviousPlanState: false,
        mayExecute: false,
      },
      previousSnapshot: {
        state: {
          currentStepId: 'validate',
          completedSteps: ['inspect'],
        },
      },
      nextSnapshot: {
        plan: replacementPlan(),
        state: replacementState(),
        transitionCount: 0,
      },
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(session.getSnapshot()).toMatchObject({
      generation: 2,
      eventCount: 2,
      transitionCount: 1,
      replacementCount: 1,
      activeSnapshot: {
        plan: replacementPlan(),
        state: replacementState(),
      },
    })
  })

  it('keeps the existing active runtime when replacement acceptance is blocked', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: initialPlan(),
      initialState: initialState(),
    })
    const replacement = session.replacePlan({
      recovery: replanRecovery({ status: 'not_required', trigger: undefined, replanInput: undefined }),
      replacementPlan: replacementPlan(),
      initialState: replacementState(),
      actor: 'host-orchestrator',
      rationale: 'Try replacement without recovery.',
    })

    expect(replacement).toMatchObject({
      sequence: 1,
      generation: 1,
      kind: 'replacement',
      activeRuntimeReplaced: false,
      replacement: {
        status: 'blocked',
        problems: [expect.objectContaining({ reason: 'recovery_not_replan_required' })],
      },
      previousSnapshot: {
        plan: initialPlan(),
        state: initialState(),
      },
      nextSnapshot: {
        plan: initialPlan(),
        state: initialState(),
      },
    })
    expect(session.getSnapshot()).toMatchObject({
      generation: 1,
      eventCount: 1,
      transitionCount: 0,
      replacementCount: 1,
      activeSnapshot: {
        plan: initialPlan(),
        state: initialState(),
      },
    })
  })

  it('applies later transitions against the replacement generation', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: initialPlan(),
      initialState: initialState(),
    })
    session.replacePlan({
      recovery: replanRecovery(),
      replacementPlan: replacementPlan(),
      initialState: replacementState(),
      actor: 'host-orchestrator',
      rationale: 'Use a safer route.',
    })
    const event = session.transition({
      proposal: transition({
        stepId: 'read-replacement',
        nextStepId: 'review-replacement',
        proposedOperations: [
          {
            kind: 'append_completed_step',
            stepId: 'read-replacement',
            summary: 'Mark replacement read completed.',
          },
          {
            kind: 'set_current_step',
            stepId: 'review-replacement',
            summary: 'Advance to replacement review.',
          },
        ],
      }),
      hostDecision: acceptDecision(),
    })

    expect(event).toMatchObject({
      sequence: 2,
      generation: 2,
      kind: 'transition',
      transitionRecord: {
        sequence: 1,
        stateUpdated: true,
        nextState: {
          currentStepId: 'review-replacement',
          completedSteps: ['read-replacement'],
        },
      },
      snapshot: {
        plan: replacementPlan(),
        state: {
          currentStepId: 'review-replacement',
          completedSteps: ['read-replacement'],
        },
        transitionCount: 1,
      },
    })
    expect(session.getSnapshot()).toMatchObject({
      generation: 2,
      eventCount: 2,
      transitionCount: 1,
      replacementCount: 1,
    })
  })

  it('returns defensive copies for active snapshots and session history', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: initialPlan(),
      initialState: initialState(),
    })
    session.transition({
      proposal: transition(),
      hostDecision: acceptDecision(),
    })

    const activeSnapshot = session.getActiveRuntimeSnapshot()
    activeSnapshot.state.completedSteps.push('leaked-active')
    const history = session.getHistory()
    history[0]!.kind === 'transition' && history[0]!.snapshot.state.completedSteps.push('leaked-history')
    const snapshot = session.getSnapshot()
    snapshot.history[0]!.kind === 'transition' && snapshot.history[0]!.transitionRecord.nextState.completedSteps.push('leaked-snapshot')
    snapshot.initialSnapshot.plan.steps[0]!.allowedTools.push('leaked-tool')

    expect(session.getActiveRuntimeSnapshot().state.completedSteps).toEqual(['inspect'])
    expect(session.getHistory()[0]).toMatchObject({
      kind: 'transition',
      snapshot: {
        state: {
          completedSteps: ['inspect'],
        },
      },
    })
    expect(session.getSnapshot().initialSnapshot.plan.steps[0]!.allowedTools).toEqual(['coding_read_file'])
  })
})
