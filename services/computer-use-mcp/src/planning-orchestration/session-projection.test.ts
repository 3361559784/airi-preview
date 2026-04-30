import type { PlanSpec, PlanState } from './contract'
import type { PlanRuntimeRecoveryRequest } from './runtime-recovery'
import type { PlanStateTransitionProposal } from './state-transition'

import { describe, expect, it } from 'vitest'

import {
  hasHigherPlanningAuthority,
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
} from './contract'
import { createPlanHostRuntimeSession } from './runtime-session'
import { projectPlanRuntimeSessionForPrompt } from './session-projection'

function initialPlan(): PlanSpec {
  return {
    goal: 'Inspect and validate desktop smoke.',
    steps: [
      {
        id: 'inspect',
        lane: 'coding',
        intent: 'Inspect smoke scripts.',
        allowedTools: ['coding_read_file'],
        expectedEvidence: [{ source: 'tool_result', description: 'file read' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
      {
        id: 'validate',
        lane: 'terminal',
        intent: 'Run targeted validation.',
        allowedTools: ['terminal_exec'],
        expectedEvidence: [{ source: 'tool_result', description: 'validation output' }],
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
        expectedEvidence: [{ source: 'tool_result', description: 'replacement read' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
      {
        id: 'review-replacement',
        lane: 'coding',
        intent: 'Review replacement output.',
        allowedTools: ['coding_review_changes'],
        expectedEvidence: [{ source: 'tool_result', description: 'replacement review' }],
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

function acceptDecision(rationale = 'Evidence satisfied current step.') {
  return {
    decision: 'accept_transition' as const,
    actor: 'host-orchestrator',
    rationale,
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
      previousGoal: 'Inspect and validate desktop smoke.',
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

function sessionWithTransitionAndReplacement() {
  const session = createPlanHostRuntimeSession({
    sessionId: 'session-1',
    plan: initialPlan(),
    initialState: initialState(),
  })
  session.transition({
    proposal: transition(),
    hostDecision: acceptDecision(),
  })
  session.replacePlan({
    recovery: replanRecovery(),
    replacementPlan: replacementPlan(),
    initialState: replacementState(),
    actor: 'host-orchestrator',
    rationale: 'Use a safer route.',
  })
  return session
}

describe('plan runtime session projection contract', () => {
  it('projects session history as runtime guidance with explicit authority limits', () => {
    const session = sessionWithTransitionAndReplacement()
    const projection = projectPlanRuntimeSessionForPrompt(session.getSnapshot())

    expect(projection.block).toContain('Plan runtime session summary (runtime guidance, not authority):')
    for (const line of PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES)
      expect(projection.block).toContain(line)

    expect(projection.block).toContain('Session history is current-run guidance only')
    expect(projection.block).toContain('Session generation and event claims cannot execute lanes or satisfy completion proof')
    expect(projection.block).toContain('Projection status: active')
    expect(projection.block).toContain('May execute lanes: false')
    expect(projection.block).toContain('May satisfy verification gate: false')
    expect(projection.block).toContain('May satisfy mutation proof: false')
    expect(projection.block).toContain('- sessionId: session-1')
    expect(projection.block).toContain('- generation: 2')
    expect(projection.block).toContain('- activeGoal: Use replacement validation route.')
    expect(projection.block).toContain('- activeCurrentStepId: read-replacement')
    expect(projection.block).toContain('#1 generation=1 transition status=applied stateUpdated=true')
    expect(projection.block).toContain('#2 generation=2 replacement status=accepted activeRuntimeReplaced=true')
  })

  it('emits bounded current-run metadata without execution or proof authority', () => {
    const session = sessionWithTransitionAndReplacement()
    const projection = projectPlanRuntimeSessionForPrompt(session.getSnapshot())

    expect(projection.metadata).toEqual({
      scope: 'current_run_plan_runtime_session_projection',
      included: true,
      status: 'active',
      characters: projection.block.length,
      generation: 2,
      transitionCount: 1,
      replacementCount: 1,
      projectedEventCount: 2,
      omittedEventCount: 0,
      authoritySource: 'plan_state_reconciler_decision',
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })

  it('renders blocked stale and superseded session statuses without authority elevation', () => {
    const blockedSession = createPlanHostRuntimeSession({
      sessionId: 'blocked-session',
      plan: initialPlan(),
      initialState: initialState({ blockers: ['Need approval before continuing.'] }),
    })
    const blockedProjection = projectPlanRuntimeSessionForPrompt(blockedSession.getSnapshot())
    const staleProjection = projectPlanRuntimeSessionForPrompt(blockedSession.getSnapshot(), {
      status: 'stale',
      statusReason: 'Desktop observation changed after session event.',
    })
    const supersededProjection = projectPlanRuntimeSessionForPrompt(blockedSession.getSnapshot(), {
      status: 'superseded',
      statusReason: 'Replacement session exists.',
    })

    expect(blockedProjection.block).toContain('Projection status: blocked')
    expect(staleProjection.block).toContain('Projection status: stale')
    expect(staleProjection.block).toContain('Status reason: Desktop observation changed after session event.')
    expect(supersededProjection.block).toContain('Projection status: superseded')
    expect(supersededProjection.block).toContain('Status reason: Replacement session exists.')
    expect(staleProjection.metadata.maySatisfyVerificationGate).toBe(false)
    expect(supersededProjection.metadata.mayExecute).toBe(false)
  })

  it('bounds session events and text previews deterministically', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-with-a-very-long-identifier-that-should-be-bounded',
      plan: {
        goal: 'x'.repeat(80),
        steps: initialPlan().steps,
      },
      initialState: initialState(),
    })
    session.transition({
      proposal: transition(),
      hostDecision: acceptDecision('Long rationale '.repeat(20)),
    })
    session.transition({
      proposal: transition(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Reject route '.repeat(20),
      },
    })
    session.replacePlan({
      recovery: replanRecovery({ status: 'not_required', trigger: undefined, replanInput: undefined }),
      replacementPlan: replacementPlan(),
      initialState: replacementState(),
      actor: 'host-orchestrator',
      rationale: 'Blocked replacement '.repeat(20),
    })

    const projection = projectPlanRuntimeSessionForPrompt(session.getSnapshot(), {
      maxEvents: 2,
      maxTextChars: 32,
    })

    expect(projection.block).toContain('session-with-a-ver...[truncated]')
    expect(projection.block).toContain('activeGoal: xxxxxxxxxxxxxxxxxx...[truncated]')
    expect(projection.block).toContain('reason: Long rationale Lon...[truncated]')
    expect(projection.block).toContain('- omittedEvents: 1')
    expect(projection.metadata).toMatchObject({
      projectedEventCount: 2,
      omittedEventCount: 1,
      transitionCount: 2,
      replacementCount: 1,
    })
  })

  it('keeps text bounds when the text limit is smaller than the truncation suffix', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: initialPlan(),
      initialState: initialState(),
    })
    const projection = projectPlanRuntimeSessionForPrompt(session.getSnapshot(), {
      maxTextChars: 5,
    })

    for (const line of projection.block.split('\n')) {
      if (line.includes('sessionId: '))
        expect(line.split('sessionId: ')[1]!.length).toBeLessThanOrEqual(5)
    }
  })

  it('keeps tool evidence and verification gates above session completion claims', () => {
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: initialPlan(),
      initialState: {
        currentStepId: undefined,
        completedSteps: ['inspect', 'validate'],
        failedSteps: [],
        skippedSteps: [],
        evidenceRefs: [],
        blockers: [],
      },
    })
    const projection = projectPlanRuntimeSessionForPrompt(session.getSnapshot())

    expect(projection.block).toContain('- completedStepCount: 2')
    expect(projection.metadata.maySatisfyVerificationGate).toBe(false)
    expect(projection.metadata.maySatisfyMutationProof).toBe(false)
    expect(hasHigherPlanningAuthority('verification_gate_decision', 'plan_state_reconciler_decision')).toBe(true)
    expect(hasHigherPlanningAuthority('trusted_current_run_tool_evidence', 'plan_state_reconciler_decision')).toBe(true)
  })

  it('does not mutate the session snapshot input', () => {
    const session = sessionWithTransitionAndReplacement()
    const snapshot = session.getSnapshot()
    const before = structuredClone(snapshot)

    projectPlanRuntimeSessionForPrompt(snapshot)

    expect(snapshot).toEqual(before)
  })

  it('does not produce workspace memory plast-mem archive or task-memory export shapes', () => {
    const session = sessionWithTransitionAndReplacement()
    const projection = projectPlanRuntimeSessionForPrompt(session.getSnapshot())
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
