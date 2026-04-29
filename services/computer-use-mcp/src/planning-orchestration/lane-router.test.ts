import type { PlanSpecStep } from './contract'

import { describe, expect, it } from 'vitest'

import { createPopulatedRegistry } from '../server/tool-descriptors'
import { routePlanSpec, routePlanStep } from './lane-router'

describe('plan lane router contract', () => {
  const descriptors = createPopulatedRegistry()

  function step(overrides: Partial<PlanSpecStep>): PlanSpecStep {
    return {
      id: 'step-1',
      lane: 'coding',
      intent: 'Route a plan step.',
      allowedTools: ['coding_read_file'],
      expectedEvidence: [{ source: 'tool_result', description: 'tool result' }],
      riskLevel: 'low',
      approvalRequired: false,
      ...overrides,
    }
  }

  it('routes coding tools as current-run classification without execution authority', () => {
    const route = routePlanStep({
      step: step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file', 'coding_search_text'] }),
      descriptors,
    })

    expect(route).toMatchObject({
      scope: 'current_run_plan_lane_routing',
      stepId: 'inspect',
      lane: 'coding',
      status: 'routable',
      requestedToolNames: ['coding_read_file', 'coding_search_text'],
      routedToolNames: ['coding_read_file', 'coding_search_text'],
      approvalRequired: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(route.blockedReasons).toEqual([])
  })

  it('allows explicit coding workflow tools for the coding plan lane', () => {
    const route = routePlanStep({
      step: step({ id: 'runner', lane: 'coding', allowedTools: ['workflow_coding_runner'] }),
      descriptors,
    })

    expect(route.status).toBe('routable')
    expect(route.routedTools).toEqual([
      expect.objectContaining({
        canonicalName: 'workflow_coding_runner',
        lane: 'workflow',
      }),
    ])
  })

  it('routes desktop display and accessibility tools through the desktop plan lane', () => {
    const route = routePlanStep({
      step: step({
        id: 'observe-desktop',
        lane: 'desktop',
        allowedTools: ['desktop_get_state', 'display_enumerate', 'accessibility_snapshot'],
      }),
      descriptors,
    })

    expect(route.status).toBe('routable')
    expect(route.routedToolNames).toEqual(['desktop_get_state', 'display_enumerate', 'accessibility_snapshot'])
    expect(route.routedTools.map(tool => tool.lane)).toEqual(['desktop', 'display', 'accessibility'])
  })

  it('routes browser DOM tools only through the browser_dom plan lane', () => {
    const route = routePlanStep({
      step: step({ id: 'read-dom', lane: 'browser_dom', allowedTools: ['browser_dom_read_page'] }),
      descriptors,
    })

    expect(route.status).toBe('routable')
    expect(route.routedTools).toEqual([
      expect.objectContaining({
        canonicalName: 'browser_dom_read_page',
        lane: 'browser_dom',
      }),
    ])
  })

  it('routes PTY tools and legacy terminal_exec through the terminal plan lane', () => {
    const ptyRoute = routePlanStep({
      step: step({ id: 'read-terminal', lane: 'terminal', allowedTools: ['pty_read_screen'] }),
      descriptors,
    })
    const execRoute = routePlanStep({
      step: step({ id: 'run-command', lane: 'terminal', allowedTools: ['terminal_exec'] }),
      descriptors,
    })

    expect(ptyRoute.status).toBe('routable')
    expect(ptyRoute.routedTools).toEqual([
      expect.objectContaining({
        canonicalName: 'pty_read_screen',
        lane: 'pty',
      }),
    ])
    expect(execRoute.status).toBe('requires_approval')
    expect(execRoute.approvalReasons).toEqual(['tool_requires_approval', 'destructive_tool'])
    expect(execRoute.routedTools).toEqual([
      expect.objectContaining({
        canonicalName: 'terminal_exec',
        lane: 'desktop',
      }),
    ])
  })

  it('treats human lane as approval-required and tool-free', () => {
    const route = routePlanStep({
      step: step({ id: 'human-approval', lane: 'human', allowedTools: [], approvalRequired: false }),
      descriptors,
    })

    expect(route).toMatchObject({
      status: 'requires_approval',
      approvalRequired: true,
      approvalReasons: ['human_lane_requires_approval'],
      routedToolNames: [],
      blockedReasons: [],
    })
  })

  it('requires approval for explicit approval high risk destructive and approval-default tools', () => {
    const patchRoute = routePlanStep({
      step: step({ id: 'patch', lane: 'coding', allowedTools: ['coding_apply_patch'] }),
      descriptors,
    })
    const highRiskRoute = routePlanStep({
      step: step({ id: 'high-risk', riskLevel: 'high' }),
      descriptors,
    })
    const explicitApprovalRoute = routePlanStep({
      step: step({ id: 'explicit', approvalRequired: true }),
      descriptors,
    })

    expect(patchRoute.status).toBe('requires_approval')
    expect(patchRoute.approvalReasons).toEqual(['tool_requires_approval', 'destructive_tool'])
    expect(highRiskRoute.status).toBe('requires_approval')
    expect(highRiskRoute.approvalReasons).toEqual(['high_risk_step'])
    expect(explicitApprovalRoute.status).toBe('requires_approval')
    expect(explicitApprovalRoute.approvalReasons).toEqual(['step_requires_approval'])
  })

  it('blocks unknown non-public cross-lane empty and human-tool routes', () => {
    const unknownRoute = routePlanStep({
      step: step({ id: 'unknown', allowedTools: ['missing_tool'] }),
      descriptors,
    })
    const nonPublicRoute = routePlanStep({
      step: step({ id: 'internal', lane: 'desktop', allowedTools: ['desktop_open_test_target'] }),
      descriptors,
    })
    const crossLaneRoute = routePlanStep({
      step: step({ id: 'cross', lane: 'browser_dom', allowedTools: ['coding_read_file'] }),
      descriptors,
    })
    const emptyToolsRoute = routePlanStep({
      step: step({ id: 'empty', lane: 'coding', allowedTools: [] }),
      descriptors,
    })
    const humanToolRoute = routePlanStep({
      step: step({ id: 'human-with-tool', lane: 'human', allowedTools: ['coding_read_file'] }),
      descriptors,
    })

    expect(unknownRoute.status).toBe('blocked')
    expect(unknownRoute.blockedReasons).toEqual([expect.objectContaining({ reason: 'unknown_tool', toolName: 'missing_tool' })])
    expect(nonPublicRoute.status).toBe('blocked')
    expect(nonPublicRoute.blockedReasons).toEqual([expect.objectContaining({ reason: 'non_public_tool', toolName: 'desktop_open_test_target' })])
    expect(crossLaneRoute.status).toBe('blocked')
    expect(crossLaneRoute.blockedReasons).toEqual([expect.objectContaining({ reason: 'cross_lane_tool', toolName: 'coding_read_file' })])
    expect(emptyToolsRoute.status).toBe('blocked')
    expect(emptyToolsRoute.blockedReasons).toEqual([expect.objectContaining({ reason: 'empty_allowed_tools' })])
    expect(humanToolRoute.status).toBe('blocked')
    expect(humanToolRoute.blockedReasons).toEqual([expect.objectContaining({ reason: 'human_lane_disallows_tools', toolName: 'coding_read_file' })])
  })

  it('summarizes a plan without creating runtime execution or proof authority', () => {
    const result = routePlanSpec({
      plan: {
        goal: 'Coordinate a current-run repair.',
        steps: [
          step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
          step({ id: 'mutate', lane: 'coding', allowedTools: ['coding_apply_patch'] }),
          step({ id: 'bad', lane: 'browser_dom', allowedTools: ['coding_read_file'] }),
        ],
      },
      descriptors,
    })

    expect(result.scope).toBe('current_run_plan_lane_routing')
    expect(result.blockedStepIds).toEqual(['bad'])
    expect(result.approvalRequiredStepIds).toEqual(['mutate'])
    expect(result.mayExecute).toBe(false)
    expect(result.maySatisfyVerificationGate).toBe(false)
    expect(result.maySatisfyMutationProof).toBe(false)
    expect(result.routes.map(route => route.status)).toEqual(['routable', 'requires_approval', 'blocked'])
  })
})
