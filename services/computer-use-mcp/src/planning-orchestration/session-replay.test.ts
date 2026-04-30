import type { PlanSpec, PlanState } from './contract'
import type { PlanRuntimeRecoveryRequest } from './runtime-recovery'
import type {
  PlanHostRuntimeSessionController,
  PlanHostRuntimeSessionSnapshot,
} from './runtime-session'
import type { PlanStateTransitionProposal } from './state-transition'
import type { PlanHostSessionWorkflowRunResult } from './workflow-session'

import { describe, expect, it } from 'vitest'

import { createPlanHostRuntimeSession } from './runtime-session'
import {
  findPlanSessionRecoveryReplayCase,
  normalizePlanSessionRecoveryReplay,
} from './session-replay'

function plan(): PlanSpec {
  return {
    goal: 'Inspect and validate source.',
    steps: [
      {
        id: 'inspect',
        lane: 'coding',
        intent: 'Inspect source files.',
        allowedTools: ['coding_read_file'],
        expectedEvidence: [{ source: 'tool_result', description: 'source file read' }],
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
    goal: 'Use replacement path.',
    steps: [
      {
        id: 'replacement-read',
        lane: 'coding',
        intent: 'Read replacement file.',
        allowedTools: ['coding_read_file'],
        expectedEvidence: [{ source: 'tool_result', description: 'replacement read' }],
        riskLevel: 'low',
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

function replacementState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    currentStepId: 'replacement-read',
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
    reason: 'Current step has enough tool evidence.',
    stepId: 'inspect',
    nextStepId: 'validate',
    proposedOperations: [
      {
        kind: 'append_completed_step',
        stepId: 'inspect',
        summary: 'Mark inspect completed.',
      },
      {
        kind: 'set_current_step',
        stepId: 'validate',
        summary: 'Advance to validation.',
      },
    ],
    mayMutatePlanState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
    ...overrides,
  }
}

function session(): PlanHostRuntimeSessionController {
  return createPlanHostRuntimeSession({
    sessionId: 'session-replay-1',
    plan: plan(),
    initialState: state(),
  })
}

function replanRecovery(overrides: Partial<PlanRuntimeRecoveryRequest> = {}): PlanRuntimeRecoveryRequest {
  return {
    scope: 'current_run_plan_runtime_recovery_request',
    status: 'replan_required',
    trigger: 'host_requested_replan',
    sourceStatus: 'replan_requested',
    reason: 'Validation route is stale.',
    replanInput: {
      previousGoal: plan().goal,
      previousPlan: plan(),
      currentState: state({
        currentStepId: 'validate',
        completedSteps: ['inspect'],
      }),
      trigger: 'host_requested_replan',
      reason: 'Validation route is stale.',
      blockedSummaries: ['Validation route is stale.'],
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

function skippedWorkflowRun(
  snapshot: PlanHostRuntimeSessionSnapshot,
  overrides: Partial<PlanHostSessionWorkflowRunResult> = {},
): PlanHostSessionWorkflowRunResult {
  return {
    scope: 'current_run_plan_host_session_workflow_run',
    status: 'skipped',
    execution: {
      scope: 'current_run_plan_workflow_execution',
      status: 'blocked',
      executed: false,
      problems: [{ reason: 'mapping_not_mapped', detail: 'Plan workflow mapping status is blocked.' }],
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    },
    reconciliation: {
      scope: 'current_run_plan_workflow_reconciliation',
      included: false,
      skippedReason: 'workflow_execution_not_available',
      evidenceObservations: [],
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    },
    beforeSessionSnapshot: snapshot,
    afterSessionSnapshot: snapshot,
    problems: [{
      reason: 'reconciliation_not_included',
      detail: 'Workflow reconciliation was skipped: workflow_execution_not_available',
    }],
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
    ...overrides,
  }
}

describe('plan session recovery replay contract', () => {
  it('is deterministic and does not mutate session or workflow inputs', () => {
    const controller = session()
    controller.transition({
      proposal: transition(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Reject auto-advance.',
      },
    })
    const snapshot = controller.getSnapshot()
    const workflowRun = skippedWorkflowRun(snapshot)
    const snapshotBefore = structuredClone(snapshot)
    const workflowRunBefore = structuredClone(workflowRun)

    const first = normalizePlanSessionRecoveryReplay({ session: snapshot, workflowRun })
    const second = normalizePlanSessionRecoveryReplay({ session: snapshot, workflowRun })

    expect(second).toEqual(first)
    expect(snapshot).toEqual(snapshotBefore)
    expect(workflowRun).toEqual(workflowRunBefore)
  })

  it('classifies blocked host transitions without treating them as execution or proof', () => {
    const controller = session()
    controller.transition({
      proposal: transition(),
      hostDecision: {
        decision: 'accept_transition',
        actor: '',
        rationale: '',
      },
    })

    const row = normalizePlanSessionRecoveryReplay({ session: controller.getSnapshot() })

    expect(row).toMatchObject({
      scope: 'current_run_plan_session_recovery_replay',
      source: 'host_plan_runtime_session',
      sessionId: 'session-replay-1',
      failureClass: 'transition_blocked',
      activeGoalPreview: 'Inspect and validate source.',
      activeCurrentStepId: 'inspect',
      eventCount: 1,
      transitionCount: 1,
      replacementCount: 0,
      latestEvent: {
        sequence: 1,
        generation: 1,
        kind: 'transition',
        status: 'blocked',
        proposalKind: 'advance_step',
        stateUpdated: false,
        problemReasons: ['host_entry_problem', 'host_entry_problem', 'apply_problem'],
      },
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(row.nextFollowUp).toContain('blocked plan session transition')
  })

  it('classifies rejected host transitions as audited recovery evidence', () => {
    const controller = session()
    controller.transition({
      proposal: transition(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Reject auto-advance.',
      },
    })

    const row = normalizePlanSessionRecoveryReplay({ session: controller.getSnapshot() })

    expect(row.failureClass).toBe('transition_rejected')
    expect(row.latestEvent).toMatchObject({
      kind: 'transition',
      status: 'rejected',
      problemReasons: ['apply_problem'],
      stateUpdated: false,
    })
    expect(row.classificationSummary).toContain('rejected')
  })

  it('classifies host-requested replan transitions', () => {
    const controller = session()
    controller.transition({
      proposal: transition({ proposal: 'replan', proposedOperations: [] }),
      hostDecision: {
        decision: 'request_replan',
        actor: 'host-orchestrator',
        rationale: 'Need a new path.',
      },
    })

    const row = normalizePlanSessionRecoveryReplay({ session: controller.getSnapshot() })

    expect(row.failureClass).toBe('replan_requested')
    expect(row.latestEvent).toMatchObject({
      status: 'replan_requested',
      proposalKind: 'replan',
    })
    expect(row.nextFollowUp).toContain('plan session replan request')
  })

  it('classifies blocked replacement plan acceptance', () => {
    const controller = session()
    controller.replacePlan({
      recovery: replanRecovery({ status: 'not_required', trigger: undefined, replanInput: undefined }),
      replacementPlan: replacementPlan(),
      initialState: replacementState(),
      actor: 'host-orchestrator',
      rationale: 'Try replacement without recovery.',
    })

    const row = normalizePlanSessionRecoveryReplay({ session: controller.getSnapshot() })

    expect(row.failureClass).toBe('replacement_blocked')
    expect(row.latestEvent).toMatchObject({
      kind: 'replacement',
      status: 'blocked',
      activeRuntimeReplaced: false,
      problemReasons: ['recovery_not_replan_required'],
    })
  })

  it('classifies blocked mapped workflow execution before session mutation', () => {
    const controller = session()
    const snapshot = controller.getSnapshot()
    const row = normalizePlanSessionRecoveryReplay({
      session: snapshot,
      workflowRun: skippedWorkflowRun(snapshot),
    })

    expect(row.failureClass).toBe('workflow_execution_blocked')
    expect(row.workflowRun).toMatchObject({
      status: 'skipped',
      executionStatus: 'blocked',
      executed: false,
      reconciliationIncluded: false,
      reconciliationSkippedReason: 'workflow_execution_not_available',
      problemReasons: ['reconciliation_not_included'],
    })
    expect(row.eventHistory).toEqual([])
  })

  it('classifies skipped workflow reconciliation separately from blocked execution', () => {
    const controller = session()
    const snapshot = controller.getSnapshot()
    const row = normalizePlanSessionRecoveryReplay({
      session: snapshot,
      workflowRun: skippedWorkflowRun(snapshot, {
        execution: {
          scope: 'current_run_plan_workflow_execution',
          status: 'completed',
          executed: true,
          problems: [],
          maySatisfyVerificationGate: false,
          maySatisfyMutationProof: false,
        },
        problems: [{
          reason: 'missing_transition_proposal',
          detail: 'Workflow reconciliation did not produce a transition proposal.',
        }],
      }),
    })

    expect(row.failureClass).toBe('workflow_reconciliation_skipped')
    expect(row.workflowRun).toMatchObject({
      executionStatus: 'completed',
      executed: true,
      reconciliationIncluded: false,
      problemReasons: ['missing_transition_proposal'],
    })
  })

  it('falls back to deterministic replay first for unmapped clean sessions', () => {
    const row = normalizePlanSessionRecoveryReplay({ session: session().getSnapshot() })

    expect(row.failureClass).toBe('unknown')
    expect(row.classificationSummary).toContain('Unmapped plan session recovery signal')
    expect(row.nextFollowUp).toBe('test(computer-use-mcp): add deterministic replay for unmapped plan session recovery')
    expect(findPlanSessionRecoveryReplayCase('unknown')).toMatchObject({
      failureClass: 'unknown',
      deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts unknown recovery fallback',
    })
  })

  it('does not produce memory export or verification authority shapes', () => {
    const row = normalizePlanSessionRecoveryReplay({ session: session().getSnapshot() })

    expect(row).not.toHaveProperty('workspaceKey')
    expect(row).not.toHaveProperty('memoryId')
    expect(row).not.toHaveProperty('humanVerified')
    expect(row).not.toHaveProperty('evidencePins')
    expect(row).toMatchObject({
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })
})
