import type { PlanSpec, PlanState } from './contract'
import type { PlanWorkflowReconciliationResult } from './workflow-reconciliation'

import { describe, expect, it } from 'vitest'

import { createPlanHostRuntimeState } from './host-runtime-state'
import { applyWorkflowReconciliationTransitionForHost } from './host-workflow-caller'

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

function reconciliation(overrides: Partial<PlanWorkflowReconciliationResult> = {}): PlanWorkflowReconciliationResult {
  return {
    scope: 'current_run_plan_workflow_reconciliation',
    included: true,
    evidenceObservations: [
      {
        stepId: 'inspect',
        source: 'tool_result',
        status: 'satisfied',
        summary: 'workflow step succeeded',
      },
    ],
    reconciliation: {
      scope: 'current_run_plan_evidence_reconciliation',
      decision: {
        decision: 'continue',
        reason: 'Current step inspect has satisfied expected evidence.',
        stepId: 'inspect',
      },
      stepResults: [],
      ignoredObservationCount: 0,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    },
    transitionProposal: {
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
    },
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
    ...overrides,
  }
}

function acceptDecision() {
  return {
    decision: 'accept_transition' as const,
    actor: 'host-orchestrator',
    rationale: 'Apply workflow reconciliation transition.',
  }
}

describe('explicit host workflow reconciliation caller', () => {
  it('applies a workflow reconciliation transition through host runtime state', () => {
    const runtime = createPlanHostRuntimeState({
      plan: plan(),
      initialState: state(),
    })
    const result = applyWorkflowReconciliationTransitionForHost({
      runtime,
      reconciliation: reconciliation(),
      hostDecision: acceptDecision(),
    })

    expect(result).toMatchObject({
      scope: 'current_run_plan_host_workflow_reconciliation_caller',
      status: 'applied',
      transitionRecord: {
        sequence: 1,
        stateUpdated: true,
        nextState: {
          currentStepId: 'validate',
          completedSteps: ['inspect'],
        },
      },
      snapshot: {
        scope: 'current_run_plan_host_runtime_state',
        transitionCount: 1,
        state: {
          currentStepId: 'validate',
          completedSteps: ['inspect'],
        },
      },
      problems: [],
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(runtime.getState()).toMatchObject({
      currentStepId: 'validate',
      completedSteps: ['inspect'],
    })
  })

  it('records rejected host decisions without updating runtime state', () => {
    const runtime = createPlanHostRuntimeState({
      plan: plan(),
      initialState: state(),
    })
    const result = applyWorkflowReconciliationTransitionForHost({
      runtime,
      reconciliation: reconciliation(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Reject this transition.',
      },
    })

    expect(result).toMatchObject({
      status: 'rejected',
      transitionRecord: {
        sequence: 1,
        stateUpdated: false,
        transition: {
          status: 'rejected',
        },
      },
      snapshot: {
        transitionCount: 1,
        state: {
          currentStepId: 'inspect',
          completedSteps: [],
        },
      },
    })
    expect(runtime.getState()).toEqual(state())
  })

  it('skips when workflow reconciliation was not included', () => {
    const runtime = createPlanHostRuntimeState({
      plan: plan(),
      initialState: state(),
    })
    const result = applyWorkflowReconciliationTransitionForHost({
      runtime,
      reconciliation: reconciliation({
        included: false,
        skippedReason: 'missing_plan_state',
        transitionProposal: undefined,
      }),
      hostDecision: acceptDecision(),
    })

    expect(result).toMatchObject({
      status: 'skipped',
      skippedReason: 'reconciliation_not_included',
      snapshot: {
        transitionCount: 0,
      },
      problems: [expect.objectContaining({ reason: 'reconciliation_not_included' })],
      mayExecute: false,
    })
    expect(result.transitionRecord).toBeUndefined()
    expect(runtime.getHistory()).toEqual([])
  })

  it('skips included reconciliation without a transition proposal', () => {
    const runtime = createPlanHostRuntimeState({
      plan: plan(),
      initialState: state(),
    })
    const result = applyWorkflowReconciliationTransitionForHost({
      runtime,
      reconciliation: reconciliation({
        transitionProposal: undefined,
      }),
      hostDecision: acceptDecision(),
    })

    expect(result).toMatchObject({
      status: 'skipped',
      skippedReason: 'missing_transition_proposal',
      problems: [expect.objectContaining({ reason: 'missing_transition_proposal' })],
      snapshot: {
        transitionCount: 0,
      },
      mutatesPersistentState: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(runtime.getHistory()).toEqual([])
  })
})
