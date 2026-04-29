import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ExecuteAction } from '../server/action-executor'
import type { PlanSpec, PlanState } from './contract'

import { describe, expect, it, vi } from 'vitest'

import { createPopulatedRegistry } from '../server/tool-descriptors'
import { RunStateManager } from '../state'
import { routePlanSpec } from './lane-router'
import { reconcilePlanEvidence } from './reconciliation'
import { buildPlanEvidenceObservationsFromWorkflowExecution } from './workflow-evidence'
import { executeMappedPlanWorkflow } from './workflow-execution'
import { buildPlanRouteWorkflowHandoff } from './workflow-handoff'
import { mapPlanHandoffToWorkflowDefinition } from './workflow-mapping'

function successResult(text = 'ok'): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text = 'failed'): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

function planWithExpectedEvidence(source: 'tool_result' | 'verification_gate' = 'tool_result'): PlanSpec {
  return {
    goal: 'Inspect a file through a mapped plan workflow.',
    steps: [
      {
        id: 'inspect-source',
        lane: 'coding',
        intent: 'Read the target source file.',
        allowedTools: ['coding_read_file'],
        expectedEvidence: [{ source, description: 'Source file evidence observed.' }],
        riskLevel: 'low',
        approvalRequired: false,
      },
    ],
  }
}

function mapPlan(plan: PlanSpec) {
  const routing = routePlanSpec({ plan, descriptors: createPopulatedRegistry() })
  const handoff = buildPlanRouteWorkflowHandoff({ plan, routing })
  return mapPlanHandoffToWorkflowDefinition({
    handoff,
    workflowId: 'workflow-custom-label',
    name: 'Custom Label Workflow',
    mappings: [
      {
        stepId: 'inspect-source',
        kind: 'coding_read_file',
        label: 'Read source with a custom workflow label',
        params: { filePath: 'src/index.ts' },
      },
    ],
  })
}

describe('plan workflow evidence observation bridge', () => {
  it('maps workflow step results back to original plan step ids even when labels are custom', async () => {
    const plan = planWithExpectedEvidence()
    const mapping = mapPlan(plan)
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue(successResult('read ok'))

    const execution = await executeMappedPlanWorkflow({
      mapping,
      executeAction,
      stateManager: new RunStateManager(),
    })
    const observations = buildPlanEvidenceObservationsFromWorkflowExecution({ mapping, execution })

    expect(mapping.mappedSteps).toEqual([
      {
        stepId: 'inspect-source',
        workflowStepIndex: 0,
        workflowStepLabel: 'Read source with a custom workflow label',
        workflowStepKind: 'coding_read_file',
      },
    ])
    expect(observations).toEqual([
      expect.objectContaining({
        id: 'workflow:workflow-custom-label:step:1',
        stepId: 'inspect-source',
        source: 'tool_result',
        status: 'satisfied',
        toolName: 'coding_read_file',
        reasonCode: 'workflow_step_success',
      }),
    ])
    expect(observations[0]?.summary).toContain('planStep=inspect-source')
    expect(observations[0]?.summary).toContain('status=success')
  })

  it('maps failed workflow steps to failed tool-result observations', async () => {
    const plan = planWithExpectedEvidence()
    const mapping = mapPlan(plan)
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue(errorResult('read failed'))

    const execution = await executeMappedPlanWorkflow({
      mapping,
      executeAction,
      stateManager: new RunStateManager(),
    })
    const observations = buildPlanEvidenceObservationsFromWorkflowExecution({ mapping, execution })

    expect(observations).toEqual([
      expect.objectContaining({
        stepId: 'inspect-source',
        source: 'tool_result',
        status: 'failed',
        toolName: 'coding_read_file',
        reasonCode: 'workflow_step_failure',
      }),
    ])
  })

  it('returns no observations for blocked mappings or non-executed workflow results', async () => {
    const plan = planWithExpectedEvidence()
    const blockedMapping = mapPlanHandoffToWorkflowDefinition({
      handoff: buildPlanRouteWorkflowHandoff({
        plan,
        routing: routePlanSpec({ plan, descriptors: createPopulatedRegistry() }),
      }),
      workflowId: 'blocked',
      name: 'Blocked',
      mappings: [],
    })
    const execution = await executeMappedPlanWorkflow({
      mapping: blockedMapping,
      executeAction: vi.fn(),
      stateManager: new RunStateManager(),
    })

    expect(blockedMapping.status).toBe('blocked')
    expect(buildPlanEvidenceObservationsFromWorkflowExecution({
      mapping: blockedMapping,
      execution,
    })).toEqual([])
  })

  it('never manufactures verification-gate or human-approval evidence', async () => {
    const plan = planWithExpectedEvidence()
    const mapping = mapPlan(plan)
    const execution = await executeMappedPlanWorkflow({
      mapping,
      executeAction: vi.fn().mockResolvedValue(successResult()),
      stateManager: new RunStateManager(),
    })
    const observations = buildPlanEvidenceObservationsFromWorkflowExecution({ mapping, execution })

    expect(observations.map(observation => observation.source)).toEqual(['tool_result'])
    expect(observations.every(observation => observation.source !== 'verification_gate')).toBe(true)
    expect(observations.every(observation => observation.source !== 'human_approval')).toBe(true)
    expect(execution.maySatisfyVerificationGate).toBe(false)
    expect(execution.maySatisfyMutationProof).toBe(false)
  })

  it('turns missing workflow step results into failed observations for the mapped step', async () => {
    const plan = planWithExpectedEvidence()
    const mapping = mapPlan(plan)
    const execution = await executeMappedPlanWorkflow({
      mapping,
      executeAction: vi.fn().mockResolvedValue(successResult()),
      stateManager: new RunStateManager(),
    })
    const missingStepExecution = {
      ...execution,
      workflowResult: {
        ...execution.workflowResult!,
        stepResults: [],
      },
    }

    expect(buildPlanEvidenceObservationsFromWorkflowExecution({
      mapping,
      execution: missingStepExecution,
    })).toEqual([
      expect.objectContaining({
        stepId: 'inspect-source',
        source: 'tool_result',
        status: 'failed',
        toolName: 'coding_read_file',
        reasonCode: 'workflow_step_missing_result',
      }),
    ])
  })

  it('does not mutate mapping or execution inputs', async () => {
    const plan = planWithExpectedEvidence()
    const mapping = mapPlan(plan)
    const execution = await executeMappedPlanWorkflow({
      mapping,
      executeAction: vi.fn().mockResolvedValue(successResult()),
      stateManager: new RunStateManager(),
    })
    const mappingBefore = JSON.stringify(mapping)
    const executionBefore = JSON.stringify(execution)

    buildPlanEvidenceObservationsFromWorkflowExecution({ mapping, execution })

    expect(JSON.stringify(mapping)).toBe(mappingBefore)
    expect(JSON.stringify(execution)).toBe(executionBefore)
  })

  it('can feed reconciler readiness for tool-result-only plans but not verification-gate evidence', async () => {
    const plan = planWithExpectedEvidence()
    const state: PlanState = {
      completedSteps: ['inspect-source'],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
    }
    const mapping = mapPlan(plan)
    const execution = await executeMappedPlanWorkflow({
      mapping,
      executeAction: vi.fn().mockResolvedValue(successResult()),
      stateManager: new RunStateManager(),
    })
    const observations = buildPlanEvidenceObservationsFromWorkflowExecution({ mapping, execution })

    expect(reconcilePlanEvidence({ plan, state, observations }).decision.decision).toBe('ready_for_final_verification')

    const gatePlan = planWithExpectedEvidence('verification_gate')
    expect(reconcilePlanEvidence({ plan: gatePlan, state, observations }).decision).toEqual({
      decision: 'continue',
      reason: 'Completed plan step still lacks expected evidence: inspect-source',
      stepId: 'inspect-source',
    })
  })
})
