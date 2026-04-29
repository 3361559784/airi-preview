import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ExecuteAction } from '../server/action-executor'
import type { PlanExpectedEvidence, PlanSpec, PlanState } from './contract'

import { describe, expect, it, vi } from 'vitest'

import { createPopulatedRegistry } from '../server/tool-descriptors'
import { RunStateManager } from '../state'
import { routePlanSpec } from './lane-router'
import { executeMappedPlanWorkflow } from './workflow-execution'
import { buildPlanRouteWorkflowHandoff } from './workflow-handoff'
import { mapPlanHandoffToWorkflowDefinition } from './workflow-mapping'
import { reconcilePlanWorkflowExecution } from './workflow-reconciliation'

function successResult(text = 'ok'): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text = 'failed'): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

function plan(expectedEvidence: PlanExpectedEvidence[] = [{ source: 'tool_result', description: 'file read completed' }]): PlanSpec {
  return {
    goal: 'Read a file through mapped workflow.',
    steps: [
      {
        id: 'read-file',
        lane: 'coding',
        intent: 'Read the file.',
        allowedTools: ['coding_read_file'],
        expectedEvidence,
        riskLevel: 'low',
        approvalRequired: false,
      },
    ],
  }
}

function completedState(): PlanState {
  return {
    completedSteps: ['read-file'],
    failedSteps: [],
    skippedSteps: [],
    evidenceRefs: [],
    blockers: [],
  }
}

async function executePlanWorkflow(params: {
  plan: PlanSpec
  executeAction: ExecuteAction
}) {
  const routing = routePlanSpec({ plan: params.plan, descriptors: createPopulatedRegistry() })
  const handoff = buildPlanRouteWorkflowHandoff({ plan: params.plan, routing })
  const mapping = mapPlanHandoffToWorkflowDefinition({
    handoff,
    workflowId: 'workflow-reconciliation',
    name: 'Workflow Reconciliation',
    mappings: [
      {
        stepId: 'read-file',
        kind: 'coding_read_file',
        label: 'Custom read label',
        params: { filePath: 'src/index.ts' },
      },
    ],
  })
  const execution = await executeMappedPlanWorkflow({
    mapping,
    executeAction: params.executeAction,
    stateManager: new RunStateManager(),
  })

  return { mapping, execution }
}

describe('plan workflow reconciliation contract', () => {
  it('reconciles mapped workflow observations against explicit plan state', async () => {
    const spec = plan()
    const { mapping, execution } = await executePlanWorkflow({
      plan: spec,
      executeAction: vi.fn().mockResolvedValue(successResult('read ok')),
    })

    const result = reconcilePlanWorkflowExecution({
      plan: spec,
      state: completedState(),
      mapping,
      execution,
    })

    expect(result).toMatchObject({
      scope: 'current_run_plan_workflow_reconciliation',
      included: true,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.evidenceObservations).toEqual([
      expect.objectContaining({
        stepId: 'read-file',
        source: 'tool_result',
        status: 'satisfied',
        toolName: 'coding_read_file',
      }),
    ])
    expect(result.reconciliation?.decision).toEqual({
      decision: 'ready_for_final_verification',
      reason: 'All non-skipped plan steps have matched current-run evidence.',
    })
    expect(result.reconciliation?.maySatisfyVerificationGate).toBe(false)
    expect(result.reconciliation?.maySatisfyMutationProof).toBe(false)
    expect(result.transitionProposal).toMatchObject({
      scope: 'current_run_plan_state_transition_proposal',
      proposal: 'ready_for_final_verification',
      mayMutatePlanState: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
  })

  it('returns skipped reconciliation metadata when no plan state is supplied', async () => {
    const spec = plan()
    const { mapping, execution } = await executePlanWorkflow({
      plan: spec,
      executeAction: vi.fn().mockResolvedValue(successResult()),
    })

    const result = reconcilePlanWorkflowExecution({ plan: spec, mapping, execution })

    expect(result).toMatchObject({
      scope: 'current_run_plan_workflow_reconciliation',
      included: false,
      skippedReason: 'missing_plan_state',
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.evidenceObservations).toHaveLength(1)
    expect(result.reconciliation).toBeUndefined()
    expect(result.transitionProposal).toBeUndefined()
  })

  it('maps failed workflow evidence into a replan decision', async () => {
    const spec = plan()
    const { mapping, execution } = await executePlanWorkflow({
      plan: spec,
      executeAction: vi.fn().mockResolvedValue(errorResult('read failed')),
    })

    const result = reconcilePlanWorkflowExecution({
      plan: spec,
      state: completedState(),
      mapping,
      execution,
    })

    expect(result.evidenceObservations).toEqual([
      expect.objectContaining({
        stepId: 'read-file',
        source: 'tool_result',
        status: 'failed',
        reasonCode: 'workflow_step_failure',
      }),
    ])
    expect(result.reconciliation?.decision).toEqual({
      decision: 'replan',
      reason: 'Plan evidence failed for step: read-file',
      stepId: 'read-file',
    })
    expect(result.transitionProposal).toMatchObject({
      proposal: 'mark_failed',
      stepId: 'read-file',
      mayMutatePlanState: false,
    })
  })

  it('does not manufacture verification gate evidence from workflow results', async () => {
    const spec = plan([{ source: 'verification_gate', description: 'verification passed' }])
    const { mapping, execution } = await executePlanWorkflow({
      plan: spec,
      executeAction: vi.fn().mockResolvedValue(successResult()),
    })

    const result = reconcilePlanWorkflowExecution({
      plan: spec,
      state: completedState(),
      mapping,
      execution,
    })

    expect(result.evidenceObservations.map(observation => observation.source)).toEqual(['tool_result'])
    expect(result.reconciliation?.decision).toEqual({
      decision: 'continue',
      reason: 'Completed plan step still lacks expected evidence: read-file',
      stepId: 'read-file',
    })
  })

  it('skips reconciliation when workflow execution did not run', async () => {
    const spec = plan()
    const routing = routePlanSpec({ plan: spec, descriptors: createPopulatedRegistry() })
    const handoff = buildPlanRouteWorkflowHandoff({ plan: spec, routing })
    const mapping = mapPlanHandoffToWorkflowDefinition({
      handoff,
      workflowId: 'blocked',
      name: 'Blocked',
      mappings: [],
    })
    const execution = await executeMappedPlanWorkflow({
      mapping,
      executeAction: vi.fn(),
      stateManager: new RunStateManager(),
    })

    const result = reconcilePlanWorkflowExecution({
      plan: spec,
      state: completedState(),
      mapping,
      execution,
    })

    expect(result).toMatchObject({
      included: false,
      skippedReason: 'workflow_execution_not_available',
      evidenceObservations: [],
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.reconciliation).toBeUndefined()
    expect(result.transitionProposal).toBeUndefined()
  })
})
