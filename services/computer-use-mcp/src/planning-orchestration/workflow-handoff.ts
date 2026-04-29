import type { PlanSpec } from './contract'
import type {
  PlanLaneRouteApprovalReason,
  PlanLaneRouteProblem,
  PlanLaneRoutingResult,
  PlanStepLaneRoute,
} from './lane-router'

export type PlanRouteWorkflowHandoffStatus
  = | 'ready_for_mapping'
    | 'requires_approval'
    | 'blocked'

export interface PlanRouteWorkflowHandoffStep {
  stepId: string
  lane: PlanStepLaneRoute['lane']
  routeStatus: PlanStepLaneRoute['status']
  handoffStatus: PlanRouteWorkflowHandoffStatus
  requestedToolNames: string[]
  candidateToolNames: string[]
  approvalRequired: boolean
  approvalReasons: PlanLaneRouteApprovalReason[]
  blockedReasons: PlanLaneRouteProblem[]
  workflowMappingRequired: true
  mayExecute: false
  mayCreateWorkflowDefinition: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanRouteWorkflowHandoffConsistencyError {
  reason: 'missing_route_for_plan_step' | 'route_without_plan_step' | 'duplicate_route_for_plan_step'
  stepId: string
}

export interface PlanRouteWorkflowHandoff {
  scope: 'current_run_plan_route_workflow_handoff'
  status: PlanRouteWorkflowHandoffStatus
  steps: PlanRouteWorkflowHandoffStep[]
  readyForMappingStepIds: string[]
  approvalRequiredStepIds: string[]
  blockedStepIds: string[]
  consistencyErrors: PlanRouteWorkflowHandoffConsistencyError[]
  mayExecute: false
  mayCreateWorkflowDefinition: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Builds a deterministic handoff summary from plan routes to future workflow
 * mapping. It does not create WorkflowDefinition steps because PlanSpec does
 * not carry executable workflow params.
 */
export function buildPlanRouteWorkflowHandoff(params: {
  plan: PlanSpec
  routing: PlanLaneRoutingResult
}): PlanRouteWorkflowHandoff {
  const consistencyErrors = findConsistencyErrors(params.plan, params.routing)
  const routeByStepId = new Map(params.routing.routes.map(route => [route.stepId, route]))
  const steps = params.plan.steps
    .map(step => routeByStepId.get(step.id))
    .filter((route): route is PlanStepLaneRoute => Boolean(route))
    .map(toHandoffStep)

  const blockedStepIds = Array.from(new Set([
    ...steps.filter(step => step.handoffStatus === 'blocked').map(step => step.stepId),
    ...consistencyErrors.map(error => error.stepId),
  ]))
  const approvalRequiredStepIds = steps
    .filter(step => step.handoffStatus === 'requires_approval')
    .map(step => step.stepId)
  const readyForMappingStepIds = steps
    .filter(step => step.handoffStatus === 'ready_for_mapping')
    .map(step => step.stepId)

  return {
    scope: 'current_run_plan_route_workflow_handoff',
    status: blockedStepIds.length > 0
      ? 'blocked'
      : approvalRequiredStepIds.length > 0 ? 'requires_approval' : 'ready_for_mapping',
    steps,
    readyForMappingStepIds,
    approvalRequiredStepIds,
    blockedStepIds,
    consistencyErrors,
    mayExecute: false,
    mayCreateWorkflowDefinition: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function toHandoffStep(route: PlanStepLaneRoute): PlanRouteWorkflowHandoffStep {
  return {
    stepId: route.stepId,
    lane: route.lane,
    routeStatus: route.status,
    handoffStatus: toHandoffStatus(route),
    requestedToolNames: [...route.requestedToolNames],
    candidateToolNames: [...route.routedToolNames],
    approvalRequired: route.approvalRequired,
    approvalReasons: [...route.approvalReasons],
    blockedReasons: route.blockedReasons.map(reason => ({ ...reason })),
    workflowMappingRequired: true,
    mayExecute: false,
    mayCreateWorkflowDefinition: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

function toHandoffStatus(route: PlanStepLaneRoute): PlanRouteWorkflowHandoffStatus {
  switch (route.status) {
    case 'blocked':
      return 'blocked'
    case 'requires_approval':
      return 'requires_approval'
    case 'routable':
      return 'ready_for_mapping'
  }
}

function findConsistencyErrors(
  plan: PlanSpec,
  routing: PlanLaneRoutingResult,
): PlanRouteWorkflowHandoffConsistencyError[] {
  const errors: PlanRouteWorkflowHandoffConsistencyError[] = []
  const planStepIds = new Set(plan.steps.map(step => step.id))
  const routeCounts = new Map<string, number>()

  for (const route of routing.routes)
    routeCounts.set(route.stepId, (routeCounts.get(route.stepId) ?? 0) + 1)

  for (const stepId of planStepIds) {
    if (!routeCounts.has(stepId)) {
      errors.push({
        reason: 'missing_route_for_plan_step',
        stepId,
      })
    }
  }

  for (const [stepId, count] of routeCounts) {
    if (!planStepIds.has(stepId)) {
      errors.push({
        reason: 'route_without_plan_step',
        stepId,
      })
    }
    if (count > 1) {
      errors.push({
        reason: 'duplicate_route_for_plan_step',
        stepId,
      })
    }
  }

  return errors
}
