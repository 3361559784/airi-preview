import type { PlanSpec, PlanState } from './contract'
import type { PlanWorkflowReconciliationResult } from './workflow-reconciliation'

import { describe, expect, it } from 'vitest'

import { createPlanHostRuntimeState } from './host-runtime-state'
import { applyWorkflowReconciliationTransitionForHost } from './host-workflow-caller'
import { derivePlanRuntimeRecoveryRequest, PLAN_RUNTIME_REPLAN_BOUNDARY_LINES } from './runtime-recovery'

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

function runtime(initialState: PlanState = state()) {
  return createPlanHostRuntimeState({
    plan: plan(),
    initialState,
  })
}

describe('plan runtime recovery and replan contract', () => {
  it('does not request recovery after an applied transition', () => {
    const callerResult = applyWorkflowReconciliationTransitionForHost({
      runtime: runtime(),
      reconciliation: reconciliation(),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Apply transition.',
      },
    })
    const recovery = derivePlanRuntimeRecoveryRequest({ result: callerResult })

    expect(recovery).toEqual({
      scope: 'current_run_plan_runtime_recovery_request',
      status: 'not_required',
      sourceStatus: 'applied',
      reason: 'No plan runtime recovery is required for host workflow caller status: applied',
      mayCreatePlanSpec: false,
      mayMutatePlanState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })

  it('creates a bounded replan request after host-requested replan without generating a PlanSpec', () => {
    const controller = runtime()
    const callerResult = applyWorkflowReconciliationTransitionForHost({
      runtime: controller,
      reconciliation: reconciliation(),
      hostDecision: {
        decision: 'request_replan',
        actor: 'host-orchestrator',
        rationale: 'The validation route is stale.',
      },
    })
    const recovery = derivePlanRuntimeRecoveryRequest({ result: callerResult })

    expect(recovery).toMatchObject({
      scope: 'current_run_plan_runtime_recovery_request',
      status: 'replan_required',
      trigger: 'host_requested_replan',
      sourceStatus: 'replan_requested',
      reason: 'The validation route is stale.',
      replanInput: {
        previousGoal: 'Inspect and validate.',
        currentState: state(),
        trigger: 'host_requested_replan',
        reason: 'The validation route is stale.',
        boundaries: PLAN_RUNTIME_REPLAN_BOUNDARY_LINES,
      },
      mayCreatePlanSpec: false,
      mayMutatePlanState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(recovery.replanInput?.previousPlan).toEqual(plan())
    expect(controller.getState()).toEqual(state())
  })

  it('creates a replan request after blocked transition and preserves blocked summaries', () => {
    const callerResult = applyWorkflowReconciliationTransitionForHost({
      runtime: runtime(state({ failedSteps: ['inspect'] })),
      reconciliation: reconciliation(),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Try to complete failed step.',
      },
    })
    const recovery = derivePlanRuntimeRecoveryRequest({ result: callerResult })

    expect(callerResult.status).toBe('blocked')
    expect(recovery).toMatchObject({
      status: 'replan_required',
      trigger: 'blocked_transition',
      sourceStatus: 'blocked',
      mayCreatePlanSpec: false,
      mayMutatePlanState: false,
      mayExecute: false,
    })
    expect(recovery.reason).toContain('Transition cannot complete already failed step')
    expect(recovery.replanInput?.blockedSummaries.join('\n')).toContain('Transition cannot complete already failed step')
    expect(recovery.replanInput?.currentState).toMatchObject({
      currentStepId: 'inspect',
      failedSteps: ['inspect'],
    })
  })

  it('skips recovery for skipped reconciliation caller results', () => {
    const callerResult = applyWorkflowReconciliationTransitionForHost({
      runtime: runtime(),
      reconciliation: reconciliation({
        included: false,
        skippedReason: 'missing_plan_state',
        transitionProposal: undefined,
      }),
      hostDecision: {
        decision: 'accept_transition',
        actor: 'host-orchestrator',
        rationale: 'Apply transition.',
      },
    })
    const recovery = derivePlanRuntimeRecoveryRequest({ result: callerResult })

    expect(recovery).toMatchObject({
      status: 'not_required',
      sourceStatus: 'skipped',
      mayCreatePlanSpec: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(recovery.replanInput).toBeUndefined()
  })

  it('returns defensive replan input copies', () => {
    const callerResult = applyWorkflowReconciliationTransitionForHost({
      runtime: runtime(),
      reconciliation: reconciliation(),
      hostDecision: {
        decision: 'request_replan',
        actor: 'host-orchestrator',
        rationale: 'Need a new path.',
      },
    })
    const recovery = derivePlanRuntimeRecoveryRequest({ result: callerResult })

    recovery.replanInput!.currentState.completedSteps.push('leaked')
    recovery.replanInput!.previousPlan.steps[0]!.allowedTools.push('leaked-tool')
    const secondRecovery = derivePlanRuntimeRecoveryRequest({ result: callerResult })

    expect(secondRecovery.replanInput!.currentState.completedSteps).toEqual([])
    expect(secondRecovery.replanInput!.previousPlan.steps[0]!.allowedTools).toEqual(['coding_read_file'])
  })
})
