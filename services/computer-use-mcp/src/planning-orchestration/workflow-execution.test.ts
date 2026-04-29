import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ExecuteAction } from '../server/action-executor'
import type { WorkflowDefinition } from '../workflows'
import type { PlanWorkflowMappingResult } from './workflow-mapping'

import { describe, expect, it, vi } from 'vitest'

import { RunStateManager } from '../state'
import { executeMappedPlanWorkflow } from './workflow-execution'

function successResult(text = 'ok'): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function mapping(workflow: WorkflowDefinition): PlanWorkflowMappingResult {
  return {
    scope: 'current_run_plan_workflow_mapping',
    status: 'mapped',
    workflow,
    mappedSteps: workflow.steps.map((step, index) => ({
      stepId: step.label,
      workflowStepIndex: index,
      workflowStepLabel: step.label,
      workflowStepKind: step.kind,
    })),
    problems: [],
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

describe('mapped plan workflow execution boundary', () => {
  it('executes a mapped workflow through the existing workflow engine across lanes', async () => {
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue(successResult())
    const stateManager = new RunStateManager()

    const result = await executeMappedPlanWorkflow({
      mapping: mapping({
        id: 'mapped_cross_lane',
        name: 'Mapped Cross Lane Workflow',
        description: 'Exercises coding, desktop, and terminal workflow steps.',
        maxRetries: 3,
        steps: [
          {
            label: 'Read source',
            kind: 'coding_read_file',
            description: 'Read source file.',
            params: { filePath: 'src/index.ts' },
          },
          {
            label: 'Observe windows',
            kind: 'observe_windows',
            description: 'Inspect desktop windows.',
            params: { limit: 3 },
          },
          {
            label: 'Run validation',
            kind: 'run_command',
            description: 'Run validation command.',
            params: { command: 'pnpm test', cwd: '/workspace' },
            terminal: { mode: 'exec', interaction: 'one_shot' },
          },
        ],
      }),
      executeAction,
      stateManager,
    })

    expect(result).toMatchObject({
      scope: 'current_run_plan_workflow_execution',
      status: 'completed',
      executed: true,
      problems: [],
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(result.workflowResult?.success).toBe(true)
    expect(executeAction).toHaveBeenCalledTimes(3)
    expect(executeAction).toHaveBeenNthCalledWith(
      1,
      { kind: 'coding_read_file', input: { filePath: 'src/index.ts' } },
      'workflow_mapped_cross_lane_step_1',
      { skipApprovalQueue: false },
    )
    expect(executeAction).toHaveBeenNthCalledWith(
      2,
      { kind: 'observe_windows', input: { limit: 3, app: undefined } },
      'workflow_mapped_cross_lane_step_2',
      { skipApprovalQueue: false },
    )
    expect(executeAction).toHaveBeenNthCalledWith(
      3,
      { kind: 'terminal_exec', input: { command: 'pnpm test', cwd: '/workspace', timeoutMs: undefined } },
      'workflow_mapped_cross_lane_step_3',
      { skipApprovalQueue: false },
    )
  })

  it('does not execute blocked or missing workflow mappings', async () => {
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue(successResult())

    const blocked = await executeMappedPlanWorkflow({
      mapping: {
        scope: 'current_run_plan_workflow_mapping',
        status: 'blocked',
        mappedSteps: [],
        problems: [{ reason: 'handoff_not_ready', detail: 'not ready' }],
        mayExecute: false,
        maySatisfyVerificationGate: false,
        maySatisfyMutationProof: false,
      },
      executeAction,
      stateManager: new RunStateManager(),
    })

    expect(blocked).toMatchObject({
      scope: 'current_run_plan_workflow_execution',
      status: 'blocked',
      executed: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    })
    expect(blocked.workflowResult).toBeUndefined()
    expect(blocked.problems).toEqual([
      expect.objectContaining({ reason: 'mapping_not_mapped' }),
      expect.objectContaining({ reason: 'missing_workflow' }),
    ])
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('does not turn an empty mapped workflow into completion proof', async () => {
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue(successResult())

    const result = await executeMappedPlanWorkflow({
      mapping: mapping({
        id: 'empty',
        name: 'Empty',
        description: 'No-op workflow.',
        maxRetries: 3,
        steps: [],
      }),
      executeAction,
      stateManager: new RunStateManager(),
    })

    expect(result.status).toBe('blocked')
    expect(result.executed).toBe(false)
    expect(result.problems).toEqual([
      expect.objectContaining({ reason: 'empty_workflow' }),
    ])
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('returns paused workflow result without auto-approving by default', async () => {
    const executeAction: ExecuteAction = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'approval required' }],
      structuredContent: { status: 'approval_required' } as unknown as CallToolResult['structuredContent'],
    })

    const result = await executeMappedPlanWorkflow({
      mapping: mapping({
        id: 'approval',
        name: 'Approval',
        description: 'Approval path.',
        maxRetries: 3,
        steps: [
          {
            label: 'Run command',
            kind: 'run_command',
            description: 'Needs approval.',
            params: { command: 'pnpm test', cwd: '/workspace' },
            terminal: { mode: 'exec', interaction: 'one_shot' },
          },
        ],
      }),
      executeAction,
      stateManager: new RunStateManager(),
    })

    expect(result.status).toBe('paused')
    expect(result.executed).toBe(true)
    expect(result.workflowResult?.suspension).toBeDefined()
    expect(executeAction).toHaveBeenCalledWith(
      { kind: 'terminal_exec', input: { command: 'pnpm test', cwd: '/workspace', timeoutMs: undefined } },
      'workflow_approval_step_1',
      { skipApprovalQueue: false },
    )
  })
})
