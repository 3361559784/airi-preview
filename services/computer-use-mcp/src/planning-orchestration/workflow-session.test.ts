import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ExecuteAction } from '../server/action-executor'
import type { PlanSpec, PlanState } from './contract'

import { describe, expect, it, vi } from 'vitest'

import { createPopulatedRegistry } from '../server/tool-descriptors'
import { RunStateManager } from '../state'
import { routePlanSpec } from './lane-router'
import { createPlanHostRuntimeSession } from './runtime-session'
import { buildPlanRouteWorkflowHandoff } from './workflow-handoff'
import { mapPlanHandoffToWorkflowDefinition } from './workflow-mapping'
import { executeMappedPlanWorkflowForHostSession } from './workflow-session'

function successResult(text = 'ok'): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function plan(): PlanSpec {
  return {
    goal: 'Read source and observe desktop.',
    steps: [
      {
        id: 'read-source',
        lane: 'coding',
        intent: 'Read source file.',
        allowedTools: ['coding_read_file'],
        expectedEvidence: [{ source: 'tool_result', description: 'source file read' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
      {
        id: 'observe-desktop',
        lane: 'desktop',
        intent: 'Observe desktop windows.',
        allowedTools: ['desktop_observe_windows'],
        expectedEvidence: [{ source: 'tool_result', description: 'desktop windows observed' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
    ],
  }
}

function state(overrides: Partial<PlanState> = {}): PlanState {
  return {
    currentStepId: 'read-source',
    completedSteps: [],
    failedSteps: [],
    skippedSteps: [],
    evidenceRefs: [],
    blockers: [],
    ...overrides,
  }
}

function mappedWorkflow(spec = plan()) {
  const routing = routePlanSpec({ plan: spec, descriptors: createPopulatedRegistry() })
  const handoff = buildPlanRouteWorkflowHandoff({ plan: spec, routing })
  return mapPlanHandoffToWorkflowDefinition({
    handoff,
    workflowId: 'host-session-workflow',
    name: 'Host Session Workflow',
    mappings: [
      {
        stepId: 'read-source',
        kind: 'coding_read_file',
        label: 'Read source',
        params: { filePath: 'src/index.ts' },
      },
      {
        stepId: 'observe-desktop',
        kind: 'observe_windows',
        label: 'Observe desktop',
        params: { limit: 3 },
      },
    ],
  })
}

function acceptDecision() {
  return {
    decision: 'accept_transition' as const,
    actor: 'host-orchestrator',
    rationale: 'Workflow evidence satisfied active step.',
  }
}

describe('host session mapped workflow run boundary', () => {
  it('executes a mapped multi-lane workflow and applies reconciliation into the host session', async () => {
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue(successResult())
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: plan(),
      initialState: state(),
    })

    const result = await executeMappedPlanWorkflowForHostSession({
      session,
      mapping: mappedWorkflow(),
      hostDecision: acceptDecision(),
      executeAction,
      stateManager: new RunStateManager(),
    })

    expect(result).toMatchObject({
      scope: 'current_run_plan_host_session_workflow_run',
      status: 'applied',
      execution: {
        scope: 'current_run_plan_workflow_execution',
        status: 'completed',
        executed: true,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
      reconciliation: {
        scope: 'current_run_plan_workflow_reconciliation',
        included: true,
        transitionProposal: {
          proposal: 'advance_step',
          stepId: 'read-source',
          nextStepId: 'observe-desktop',
          mayExecute: false,
          maySatisfyVerificationGate: false,
          maySatisfyMutationProof: false,
        },
      },
      transitionEvent: {
        scope: 'current_run_plan_host_runtime_session_event',
        sequence: 1,
        generation: 1,
        kind: 'transition',
        transitionRecord: {
          stateUpdated: true,
          nextState: {
            currentStepId: 'observe-desktop',
            completedSteps: ['read-source'],
          },
        },
      },
      beforeSessionSnapshot: {
        eventCount: 0,
        activeSnapshot: {
          state: {
            currentStepId: 'read-source',
            completedSteps: [],
          },
        },
      },
      afterSessionSnapshot: {
        eventCount: 1,
        activeSnapshot: {
          state: {
            currentStepId: 'observe-desktop',
            completedSteps: ['read-source'],
          },
        },
      },
      problems: [],
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(executeAction).toHaveBeenCalledTimes(2)
    expect(executeAction).toHaveBeenNthCalledWith(
      1,
      { kind: 'coding_read_file', input: { filePath: 'src/index.ts' } },
      'workflow_host-session-workflow_step_1',
      { skipApprovalQueue: false },
    )
    expect(executeAction).toHaveBeenNthCalledWith(
      2,
      { kind: 'observe_windows', input: { limit: 3, app: undefined } },
      'workflow_host-session-workflow_step_2',
      { skipApprovalQueue: false },
    )
    expect(session.getSnapshot()).toMatchObject({
      eventCount: 1,
      transitionCount: 1,
      activeSnapshot: {
        state: {
          currentStepId: 'observe-desktop',
          completedSteps: ['read-source'],
        },
      },
    })
  })

  it('does not mutate the host session when workflow execution is unavailable', async () => {
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue(successResult())
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: plan(),
      initialState: state(),
    })

    const result = await executeMappedPlanWorkflowForHostSession({
      session,
      mapping: {
        scope: 'current_run_plan_workflow_mapping',
        status: 'blocked',
        mappedSteps: [],
        problems: [{ reason: 'handoff_not_ready', detail: 'not ready' }],
        mayExecute: false,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
      hostDecision: acceptDecision(),
      executeAction,
      stateManager: new RunStateManager(),
    })

    expect(result).toMatchObject({
      status: 'skipped',
      execution: {
        status: 'blocked',
        executed: false,
      },
      reconciliation: {
        included: false,
        skippedReason: 'workflow_execution_not_available',
      },
      problems: [expect.objectContaining({ reason: 'reconciliation_not_included' })],
      beforeSessionSnapshot: { eventCount: 0 },
      afterSessionSnapshot: { eventCount: 0 },
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.transitionEvent).toBeUndefined()
    expect(executeAction).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({
      eventCount: 0,
      activeSnapshot: {
        state: state(),
      },
    })
  })

  it('records rejected host decisions without advancing active session state', async () => {
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue(successResult())
    const session = createPlanHostRuntimeSession({
      sessionId: 'session-1',
      plan: plan(),
      initialState: state(),
    })

    const result = await executeMappedPlanWorkflowForHostSession({
      session,
      mapping: mappedWorkflow(),
      hostDecision: {
        decision: 'reject_transition',
        actor: 'host-orchestrator',
        rationale: 'Reject auto advance.',
      },
      executeAction,
      stateManager: new RunStateManager(),
    })

    expect(result).toMatchObject({
      status: 'rejected',
      transitionEvent: {
        kind: 'transition',
        transitionRecord: {
          stateUpdated: false,
          transition: {
            status: 'rejected',
          },
          nextState: {
            currentStepId: 'read-source',
            completedSteps: [],
          },
        },
      },
      afterSessionSnapshot: {
        eventCount: 1,
        activeSnapshot: {
          state: {
            currentStepId: 'read-source',
            completedSteps: [],
          },
        },
      },
    })
    expect(session.getSnapshot()).toMatchObject({
      eventCount: 1,
      transitionCount: 1,
      activeSnapshot: {
        state: {
          currentStepId: 'read-source',
          completedSteps: [],
        },
      },
    })
  })
})
