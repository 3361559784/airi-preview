import type { PlanHostPlannerReplacementPlanRequest } from './host-planner-recovery-policy'

import {
  getPlanningAuthorityRule,
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
} from './contract'

export type PlanReplacementPlanRequestProjectionStatus = 'active' | 'stale' | 'superseded'

export interface PlanReplacementPlanRequestProjectionOptions {
  status?: PlanReplacementPlanRequestProjectionStatus
  statusReason?: string
  maxBoundaries?: number
  maxTextChars?: number
}

export interface PlanReplacementPlanRequestProjectionMetadata {
  scope: 'current_run_plan_replacement_plan_request_projection'
  included: true
  status: PlanReplacementPlanRequestProjectionStatus
  characters: number
  sessionId: string
  generation: number
  trigger: PlanHostPlannerReplacementPlanRequest['trigger']
  projectedBoundaryCount: number
  omittedBoundaryCount: number
  authoritySource: 'plan_state_reconciler_decision'
  acceptsHostSuppliedPlanSpecOnly: true
  mayCreatePlanSpec: false
  mayMutatePlanState: false
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanReplacementPlanRequestPromptProjection {
  block: string
  metadata: PlanReplacementPlanRequestProjectionMetadata
}

const DEFAULT_REPLACEMENT_REQUEST_PROJECTION_LIMITS = Object.freeze({
  maxBoundaries: 8,
  maxTextChars: 240,
})

const WHITESPACE_RE = /\s+/g

/**
 * Projects a host/planner replacement-plan request as bounded current-run
 * guidance. It does not generate a replacement PlanSpec or expose any session
 * mutation surface.
 */
export function projectReplacementPlanRequestForPrompt(
  request: PlanHostPlannerReplacementPlanRequest,
  options: PlanReplacementPlanRequestProjectionOptions = {},
): PlanReplacementPlanRequestPromptProjection {
  const limits = {
    maxBoundaries: positiveLimit(options.maxBoundaries, DEFAULT_REPLACEMENT_REQUEST_PROJECTION_LIMITS.maxBoundaries),
    maxTextChars: positiveLimit(options.maxTextChars, DEFAULT_REPLACEMENT_REQUEST_PROJECTION_LIMITS.maxTextChars),
  }
  const status = options.status ?? 'active'
  const authorityRule = getPlanningAuthorityRule('plan_state_reconciler_decision')
  const projectedBoundaries = request.boundaries.slice(0, limits.maxBoundaries)
  const omittedBoundaryCount = request.boundaries.length - projectedBoundaries.length

  const lines = [
    'Replacement plan request (runtime guidance, not authority):',
    ...PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
    '- This request asks a host/planner to supply a replacement PlanSpec; it does not create one.',
    '- The replacement PlanSpec must be validated by the host-owned recovery boundary before use.',
    '- This request cannot mutate session state, execute workflow steps, or satisfy verification proof.',
    '',
    `Projection status: ${status}`,
  ]

  if (options.statusReason)
    lines.push(`Status reason: ${boundedText(options.statusReason, limits.maxTextChars)}`)

  lines.push(
    `Authority source: ${authorityRule.label}`,
    `Accepts host-supplied PlanSpec only: ${String(request.acceptsHostSuppliedPlanSpecOnly)}`,
    `May create PlanSpec: ${String(request.mayCreatePlanSpec)}`,
    `May mutate PlanState: ${String(request.mayMutatePlanState)}`,
    `May execute lanes: ${String(request.mayExecute)}`,
    `May satisfy verification gate: ${String(request.maySatisfyVerificationGate)}`,
    `May satisfy mutation proof: ${String(request.maySatisfyMutationProof)}`,
    '',
    'Replacement request summary:',
    `- sessionId: ${boundedText(request.sessionId, limits.maxTextChars)}`,
    `- generation: ${request.generation}`,
    `- trigger: ${request.trigger}`,
    `- activeGoal: ${boundedText(request.activeGoalPreview, limits.maxTextChars)}`,
    `- activeCurrentStepId: ${request.activeCurrentStepId ? boundedText(request.activeCurrentStepId, limits.maxTextChars) : 'none'}`,
    `- reason: ${boundedText(request.reason, limits.maxTextChars)}`,
    '',
    'Recovery boundaries:',
  )

  if (projectedBoundaries.length === 0) {
    lines.push('- none')
  }
  else {
    for (const boundary of projectedBoundaries)
      lines.push(`- ${boundedText(boundary, limits.maxTextChars)}`)
  }

  if (omittedBoundaryCount > 0)
    lines.push(`- omittedBoundaries: ${omittedBoundaryCount}`)

  const block = lines.join('\n')

  return {
    block,
    metadata: {
      scope: 'current_run_plan_replacement_plan_request_projection',
      included: true,
      status,
      characters: block.length,
      sessionId: request.sessionId,
      generation: request.generation,
      trigger: request.trigger,
      projectedBoundaryCount: projectedBoundaries.length,
      omittedBoundaryCount,
      authoritySource: 'plan_state_reconciler_decision',
      acceptsHostSuppliedPlanSpecOnly: true,
      mayCreatePlanSpec: false,
      mayMutatePlanState: false,
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    },
  }
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
