import type {
  PlanLaneRoutingResult,
  PlanStepLaneRoute,
} from './lane-router'

import {
  getPlanningAuthorityRule,
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
} from './contract'

export interface PlanRouteSummaryProjectionOptions {
  maxRoutes?: number
  maxToolsPerRoute?: number
  maxReasonsPerRoute?: number
  maxTextChars?: number
}

export interface PlanRouteSummaryProjectionMetadata {
  scope: 'current_run_plan_route_projection'
  included: boolean
  characters: number
  projectedRouteCount: number
  omittedRouteCount: number
  projectedBlockedStepCount: number
  omittedBlockedStepCount: number
  projectedApprovalStepCount: number
  omittedApprovalStepCount: number
  authoritySource: 'plan_state_reconciler_decision'
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanRouteSummaryPromptProjection {
  block: string
  metadata: PlanRouteSummaryProjectionMetadata
}

const DEFAULT_ROUTE_PROJECTION_LIMITS = Object.freeze({
  maxRoutes: 8,
  maxToolsPerRoute: 6,
  maxReasonsPerRoute: 4,
  maxTextChars: 240,
})

const WHITESPACE_RE = /\s+/g

/**
 * Projects deterministic lane-router output as bounded runtime guidance.
 *
 * This projection is intentionally not an executor handoff: it preserves
 * blocked/approval information for context without granting tool authority.
 */
export function projectPlanRouteSummaryForPrompt(
  routing: PlanLaneRoutingResult,
  options: PlanRouteSummaryProjectionOptions = {},
): PlanRouteSummaryPromptProjection {
  const limits = {
    maxRoutes: positiveLimit(options.maxRoutes, DEFAULT_ROUTE_PROJECTION_LIMITS.maxRoutes),
    maxToolsPerRoute: positiveLimit(options.maxToolsPerRoute, DEFAULT_ROUTE_PROJECTION_LIMITS.maxToolsPerRoute),
    maxReasonsPerRoute: positiveLimit(options.maxReasonsPerRoute, DEFAULT_ROUTE_PROJECTION_LIMITS.maxReasonsPerRoute),
    maxTextChars: positiveLimit(options.maxTextChars, DEFAULT_ROUTE_PROJECTION_LIMITS.maxTextChars),
  }
  const authorityRule = getPlanningAuthorityRule('plan_state_reconciler_decision')
  const projectedRoutes = routing.routes.slice(0, limits.maxRoutes)
  const projectedBlockedStepIds = routing.blockedStepIds.slice(0, limits.maxRoutes)
  const projectedApprovalStepIds = routing.approvalRequiredStepIds.slice(0, limits.maxRoutes)

  const lines = [
    'Plan lane routing summary (runtime guidance, not authority):',
    ...PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
    '- Routing classification never executes tools, schedules workflow steps, or satisfies completion proof.',
    '- Blocked or approval-required routes must be handled by policy before any future execution handoff.',
    '',
    `Authority source: ${authorityRule.label}`,
    `May execute routed tools: ${String(routing.mayExecute)}`,
    `May satisfy verification gate: ${String(routing.maySatisfyVerificationGate)}`,
    `May satisfy mutation proof: ${String(routing.maySatisfyMutationProof)}`,
    '',
    'Route status summary:',
    `- blockedStepIds: ${formatList(projectedBlockedStepIds, routing.blockedStepIds.length, limits.maxTextChars)}`,
    `- approvalRequiredStepIds: ${formatList(projectedApprovalStepIds, routing.approvalRequiredStepIds.length, limits.maxTextChars)}`,
    '',
    'Projected routes:',
  ]

  if (projectedRoutes.length === 0) {
    lines.push('- none')
  }
  else {
    for (const route of projectedRoutes)
      lines.push(...formatRoute(route, limits))
  }

  const omittedRouteCount = routing.routes.length - projectedRoutes.length
  if (omittedRouteCount > 0)
    lines.push(`- omittedRoutes: ${omittedRouteCount}`)

  const block = lines.join('\n')

  return {
    block,
    metadata: {
      scope: 'current_run_plan_route_projection',
      included: true,
      characters: block.length,
      projectedRouteCount: projectedRoutes.length,
      omittedRouteCount,
      projectedBlockedStepCount: projectedBlockedStepIds.length,
      omittedBlockedStepCount: routing.blockedStepIds.length - projectedBlockedStepIds.length,
      projectedApprovalStepCount: projectedApprovalStepIds.length,
      omittedApprovalStepCount: routing.approvalRequiredStepIds.length - projectedApprovalStepIds.length,
      authoritySource: 'plan_state_reconciler_decision',
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    },
  }
}

function formatRoute(
  route: PlanStepLaneRoute,
  limits: {
    maxToolsPerRoute: number
    maxReasonsPerRoute: number
    maxTextChars: number
  },
): string[] {
  const projectedTools = route.routedToolNames.slice(0, limits.maxToolsPerRoute)
  const projectedApprovalReasons = route.approvalReasons.slice(0, limits.maxReasonsPerRoute)
  const projectedBlockedReasons = route.blockedReasons.slice(0, limits.maxReasonsPerRoute)
  const lines = [
    `- ${boundedText(route.stepId, limits.maxTextChars)} [${route.lane}/${route.status}]`,
    `  routedTools: ${formatList(projectedTools, route.routedToolNames.length, limits.maxTextChars)}`,
    `  approvalRequired: ${String(route.approvalRequired)}`,
    `  approvalReasons: ${formatList(projectedApprovalReasons, route.approvalReasons.length, limits.maxTextChars)}`,
  ]

  if (projectedBlockedReasons.length === 0) {
    lines.push('  blockedReasons: none')
  }
  else {
    lines.push(`  blockedReasons: ${formatList(
      projectedBlockedReasons.map(reason => reason.toolName ? `${reason.reason}:${reason.toolName}` : reason.reason),
      route.blockedReasons.length,
      limits.maxTextChars,
    )}`)
  }

  return lines
}

function formatList(
  values: readonly string[],
  totalCount: number,
  maxTextChars: number,
): string {
  if (values.length === 0)
    return totalCount > 0 ? `omitted ${totalCount}` : 'none'

  const rendered = values.map(value => boundedText(value, maxTextChars)).join(', ')
  const omittedCount = totalCount - values.length
  return omittedCount > 0 ? `${rendered}, omitted ${omittedCount}` : rendered
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function boundedText(value: string, maxChars: number): string {
  const normalized = value.replace(WHITESPACE_RE, ' ').trim()
  if (normalized.length <= maxChars)
    return normalized

  const suffix = '...[truncated]'
  if (maxChars <= suffix.length)
    return suffix.slice(0, maxChars)

  return `${normalized.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`
}
