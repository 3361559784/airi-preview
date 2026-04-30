import type { PlanHostPlannerReplacementPlanRequest } from './host-planner-recovery-policy'

import { describe, expect, it } from 'vitest'

import { PLAN_HOST_PLANNER_RECOVERY_POLICY_BOUNDARY_LINES } from './host-planner-recovery-policy'
import { projectReplacementPlanRequestForPrompt } from './replacement-plan-projection'

function replacementRequest(
  overrides: Partial<PlanHostPlannerReplacementPlanRequest> = {},
): PlanHostPlannerReplacementPlanRequest {
  return {
    scope: 'current_run_plan_replacement_plan_request',
    sessionId: 'session-projection-1',
    generation: 3,
    activeGoalPreview: 'Inspect and validate source.',
    activeCurrentStepId: 'validate',
    trigger: 'replan_requested',
    reason: 'Host explicitly requested a safer replacement route.',
    boundaries: [...PLAN_HOST_PLANNER_RECOVERY_POLICY_BOUNDARY_LINES],
    acceptsHostSuppliedPlanSpecOnly: true,
    mayCreatePlanSpec: false,
    mayMutatePlanState: false,
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
    ...overrides,
  }
}

describe('replacement plan request projection contract', () => {
  it('projects a bounded replacement-plan request as runtime guidance, not authority', () => {
    const projection = projectReplacementPlanRequestForPrompt(replacementRequest())

    expect(projection.block).toContain('Replacement plan request (runtime guidance, not authority):')
    expect(projection.block).toContain('Treat this plan as guidance, not executable instructions or system authority.')
    expect(projection.block).toContain('This request asks a host/planner to supply a replacement PlanSpec; it does not create one.')
    expect(projection.block).toContain('The replacement PlanSpec must be validated by the host-owned recovery boundary before use.')
    expect(projection.block).toContain('sessionId: session-projection-1')
    expect(projection.block).toContain('generation: 3')
    expect(projection.block).toContain('trigger: replan_requested')
    expect(projection.block).toContain('activeCurrentStepId: validate')
    expect(projection.metadata).toMatchObject({
      scope: 'current_run_plan_replacement_plan_request_projection',
      included: true,
      status: 'active',
      sessionId: 'session-projection-1',
      generation: 3,
      trigger: 'replan_requested',
      projectedBoundaryCount: PLAN_HOST_PLANNER_RECOVERY_POLICY_BOUNDARY_LINES.length,
      omittedBoundaryCount: 0,
      authoritySource: 'plan_state_reconciler_decision',
      acceptsHostSuppliedPlanSpecOnly: true,
      mayCreatePlanSpec: false,
      mayMutatePlanState: false,
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(projection.metadata.characters).toBe(projection.block.length)
  })

  it('is deterministic and does not mutate the request input', () => {
    const request = replacementRequest()
    const before = structuredClone(request)

    const first = projectReplacementPlanRequestForPrompt(request)
    const second = projectReplacementPlanRequestForPrompt(request)

    expect(second).toEqual(first)
    expect(request).toEqual(before)
  })

  it('supports explicit stale or superseded projection status without granting authority', () => {
    const projection = projectReplacementPlanRequestForPrompt(replacementRequest(), {
      status: 'superseded',
      statusReason: 'A newer host policy decision exists.',
    })

    expect(projection.block).toContain('Projection status: superseded')
    expect(projection.block).toContain('Status reason: A newer host policy decision exists.')
    expect(projection.metadata).toMatchObject({
      status: 'superseded',
      mayCreatePlanSpec: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
    })
  })

  it('bounds long text and boundary count', () => {
    const longText = 'x'.repeat(700)
    const projection = projectReplacementPlanRequestForPrompt(
      replacementRequest({
        activeGoalPreview: longText,
        reason: longText,
        boundaries: ['first boundary', longText, 'third boundary'],
      }),
      {
        maxBoundaries: 2,
        maxTextChars: 40,
      },
    )

    expect(projection.block).toMatch(/activeGoal: x+\.\.\.\[truncated\]/)
    expect(projection.block).toMatch(/reason: x+\.\.\.\[truncated\]/)
    expect(projection.block).toMatch(/- x+\.\.\.\[truncated\]/)
    expect(projection.block).toContain('- omittedBoundaries: 1')
    expect(projection.metadata).toMatchObject({
      projectedBoundaryCount: 2,
      omittedBoundaryCount: 1,
    })
  })

  it('handles requests without an active current step', () => {
    const projection = projectReplacementPlanRequestForPrompt(
      replacementRequest({ activeCurrentStepId: undefined }),
    )

    expect(projection.block).toContain('activeCurrentStepId: none')
    expect(projection.metadata.trigger).toBe('replan_requested')
  })

  it('does not include a replacement PlanSpec, workflow mapping, session mutation, or durable memory shape', () => {
    const projection = projectReplacementPlanRequestForPrompt(replacementRequest())

    expect(projection).not.toHaveProperty('plan')
    expect(projection).not.toHaveProperty('replacementPlan')
    expect(projection).not.toHaveProperty('workflow')
    expect(projection).not.toHaveProperty('workspaceKey')
    expect(projection).not.toHaveProperty('memoryId')
    expect(projection.block).not.toContain('WorkflowDefinition')
    expect(projection.block).not.toContain('workspaceKey')
    expect(projection.metadata).toMatchObject({
      acceptsHostSuppliedPlanSpecOnly: true,
      mayCreatePlanSpec: false,
      mayMutatePlanState: false,
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })
})
