import type { PlanSpec, PlanSpecStep } from './contract'

import { describe, expect, it } from 'vitest'

import { createPopulatedRegistry } from '../server/tool-descriptors'
import { routePlanSpec } from './lane-router'
import { buildPlanRouteWorkflowHandoff } from './workflow-handoff'
import { mapPlanHandoffToWorkflowDefinition } from './workflow-mapping'

describe('plan handoff to workflow mapping contract', () => {
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

  function handoff(plan: PlanSpec) {
    return buildPlanRouteWorkflowHandoff({
      plan,
      routing: routePlanSpec({ plan, descriptors }),
    })
  }

  it('maps ready handoff steps to workflow templates only with explicit params', () => {
    const plan: PlanSpec = {
      goal: 'Inspect file and terminal state.',
      steps: [
        step({ id: 'read-file', lane: 'coding', allowedTools: ['coding_read_file'] }),
        step({ id: 'read-terminal', lane: 'terminal', allowedTools: ['pty_read_screen'] }),
      ],
    }

    const result = mapPlanHandoffToWorkflowDefinition({
      handoff: handoff(plan),
      workflowId: 'plan-workflow-1',
      name: 'Plan Workflow',
      description: 'Mapped from explicit plan handoff params.',
      maxRetries: 1,
      mappings: [
        {
          stepId: 'read-file',
          kind: 'coding_read_file',
          params: { path: 'src/index.ts' },
          label: 'Read target file',
        },
        {
          stepId: 'read-terminal',
          kind: 'pty_read_screen',
          params: { sessionId: 'terminal-1' },
          critical: true,
        },
      ],
    })

    expect(result).toMatchObject({
      scope: 'current_run_plan_workflow_mapping',
      status: 'mapped',
      problems: [],
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.workflow).toEqual({
      id: 'plan-workflow-1',
      name: 'Plan Workflow',
      description: 'Mapped from explicit plan handoff params.',
      maxRetries: 1,
      steps: [
        {
          label: 'Read target file',
          kind: 'coding_read_file',
          description: 'Mapped plan step read-file.',
          params: { path: 'src/index.ts' },
        },
        {
          label: 'read-terminal',
          kind: 'pty_read_screen',
          description: 'Mapped plan step read-terminal.',
          params: { sessionId: 'terminal-1' },
          critical: true,
        },
      ],
    })
  })

  it('blocks mapping when handoff still requires approval or has blocked steps', () => {
    const approvalPlan: PlanSpec = {
      goal: 'Run a command.',
      steps: [
        step({ id: 'run-command', lane: 'terminal', allowedTools: ['terminal_exec'] }),
      ],
    }
    const blockedPlan: PlanSpec = {
      goal: 'Bad route.',
      steps: [
        step({ id: 'bad', lane: 'browser_dom', allowedTools: ['coding_read_file'] }),
      ],
    }

    const approvalResult = mapPlanHandoffToWorkflowDefinition({
      handoff: handoff(approvalPlan),
      workflowId: 'approval',
      name: 'Approval',
      mappings: [
        { stepId: 'run-command', kind: 'run_command', params: { command: 'pnpm test', cwd: '/workspace' } },
      ],
    })
    const blockedResult = mapPlanHandoffToWorkflowDefinition({
      handoff: handoff(blockedPlan),
      workflowId: 'blocked',
      name: 'Blocked',
      mappings: [],
    })

    expect(approvalResult.status).toBe('blocked')
    expect(approvalResult.workflow).toBeUndefined()
    expect(approvalResult.problems).toEqual([
      expect.objectContaining({ reason: 'mapping_for_non_ready_step', stepId: 'run-command' }),
      expect.objectContaining({ reason: 'handoff_not_ready' }),
    ])
    expect(blockedResult.status).toBe('blocked')
    expect(blockedResult.workflow).toBeUndefined()
    expect(blockedResult.problems).toEqual([
      expect.objectContaining({ reason: 'handoff_not_ready' }),
    ])
  })

  it('blocks missing unknown duplicate and incompatible workflow mappings', () => {
    const plan: PlanSpec = {
      goal: 'Inspect and run validation.',
      steps: [
        step({ id: 'read-file', lane: 'coding', allowedTools: ['coding_read_file'] }),
        step({ id: 'run-command', lane: 'terminal', allowedTools: ['pty_read_screen'] }),
      ],
    }
    const readyHandoff = handoff(plan)

    expect(mapPlanHandoffToWorkflowDefinition({
      handoff: readyHandoff,
      workflowId: 'missing',
      name: 'Missing',
      mappings: [
        { stepId: 'read-file', kind: 'coding_read_file', params: { path: 'src/index.ts' } },
      ],
    }).problems).toEqual([
      expect.objectContaining({ reason: 'missing_mapping_for_ready_step', stepId: 'run-command' }),
    ])

    expect(mapPlanHandoffToWorkflowDefinition({
      handoff: readyHandoff,
      workflowId: 'unknown',
      name: 'Unknown',
      mappings: [
        { stepId: 'read-file', kind: 'coding_read_file', params: { path: 'src/index.ts' } },
        { stepId: 'run-command', kind: 'pty_read_screen', params: {} },
        { stepId: 'extra', kind: 'coding_read_file', params: { path: 'src/extra.ts' } },
      ],
    }).problems).toEqual([
      expect.objectContaining({ reason: 'mapping_for_unknown_step', stepId: 'extra' }),
    ])

    expect(mapPlanHandoffToWorkflowDefinition({
      handoff: readyHandoff,
      workflowId: 'duplicate',
      name: 'Duplicate',
      mappings: [
        { stepId: 'read-file', kind: 'coding_read_file', params: { path: 'src/index.ts' } },
        { stepId: 'read-file', kind: 'coding_read_file', params: { path: 'src/index.ts' } },
        { stepId: 'run-command', kind: 'pty_read_screen', params: {} },
      ],
    }).problems).toEqual([
      expect.objectContaining({ reason: 'duplicate_mapping_for_step', stepId: 'read-file' }),
    ])

    expect(mapPlanHandoffToWorkflowDefinition({
      handoff: readyHandoff,
      workflowId: 'incompatible',
      name: 'Incompatible',
      mappings: [
        { stepId: 'read-file', kind: 'run_command', params: { command: 'pwd' } },
        { stepId: 'run-command', kind: 'pty_read_screen', params: {} },
      ],
    }).problems).toEqual([
      expect.objectContaining({ reason: 'incompatible_workflow_step_kind', stepId: 'read-file' }),
    ])
  })

  it('does not execute workflows or infer params from plan intent', () => {
    const plan: PlanSpec = {
      goal: 'Inspect current code.',
      steps: [
        step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
      ],
    }
    const result = mapPlanHandoffToWorkflowDefinition({
      handoff: handoff(plan),
      workflowId: 'missing',
      name: 'Missing',
      mappings: [],
    })
    const record = result as unknown as Record<string, unknown>

    expect(result.status).toBe('blocked')
    expect(result.workflow).toBeUndefined()
    expect(result.problems).toEqual([
      expect.objectContaining({ reason: 'missing_mapping_for_ready_step', stepId: 'inspect' }),
    ])
    expect(record).not.toHaveProperty('executeAction')
    expect(record).not.toHaveProperty('executeWorkflow')
    expect(record).not.toHaveProperty('toolInput')
    expect(record).not.toHaveProperty('workspaceKey')
    expect(result.mayExecute).toBe(false)
    expect(result.maySatisfyVerificationGate).toBe(false)
    expect(result.maySatisfyMutationProof).toBe(false)
  })

  it('defaults mapped workflows to a positive retry budget for workflow engine compatibility', () => {
    const plan: PlanSpec = {
      goal: 'Inspect current code.',
      steps: [
        step({ id: 'inspect', lane: 'coding', allowedTools: ['coding_read_file'] }),
      ],
    }

    const result = mapPlanHandoffToWorkflowDefinition({
      handoff: handoff(plan),
      workflowId: 'default-retries',
      name: 'Default Retries',
      mappings: [
        { stepId: 'inspect', kind: 'coding_read_file', params: { filePath: 'src/index.ts' } },
      ],
    })

    expect(result.status).toBe('mapped')
    expect(result.workflow?.maxRetries).toBe(2)
  })
})
