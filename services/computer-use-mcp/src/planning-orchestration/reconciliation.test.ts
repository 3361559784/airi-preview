import type { PlanSpec, PlanState } from './contract'
import type { PlanEvidenceObservation } from './reconciliation'

import { describe, expect, it } from 'vitest'

import { hasHigherPlanningAuthority } from './contract'
import { reconcilePlanEvidence } from './reconciliation'

describe('plan evidence reconciliation contract', () => {
  const plan: PlanSpec = {
    goal: 'Validate desktop smoke and repair the smallest failure.',
    steps: [
      {
        id: 'inspect',
        lane: 'coding',
        intent: 'Inspect smoke scripts and current tests.',
        allowedTools: ['workflow_coding_runner'],
        expectedEvidence: [{ source: 'tool_result', description: 'Relevant files identified.' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
      {
        id: 'validate',
        lane: 'terminal',
        intent: 'Run targeted validation.',
        allowedTools: ['terminal_exec'],
        expectedEvidence: [
          { source: 'tool_result', description: 'Validation command exit code observed.' },
          { source: 'verification_gate', description: 'Verification gate evaluated report evidence.' },
        ],
        riskLevel: 'medium',
        approvalRequired: false,
      },
      {
        id: 'approve',
        lane: 'human',
        intent: 'Confirm risky follow-up.',
        allowedTools: [],
        expectedEvidence: [{ source: 'human_approval', description: 'Human approval recorded.' }],
        riskLevel: 'high',
        approvalRequired: true,
      },
    ],
  }

  const observations: PlanEvidenceObservation[] = [
    {
      id: 'obs-1',
      stepId: 'inspect',
      source: 'tool_result',
      status: 'satisfied',
      summary: 'Read smoke script.',
      toolName: 'coding_read_file',
    },
    {
      id: 'obs-2',
      stepId: 'validate',
      source: 'tool_result',
      status: 'satisfied',
      summary: 'terminal_exec exited 0.',
      toolName: 'terminal_exec',
    },
    {
      id: 'obs-3',
      stepId: 'validate',
      source: 'verification_gate',
      status: 'satisfied',
      summary: 'Verification gate passed.',
      reasonCode: 'gate_pass',
    },
    {
      id: 'obs-4',
      stepId: 'approve',
      source: 'human_approval',
      status: 'satisfied',
      summary: 'Human approved follow-up.',
    },
  ]

  it('continues when the current step has complete expected evidence but is not completed yet', () => {
    const state: PlanState = {
      currentStepId: 'inspect',
      completedSteps: [],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [{ stepId: 'inspect', source: 'tool_result', summary: 'Read smoke script.' }],
      blockers: [],
    }

    const result = reconcilePlanEvidence({
      plan,
      state,
      observations: [observations[0]!],
    })

    expect(result.decision).toEqual({
      decision: 'continue',
      reason: 'Plan evidence is not complete yet.',
      stepId: 'inspect',
    })
    expect(result.stepResults[0]).toMatchObject({
      stepId: 'inspect',
      planStatus: 'in_progress',
      evidenceStatus: 'satisfied',
    })
    expect(result.maySatisfyVerificationGate).toBe(false)
    expect(result.maySatisfyMutationProof).toBe(false)
  })

  it('requires approval when the current approval step lacks human approval evidence', () => {
    const state: PlanState = {
      currentStepId: 'approve',
      completedSteps: ['inspect', 'validate'],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
    }

    const result = reconcilePlanEvidence({
      plan,
      state,
      observations: observations.slice(0, 3),
    })

    expect(result.decision).toEqual({
      decision: 'require_approval',
      reason: 'Plan step requires approval evidence: approve',
      stepId: 'approve',
      requiredApproval: 'Human approval recorded.',
    })
    expect(result.stepResults.find(step => step.stepId === 'approve')).toMatchObject({
      planStatus: 'in_progress',
      evidenceStatus: 'requires_approval',
    })
  })

  it('continues after current approval evidence is observed but the step is not completed yet', () => {
    const state: PlanState = {
      currentStepId: 'approve',
      completedSteps: ['inspect', 'validate'],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
    }

    const result = reconcilePlanEvidence({
      plan,
      state,
      observations,
    })

    expect(result.decision).toEqual({
      decision: 'continue',
      reason: 'Plan evidence is not complete yet.',
      stepId: 'approve',
    })
    expect(result.stepResults.find(step => step.stepId === 'approve')).toMatchObject({
      planStatus: 'in_progress',
      evidenceStatus: 'satisfied',
    })
  })

  it('becomes ready for final verification only when every non-skipped step is completed with expected evidence', () => {
    const state: PlanState = {
      completedSteps: ['inspect', 'validate', 'approve'],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
    }

    const result = reconcilePlanEvidence({ plan, state, observations })

    expect(result.decision).toEqual({
      decision: 'ready_for_final_verification',
      reason: 'All non-skipped plan steps have matched current-run evidence.',
    })
    expect(result.stepResults.map(step => step.evidenceStatus)).toEqual([
      'satisfied',
      'satisfied',
      'satisfied',
    ])
    expect(hasHigherPlanningAuthority('verification_gate_decision', 'plan_state_reconciler_decision')).toBe(true)
  })

  it('does not treat plan completion claims as evidence', () => {
    const twoStepPlan: PlanSpec = {
      ...plan,
      steps: plan.steps.slice(0, 2),
    }
    const state: PlanState = {
      completedSteps: ['inspect', 'validate'],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
    }

    const result = reconcilePlanEvidence({ plan: twoStepPlan, state, observations: [] })

    expect(result.decision).toEqual({
      decision: 'continue',
      reason: 'Completed plan step still lacks expected evidence: inspect',
      stepId: 'inspect',
    })
    expect(result.stepResults[0]).toMatchObject({
      planStatus: 'completed',
      evidenceStatus: 'missing_evidence',
    })
  })

  it('replans when current-run evidence failed', () => {
    const state: PlanState = {
      currentStepId: 'validate',
      completedSteps: ['inspect'],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
    }

    const result = reconcilePlanEvidence({
      plan,
      state,
      observations: [
        observations[0]!,
        {
          stepId: 'validate',
          source: 'tool_result',
          status: 'failed',
          summary: 'terminal_exec exited 1.',
          toolName: 'terminal_exec',
        },
      ],
    })

    expect(result.decision).toEqual({
      decision: 'replan',
      reason: 'Plan evidence failed for step: validate',
      stepId: 'validate',
    })
    expect(result.stepResults.find(step => step.stepId === 'validate')).toMatchObject({
      evidenceStatus: 'blocked_by_failed_evidence',
    })
  })

  it('replans on blockers and unknown current step without mutating inputs', () => {
    const blockedState: PlanState = {
      currentStepId: 'validate',
      completedSteps: ['inspect'],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: ['desktop smoke changed while validating'],
    }
    const unknownCurrentState: PlanState = {
      currentStepId: 'missing-step',
      completedSteps: [],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
    }
    const planBefore = structuredClone(plan)
    const blockedStateBefore = structuredClone(blockedState)

    expect(reconcilePlanEvidence({ plan, state: blockedState, observations }).decision).toEqual({
      decision: 'replan',
      reason: 'Plan state has blockers that require replanning.',
      stepId: 'validate',
    })
    expect(reconcilePlanEvidence({ plan, state: unknownCurrentState, observations: [] }).decision).toEqual({
      decision: 'replan',
      reason: 'Current step is not in plan: missing-step',
      stepId: 'missing-step',
    })
    expect(plan).toEqual(planBefore)
    expect(blockedState).toEqual(blockedStateBefore)
  })

  it('fails on structurally inconsistent plan state', () => {
    const result = reconcilePlanEvidence({
      plan,
      state: {
        currentStepId: 'inspect',
        completedSteps: ['inspect'],
        failedSteps: ['inspect'],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      },
      observations: [],
    })

    expect(result.decision).toEqual({
      decision: 'fail',
      reason: 'Plan state puts step in multiple terminal buckets: inspect',
      stepId: 'inspect',
    })
  })

  it('ignores unrelated observations and skipped steps do not block final verification', () => {
    const twoStepPlan: PlanSpec = {
      ...plan,
      steps: plan.steps.slice(0, 2),
    }
    const state: PlanState = {
      completedSteps: ['inspect'],
      failedSteps: [],
      skippedSteps: ['validate'],
      evidenceRefs: [],
      blockers: [],
    }

    const result = reconcilePlanEvidence({
      plan: twoStepPlan,
      state,
      observations: [
        observations[0]!,
        {
          stepId: 'unknown',
          source: 'tool_result',
          status: 'satisfied',
          summary: 'Unrelated tool result.',
        },
      ],
    })

    expect(result.ignoredObservationCount).toBe(1)
    expect(result.decision).toEqual({
      decision: 'ready_for_final_verification',
      reason: 'All non-skipped plan steps have matched current-run evidence.',
    })
    expect(result.stepResults.map(step => [step.stepId, step.evidenceStatus])).toEqual([
      ['inspect', 'satisfied'],
      ['validate', 'skipped'],
    ])
  })

  it('does not produce memory or export shapes', () => {
    const result = reconcilePlanEvidence({
      plan,
      state: {
        currentStepId: 'inspect',
        completedSteps: [],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      },
      observations: [observations[0]!],
    }) as unknown as Record<string, unknown>

    for (const forbiddenKey of [
      'workspaceKey',
      'memoryId',
      'humanVerified',
      'review',
      'artifactId',
      'schema',
      'exportedAt',
      'trust',
      'evidencePins',
    ]) {
      expect(result).not.toHaveProperty(forbiddenKey)
    }
  })
})
