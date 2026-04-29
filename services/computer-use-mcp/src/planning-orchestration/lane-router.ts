import type { ToolDescriptor, ToolLane } from '../server/tool-descriptors'
import type { PlanLane, PlanSpec, PlanSpecStep } from './contract'

export type PlanLaneRouteStatus = 'routable' | 'requires_approval' | 'blocked'

export type PlanLaneRouteBlockReason
  = | 'empty_allowed_tools'
    | 'unknown_tool'
    | 'non_public_tool'
    | 'cross_lane_tool'
    | 'human_lane_disallows_tools'

export type PlanLaneRouteApprovalReason
  = | 'human_lane_requires_approval'
    | 'step_requires_approval'
    | 'high_risk_step'
    | 'tool_requires_approval'
    | 'destructive_tool'

export interface PlanLaneDescriptorLookup {
  getOptional: (canonicalName: string) => ToolDescriptor | undefined
}

export interface PlanLaneRoutedTool {
  canonicalName: string
  lane: ToolLane
  kind: ToolDescriptor['kind']
  readOnly: boolean
  destructive: boolean
  concurrencySafe: boolean
  requiresApprovalByDefault: boolean
}

export interface PlanLaneRouteProblem {
  reason: PlanLaneRouteBlockReason
  toolName?: string
  detail: string
}

export interface PlanStepLaneRoute {
  scope: 'current_run_plan_lane_routing'
  stepId: string
  lane: PlanLane
  status: PlanLaneRouteStatus
  requestedToolNames: string[]
  routedToolNames: string[]
  routedTools: PlanLaneRoutedTool[]
  approvalRequired: boolean
  approvalReasons: PlanLaneRouteApprovalReason[]
  blockedReasons: PlanLaneRouteProblem[]
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanLaneRoutingResult {
  scope: 'current_run_plan_lane_routing'
  routes: PlanStepLaneRoute[]
  blockedStepIds: string[]
  approvalRequiredStepIds: string[]
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

const CODING_WORKFLOW_TOOL_NAMES = new Set([
  'workflow_coding_loop',
  'workflow_coding_agentic_loop',
  'workflow_coding_runner',
])

const LEGACY_TERMINAL_TOOL_NAMES = new Set([
  'terminal_exec',
  'terminal_reset_state',
])

/**
 * Classifies one plan step against registered tool descriptors.
 *
 * This is a planning contract only: it validates lane/tool compatibility and
 * approval pressure without invoking tools or selecting runtime surfaces.
 */
export function routePlanStep(params: {
  step: PlanSpecStep
  descriptors: PlanLaneDescriptorLookup
}): PlanStepLaneRoute {
  const requestedToolNames = [...params.step.allowedTools]
  const blockedReasons: PlanLaneRouteProblem[] = []
  const routedTools: PlanLaneRoutedTool[] = []

  if (params.step.lane === 'human') {
    if (requestedToolNames.length > 0) {
      for (const toolName of requestedToolNames) {
        blockedReasons.push({
          reason: 'human_lane_disallows_tools',
          toolName,
          detail: `Human plan lane cannot route tools: ${toolName}`,
        })
      }
    }

    return buildRoute({
      step: params.step,
      requestedToolNames,
      routedTools,
      blockedReasons,
      approvalReasons: ['human_lane_requires_approval', ...stepApprovalReasons(params.step, routedTools)],
    })
  }

  if (requestedToolNames.length === 0) {
    blockedReasons.push({
      reason: 'empty_allowed_tools',
      detail: `Plan step ${params.step.id} must declare allowedTools before it can be routed.`,
    })
  }

  for (const toolName of requestedToolNames) {
    const descriptor = params.descriptors.getOptional(toolName)
    if (!descriptor) {
      blockedReasons.push({
        reason: 'unknown_tool',
        toolName,
        detail: `Plan step ${params.step.id} references unknown tool: ${toolName}`,
      })
      continue
    }

    if (!descriptor.public) {
      blockedReasons.push({
        reason: 'non_public_tool',
        toolName,
        detail: `Plan step ${params.step.id} references non-public tool: ${toolName}`,
      })
      continue
    }

    if (!isToolAllowedForPlanLane(params.step.lane, descriptor)) {
      blockedReasons.push({
        reason: 'cross_lane_tool',
        toolName,
        detail: `Tool ${toolName} with descriptor lane ${descriptor.lane} is not allowed for plan lane ${params.step.lane}.`,
      })
      continue
    }

    routedTools.push(toRoutedTool(descriptor))
  }

  return buildRoute({
    step: params.step,
    requestedToolNames,
    routedTools,
    blockedReasons,
    approvalReasons: stepApprovalReasons(params.step, routedTools),
  })
}

/**
 * Classifies every step in a plan without executing or scheduling any step.
 */
export function routePlanSpec(params: {
  plan: PlanSpec
  descriptors: PlanLaneDescriptorLookup
}): PlanLaneRoutingResult {
  const routes = params.plan.steps.map(step => routePlanStep({ step, descriptors: params.descriptors }))

  return {
    scope: 'current_run_plan_lane_routing',
    routes,
    blockedStepIds: routes.filter(route => route.status === 'blocked').map(route => route.stepId),
    approvalRequiredStepIds: routes.filter(route => route.status === 'requires_approval').map(route => route.stepId),
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

export function isToolAllowedForPlanLane(planLane: PlanLane, descriptor: ToolDescriptor): boolean {
  switch (planLane) {
    case 'coding':
      return descriptor.lane === 'coding' || CODING_WORKFLOW_TOOL_NAMES.has(descriptor.canonicalName)
    case 'desktop':
      return (descriptor.lane === 'desktop' && !descriptor.canonicalName.startsWith('terminal_'))
        || descriptor.lane === 'display'
        || descriptor.lane === 'accessibility'
    case 'browser_dom':
      return descriptor.lane === 'browser_dom'
    case 'terminal':
      return descriptor.lane === 'pty' || LEGACY_TERMINAL_TOOL_NAMES.has(descriptor.canonicalName)
    case 'human':
      return false
  }
}

function buildRoute(params: {
  step: PlanSpecStep
  requestedToolNames: string[]
  routedTools: PlanLaneRoutedTool[]
  approvalReasons: PlanLaneRouteApprovalReason[]
  blockedReasons: PlanLaneRouteProblem[]
}): PlanStepLaneRoute {
  const dedupedApprovalReasons = Array.from(new Set(params.approvalReasons))
  const status = params.blockedReasons.length > 0
    ? 'blocked'
    : dedupedApprovalReasons.length > 0 ? 'requires_approval' : 'routable'

  return {
    scope: 'current_run_plan_lane_routing',
    stepId: params.step.id,
    lane: params.step.lane,
    status,
    requestedToolNames: params.requestedToolNames,
    routedToolNames: params.routedTools.map(tool => tool.canonicalName),
    routedTools: params.routedTools,
    approvalRequired: dedupedApprovalReasons.length > 0,
    approvalReasons: dedupedApprovalReasons,
    blockedReasons: params.blockedReasons,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function stepApprovalReasons(
  step: PlanSpecStep,
  routedTools: readonly PlanLaneRoutedTool[],
): PlanLaneRouteApprovalReason[] {
  const reasons: PlanLaneRouteApprovalReason[] = []

  if (step.approvalRequired)
    reasons.push('step_requires_approval')
  if (step.riskLevel === 'high')
    reasons.push('high_risk_step')
  if (routedTools.some(tool => tool.requiresApprovalByDefault))
    reasons.push('tool_requires_approval')
  if (routedTools.some(tool => tool.destructive))
    reasons.push('destructive_tool')

  return reasons
}

function toRoutedTool(descriptor: ToolDescriptor): PlanLaneRoutedTool {
  return {
    canonicalName: descriptor.canonicalName,
    lane: descriptor.lane,
    kind: descriptor.kind,
    readOnly: descriptor.readOnly,
    destructive: descriptor.destructive,
    concurrencySafe: descriptor.concurrencySafe,
    requiresApprovalByDefault: descriptor.requiresApprovalByDefault,
  }
}
