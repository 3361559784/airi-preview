import type { PlanSpec, PlanState } from './contract'
import type { PlanRuntimeRecoveryRequest } from './runtime-recovery'

import { describe, expect, it } from 'vitest'

import { acceptHostSuppliedReplacementPlan } from './runtime-replan'

function previousPlan(): PlanSpec {
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
    ],
  }
}

function replacementPlan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    goal: 'Run replacement validation path.',
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
        id: 'validate-replacement',
        lane: 'terminal',
        intent: 'Run replacement validation.',
        allowedTools: ['terminal_exec'],
        expectedEvidence: [{ source: 'tool_result', description: 'replacement validation result' }],
        riskLevel: 'medium',
        approvalRequired: false,
      },
    ],
    ...overrides,
  }
}

function initialState(overrides: Partial<PlanState> = {}): PlanState {
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

function recovery(overrides: Partial<PlanRuntimeRecoveryRequest> = {}): PlanRuntimeRecoveryRequest {
  return {
    scope: 'current_run_plan_runtime_recovery_request',
    status: 'replan_required',
    trigger: 'host_requested_replan',
    sourceStatus: 'replan_requested',
    reason: 'The validation route is stale.',
    replanInput: {
      previousGoal: 'Inspect and validate.',
      previousPlan: previousPlan(),
      currentState: {
        currentStepId: 'inspect',
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      },
      trigger: 'host_requested_replan',
      reason: 'The validation route is stale.',
      blockedSummaries: ['The validation route is stale.'],
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

describe('host-supplied plan runtime replacement contract', () => {
  it('accepts a host-supplied replacement PlanSpec and creates a new current-run runtime holder', () => {
    const suppliedPlan = replacementPlan()
    const suppliedState = initialState()
    const result = acceptHostSuppliedReplacementPlan({
      recovery: recovery(),
      replacementPlan: suppliedPlan,
      initialState: suppliedState,
      actor: 'host-orchestrator',
      rationale: 'Use a safer validation route.',
    })

    expect(result.record).toMatchObject({
      scope: 'current_run_plan_runtime_replacement',
      status: 'accepted',
      actor: 'host-orchestrator',
      rationale: 'Use a safer validation route.',
      recoveryStatus: 'replan_required',
      recoveryTrigger: 'host_requested_replan',
      previousPlan: previousPlan(),
      previousState: {
        currentStepId: 'inspect',
        completedSteps: [],
      },
      replacementSnapshot: {
        scope: 'current_run_plan_host_runtime_state',
        plan: suppliedPlan,
        state: suppliedState,
        transitionCount: 0,
        mutatesPersistentState: false,
        mayExecute: false,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
      problems: [],
      acceptsHostSuppliedPlanSpecOnly: true,
      mayCreatePlanSpec: false,
      mayMutatePreviousPlanState: false,
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.runtime?.getSnapshot()).toMatchObject({
      plan: suppliedPlan,
      state: suppliedState,
      transitionCount: 0,
    })
  })

  it('rejects replacement when recovery does not require replanning', () => {
    const result = acceptHostSuppliedReplacementPlan({
      recovery: recovery({
        status: 'not_required',
        trigger: undefined,
        replanInput: undefined,
      }),
      replacementPlan: replacementPlan(),
      initialState: initialState(),
      actor: 'host-orchestrator',
      rationale: 'Try replacement without recovery.',
    })

    expect(result.runtime).toBeUndefined()
    expect(result.record).toMatchObject({
      status: 'blocked',
      recoveryStatus: 'not_required',
      problems: [expect.objectContaining({ reason: 'recovery_not_replan_required' })],
      mayCreatePlanSpec: false,
      mayExecute: false,
    })
  })

  it('requires non-empty host actor and rationale', () => {
    const result = acceptHostSuppliedReplacementPlan({
      recovery: recovery(),
      replacementPlan: replacementPlan(),
      initialState: initialState(),
      actor: ' ',
      rationale: '',
    })

    expect(result.runtime).toBeUndefined()
    expect(result.record).toMatchObject({
      status: 'blocked',
      actor: '',
      rationale: '',
      problems: [
        expect.objectContaining({ reason: 'empty_actor' }),
        expect.objectContaining({ reason: 'empty_rationale' }),
      ],
    })
  })

  it('rejects structurally invalid replacement plans', () => {
    const result = acceptHostSuppliedReplacementPlan({
      recovery: recovery(),
      replacementPlan: replacementPlan({
        goal: ' ',
        steps: [
          {
            ...replacementPlan().steps[0]!,
            id: 'duplicate',
          },
          {
            ...replacementPlan().steps[1]!,
            id: 'duplicate',
          },
          {
            ...replacementPlan().steps[1]!,
            id: ' ',
          },
        ],
      }),
      initialState: initialState({ currentStepId: 'duplicate' }),
      actor: 'host-orchestrator',
      rationale: 'Try invalid replacement.',
    })

    expect(result.runtime).toBeUndefined()
    expect(result.record.problems).toEqual([
      expect.objectContaining({ reason: 'empty_goal' }),
      expect.objectContaining({ reason: 'duplicate_step_id', stepId: 'duplicate' }),
      expect.objectContaining({ reason: 'empty_step_id' }),
    ])
  })

  it('rejects replacement initial state that references steps outside the replacement plan', () => {
    const result = acceptHostSuppliedReplacementPlan({
      recovery: recovery(),
      replacementPlan: replacementPlan(),
      initialState: initialState({
        currentStepId: 'inspect',
        completedSteps: ['read-replacement'],
        evidenceRefs: [
          {
            stepId: 'missing-evidence-step',
            source: 'runtime_trace',
            summary: 'missing',
          },
        ],
      }),
      actor: 'host-orchestrator',
      rationale: 'Try mismatched initial state.',
    })

    expect(result.runtime).toBeUndefined()
    expect(result.record.problems).toEqual([
      expect.objectContaining({ reason: 'initial_state_step_missing', stepId: 'inspect' }),
      expect.objectContaining({ reason: 'initial_state_step_missing', stepId: 'missing-evidence-step' }),
    ])
  })

  it('rejects conflicting replacement initial state', () => {
    const result = acceptHostSuppliedReplacementPlan({
      recovery: recovery(),
      replacementPlan: replacementPlan(),
      initialState: initialState({
        currentStepId: 'read-replacement',
        completedSteps: ['read-replacement', 'validate-replacement'],
        failedSteps: ['validate-replacement'],
      }),
      actor: 'host-orchestrator',
      rationale: 'Try conflicting initial state.',
    })

    expect(result.runtime).toBeUndefined()
    expect(result.record.problems).toEqual([
      expect.objectContaining({ reason: 'initial_state_step_conflict', stepId: 'read-replacement' }),
      expect.objectContaining({ reason: 'initial_state_step_conflict', stepId: 'validate-replacement' }),
    ])
  })

  it('returns defensive replacement runtime and record copies', () => {
    const suppliedPlan = replacementPlan()
    const suppliedState = initialState()
    const result = acceptHostSuppliedReplacementPlan({
      recovery: recovery(),
      replacementPlan: suppliedPlan,
      initialState: suppliedState,
      actor: 'host-orchestrator',
      rationale: 'Use a replacement route.',
    })

    result.record.replacementSnapshot!.plan.steps[0]!.allowedTools.push('leaked-tool')
    result.record.replacementSnapshot!.state.completedSteps.push('leaked-step')
    suppliedPlan.steps[0]!.allowedTools.push('mutated-input-tool')
    suppliedState.completedSteps.push('mutated-input-step')

    expect(result.runtime!.getSnapshot().plan.steps[0]!.allowedTools).toEqual(['coding_read_file'])
    expect(result.runtime!.getSnapshot().state.completedSteps).toEqual([])
  })
})
