import type { PlanSpec, PlanState } from './contract'

import { describe, expect, it } from 'vitest'

import {
  hasHigherPlanningAuthority,
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
  PLANNING_ORCHESTRATION_TRUST_LABEL,
} from './contract'
import { projectPlanStateForPrompt } from './projection'

describe('plan state projection contract', () => {
  const plan: PlanSpec = {
    goal: 'Validate desktop smoke and repair the smallest failure.',
    steps: [
      {
        id: 'inspect',
        lane: 'coding',
        intent: 'Inspect smoke scripts and tests.',
        allowedTools: ['workflow_coding_runner'],
        expectedEvidence: [{ source: 'tool_result', description: 'Relevant files and test anchors identified.' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
      {
        id: 'run-smoke',
        lane: 'terminal',
        intent: 'Run targeted smoke validation.',
        allowedTools: ['terminal_exec'],
        expectedEvidence: [{ source: 'tool_result', description: 'Command exit code and output summary.' }],
        riskLevel: 'medium',
        approvalRequired: false,
      },
      {
        id: 'request-human',
        lane: 'human',
        intent: 'Request approval if a risky follow-up is needed.',
        allowedTools: [],
        expectedEvidence: [{ source: 'human_approval', description: 'Human approval decision.' }],
        riskLevel: 'high',
        approvalRequired: true,
      },
    ],
  }

  const state: PlanState = {
    currentStepId: 'run-smoke',
    completedSteps: ['inspect'],
    failedSteps: [],
    skippedSteps: ['request-human'],
    evidenceRefs: [
      { stepId: 'inspect', source: 'tool_result', summary: 'Read smoke script and matched tests.' },
      { stepId: 'run-smoke', source: 'runtime_trace', summary: 'Smoke command queued.' },
    ],
    blockers: [],
    lastReplanReason: 'narrowed to targeted smoke',
  }

  it('projects plan state as runtime guidance with explicit trust boundary', () => {
    const projection = projectPlanStateForPrompt(plan, state)

    expect(projection.block).toContain(PLANNING_ORCHESTRATION_TRUST_LABEL)
    for (const line of PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES)
      expect(projection.block).toContain(line)

    expect(projection.block).toContain('runtime guidance, not authority')
    expect(projection.block).toContain('Projection status: active')
    expect(projection.block).toContain('May satisfy verification gate: false')
    expect(projection.block).toContain('May satisfy mutation proof: false')
    expect(projection.block).toContain('inspect [coding/completed/low]')
    expect(projection.block).toContain('run-smoke [terminal/in_progress/medium]')
    expect(projection.block).toContain('request-human [human/skipped/high/approval_required]')
    expect(projection.block).toContain('allowedTools: workflow_coding_runner')
    expect(projection.block).toContain('expectedEvidence: tool_result:Relevant files and test anchors identified.')
  })

  it('emits separate metadata for current-run projection only', () => {
    const projection = projectPlanStateForPrompt(plan, state)

    expect(projection.metadata).toEqual({
      scope: 'current_run_plan_projection',
      included: true,
      status: 'active',
      characters: projection.block.length,
      projectedStepCount: 3,
      omittedStepCount: 0,
      projectedEvidenceRefCount: 2,
      omittedEvidenceRefCount: 0,
      projectedBlockerCount: 0,
      omittedBlockerCount: 0,
      authoritySource: 'plan_state_reconciler_decision',
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })

  it('bounds steps evidence refs blockers and text previews deterministically', () => {
    const longPlan: PlanSpec = {
      goal: 'x'.repeat(80),
      steps: [
        ...plan.steps,
        {
          id: 'extra',
          lane: 'desktop',
          intent: 'Observe desktop candidates.'.repeat(10),
          allowedTools: ['desktop_observe'],
          expectedEvidence: [{ source: 'tool_result', description: 'candidate snapshot'.repeat(10) }],
          riskLevel: 'low',
          approvalRequired: false,
        },
      ],
    }
    const blockedState: PlanState = {
      ...state,
      currentStepId: 'extra',
      blockers: ['first blocker'.repeat(10), 'second blocker'],
      evidenceRefs: [
        ...state.evidenceRefs,
        { stepId: 'extra', source: 'tool_result', summary: 'candidate snapshot'.repeat(10) },
      ],
    }

    const projection = projectPlanStateForPrompt(longPlan, blockedState, {
      maxSteps: 2,
      maxEvidenceRefs: 1,
      maxBlockers: 1,
      maxTextChars: 32,
    })

    expect(projection.block).toContain('Goal: xxxxxxxxxxxxxxxxxx...[truncated]')
    expect(projection.block).toContain('- omittedSteps: 2')
    expect(projection.block).toContain('- omittedEvidenceRefs: 2')
    expect(projection.block).toContain('- omittedBlockers: 1')
    expect(projection.block).toContain('first blockerfirst...[truncated]')
    expect(projection.metadata).toMatchObject({
      status: 'blocked',
      projectedStepCount: 2,
      omittedStepCount: 2,
      projectedEvidenceRefCount: 1,
      omittedEvidenceRefCount: 2,
      projectedBlockerCount: 1,
      omittedBlockerCount: 1,
    })
  })

  it('keeps text bounds even when the text limit is smaller than the truncation suffix', () => {
    const projection = projectPlanStateForPrompt(plan, state, {
      maxTextChars: 5,
    })

    for (const line of projection.block.split('\n')) {
      if (line.startsWith('Goal: '))
        expect(line.slice('Goal: '.length).length).toBeLessThanOrEqual(5)
    }
  })

  it('renders stale and superseded plan states without authority elevation', () => {
    const staleProjection = projectPlanStateForPrompt(plan, state, {
      status: 'stale',
      statusReason: 'desktop state changed after observation',
    })
    const supersededProjection = projectPlanStateForPrompt(plan, state, {
      status: 'superseded',
      supersededByPlanId: 'plan-v2',
    })

    expect(staleProjection.block).toContain('Projection status: stale')
    expect(staleProjection.block).toContain('Status reason: desktop state changed after observation')
    expect(staleProjection.metadata.maySatisfyVerificationGate).toBe(false)
    expect(supersededProjection.block).toContain('Projection status: superseded')
    expect(supersededProjection.block).toContain('Superseded by plan: plan-v2')
    expect(supersededProjection.metadata.maySatisfyMutationProof).toBe(false)
  })

  it('keeps tool evidence and verification gates above plan completion claims', () => {
    const { currentStepId: _currentStepId, ...stateWithoutCurrentStep } = state
    const completedByPlanState: PlanState = {
      ...stateWithoutCurrentStep,
      completedSteps: ['inspect', 'run-smoke', 'request-human'],
      skippedSteps: [],
    }
    const projection = projectPlanStateForPrompt(plan, completedByPlanState)

    expect(projection.block).toContain('run-smoke [terminal/completed/medium]')
    expect(projection.metadata.maySatisfyVerificationGate).toBe(false)
    expect(projection.metadata.maySatisfyMutationProof).toBe(false)
    expect(hasHigherPlanningAuthority('verification_gate_decision', 'plan_state_reconciler_decision')).toBe(true)
    expect(hasHigherPlanningAuthority('trusted_current_run_tool_evidence', 'plan_state_reconciler_decision')).toBe(true)
  })

  it('does not mutate plan or state inputs', () => {
    const planBefore = structuredClone(plan)
    const stateBefore = structuredClone(state)

    projectPlanStateForPrompt(plan, state)

    expect(plan).toEqual(planBefore)
    expect(state).toEqual(stateBefore)
  })

  it('does not produce workspace memory plast-mem archive or task-memory export shapes', () => {
    const projection = projectPlanStateForPrompt(plan, state)
    const metadata = projection.metadata as unknown as Record<string, unknown>

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
      expect(metadata).not.toHaveProperty(forbiddenKey)
    }

    expect(projection.block).not.toContain('Task memory runtime snapshot')
    expect(projection.block).not.toContain('historical_evidence_not_instructions')
    expect(projection.block).not.toContain('governed_workspace_memory_not_instructions')
    expect(projection.block).not.toContain('reviewed_coding_context_not_instruction_authority')
    expect(projection.block).not.toContain('Plast-Mem reviewed project context')
  })
})
