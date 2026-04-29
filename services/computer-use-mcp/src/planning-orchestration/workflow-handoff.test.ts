import type { PlanSpec, PlanSpecStep } from './contract'

import { describe, expect, it } from 'vitest'

import { createPopulatedRegistry } from '../server/tool-descriptors'
import { routePlanSpec } from './lane-router'
import { buildPlanRouteWorkflowHandoff } from './workflow-handoff'

describe('plan route to workflow handoff contract', () => {
  const descriptors = createPopulatedRegistry()

  function step(overrides: Partial<PlanSpecStep>): PlanSpecStep {
    return {
      id: 'inspect',
      lane: 'coding',
      intent: 'Inspect files.',
      allowedTools: ['coding_read_file'],
      expectedEvidence: [{ source: 'tool_result', description: 'tool result' }],
      riskLevel: 'low',
      approvalRequired: false,
      ...overrides,
    }
  }

  function route(plan: PlanSpec) {
    return routePlanSpec({ plan, descriptors })
  }

  it('builds a ready-for-mapping handoff for routable routes without execution authority', () => {
    const plan: PlanSpec = {
      goal: 'Inspect current code.',
      steps: [
        step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
        step({ id: 'read-terminal', lane: 'terminal', allowedTools: ['pty_read_screen'] }),
      ],
    }

    const handoff = buildPlanRouteWorkflowHandoff({ plan, routing: route(plan) })

    expect(handoff).toMatchObject({
      scope: 'current_run_plan_route_workflow_handoff',
      status: 'ready_for_mapping',
      readyForMappingStepIds: ['inspect', 'read-terminal'],
      approvalRequiredStepIds: [],
      blockedStepIds: [],
      consistencyErrors: [],
      mayExecute: false,
      mayCreateWorkflowDefinition: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(handoff.steps).toEqual([
      expect.objectContaining({
        stepId: 'inspect',
        handoffStatus: 'ready_for_mapping',
        candidateToolNames: ['coding_read_file'],
        workflowMappingRequired: true,
        mayExecute: false,
      }),
      expect.objectContaining({
        stepId: 'read-terminal',
        handoffStatus: 'ready_for_mapping',
        candidateToolNames: ['pty_read_screen'],
        workflowMappingRequired: true,
        mayCreateWorkflowDefinition: false,
      }),
    ])
  })

  it('keeps approval-required routes out of ready mapping until policy handles them', () => {
    const plan: PlanSpec = {
      goal: 'Patch a file after review.',
      steps: [
        step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
        step({ id: 'patch', lane: 'coding', allowedTools: ['coding_apply_patch'] }),
        step({ id: 'human', lane: 'human', allowedTools: [] }),
      ],
    }

    const handoff = buildPlanRouteWorkflowHandoff({ plan, routing: route(plan) })

    expect(handoff.status).toBe('requires_approval')
    expect(handoff.readyForMappingStepIds).toEqual(['inspect'])
    expect(handoff.approvalRequiredStepIds).toEqual(['patch', 'human'])
    expect(handoff.blockedStepIds).toEqual([])
    expect(handoff.steps.find(candidate => candidate.stepId === 'patch')).toMatchObject({
      handoffStatus: 'requires_approval',
      approvalReasons: ['tool_requires_approval', 'destructive_tool'],
      candidateToolNames: ['coding_apply_patch'],
      mayExecute: false,
    })
    expect(handoff.steps.find(candidate => candidate.stepId === 'human')).toMatchObject({
      handoffStatus: 'requires_approval',
      approvalReasons: ['human_lane_requires_approval'],
      candidateToolNames: [],
    })
  })

  it('blocks workflow handoff when any route is blocked', () => {
    const plan: PlanSpec = {
      goal: 'Expose wrong-lane evidence.',
      steps: [
        step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
        step({ id: 'bad-dom', lane: 'browser_dom', allowedTools: ['coding_read_file'] }),
      ],
    }

    const handoff = buildPlanRouteWorkflowHandoff({ plan, routing: route(plan) })

    expect(handoff.status).toBe('blocked')
    expect(handoff.readyForMappingStepIds).toEqual(['inspect'])
    expect(handoff.blockedStepIds).toEqual(['bad-dom'])
    expect(handoff.steps.find(candidate => candidate.stepId === 'bad-dom')).toMatchObject({
      routeStatus: 'blocked',
      handoffStatus: 'blocked',
      blockedReasons: [expect.objectContaining({
        reason: 'cross_lane_tool',
        toolName: 'coding_read_file',
      })],
      mayExecute: false,
      mayCreateWorkflowDefinition: false,
    })
  })

  it('blocks handoff on missing extra or duplicate route consistency errors', () => {
    const plan: PlanSpec = {
      goal: 'Inspect current code.',
      steps: [
        step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
        step({ id: 'search', lane: 'coding', allowedTools: ['coding_search_text'] }),
      ],
    }
    const routing = route(plan)
    const missingRouteHandoff = buildPlanRouteWorkflowHandoff({
      plan,
      routing: {
        ...routing,
        routes: routing.routes.filter(candidate => candidate.stepId !== 'search'),
      },
    })
    const extraRouteHandoff = buildPlanRouteWorkflowHandoff({
      plan,
      routing: {
        ...routing,
        routes: [
          ...routing.routes,
          { ...routing.routes[0]!, stepId: 'extra' },
        ],
      },
    })
    const duplicateRouteHandoff = buildPlanRouteWorkflowHandoff({
      plan,
      routing: {
        ...routing,
        routes: [
          ...routing.routes,
          { ...routing.routes[0]! },
        ],
      },
    })

    expect(missingRouteHandoff.status).toBe('blocked')
    expect(missingRouteHandoff.consistencyErrors).toEqual([
      { reason: 'missing_route_for_plan_step', stepId: 'search' },
    ])
    expect(missingRouteHandoff.blockedStepIds).toEqual(['search'])

    expect(extraRouteHandoff.status).toBe('blocked')
    expect(extraRouteHandoff.consistencyErrors).toEqual([
      { reason: 'route_without_plan_step', stepId: 'extra' },
    ])
    expect(extraRouteHandoff.blockedStepIds).toEqual(['extra'])

    expect(duplicateRouteHandoff.status).toBe('blocked')
    expect(duplicateRouteHandoff.consistencyErrors).toEqual([
      { reason: 'duplicate_route_for_plan_step', stepId: 'inspect' },
    ])
    expect(duplicateRouteHandoff.blockedStepIds).toEqual(['inspect'])
  })

  it('does not produce workflow definitions action invocations memory or proof authority', () => {
    const plan: PlanSpec = {
      goal: 'Inspect current code.',
      steps: [
        step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
      ],
    }
    const handoff = buildPlanRouteWorkflowHandoff({ plan, routing: route(plan) })
    const record = handoff as unknown as Record<string, unknown>

    expect(record).not.toHaveProperty('workflow')
    expect(record).not.toHaveProperty('workflowDefinition')
    expect(record).not.toHaveProperty('action')
    expect(record).not.toHaveProperty('actionInvocation')
    expect(record).not.toHaveProperty('workspaceKey')
    expect(record).not.toHaveProperty('memoryId')
    expect(record).not.toHaveProperty('artifactId')
    expect(record).not.toHaveProperty('exportedAt')
    expect(handoff.steps[0]).not.toHaveProperty('params')
    expect(handoff.steps[0]).not.toHaveProperty('workflowStepTemplate')
    expect(handoff.steps[0]).not.toHaveProperty('toolInput')
    expect(handoff.mayExecute).toBe(false)
    expect(handoff.mayCreateWorkflowDefinition).toBe(false)
    expect(handoff.maySatisfyVerificationGate).toBe(false)
    expect(handoff.maySatisfyMutationProof).toBe(false)
  })

  it('does not mutate plan or routing inputs', () => {
    const plan: PlanSpec = {
      goal: 'Inspect current code.',
      steps: [
        step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
      ],
    }
    const routing = route(plan)
    const planBefore = structuredClone(plan)
    const routingBefore = structuredClone(routing)

    buildPlanRouteWorkflowHandoff({ plan, routing })

    expect(plan).toEqual(planBefore)
    expect(routing).toEqual(routingBefore)
  })
})
