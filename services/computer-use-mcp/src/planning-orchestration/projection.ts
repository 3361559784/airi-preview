import type {
  PlanSpec,
  PlanState,
  PlanStepStatus,
} from './contract'

import {
  getPlanningAuthorityRule,
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
  PLANNING_ORCHESTRATION_TRUST_LABEL,
} from './contract'

export type PlanStateProjectionStatus = 'active' | 'blocked' | 'stale' | 'superseded'

export interface PlanStateProjectionOptions {
  status?: PlanStateProjectionStatus
  statusReason?: string
  supersededByPlanId?: string
  maxSteps?: number
  maxEvidenceRefs?: number
  maxBlockers?: number
  maxTextChars?: number
}

export interface PlanStateProjectionMetadata {
  scope: 'current_run_plan_projection'
  included: boolean
  status: PlanStateProjectionStatus
  characters: number
  projectedStepCount: number
  omittedStepCount: number
  projectedEvidenceRefCount: number
  omittedEvidenceRefCount: number
  projectedBlockerCount: number
  omittedBlockerCount: number
  authoritySource: 'plan_state_reconciler_decision'
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanStatePromptProjection {
  block: string
  metadata: PlanStateProjectionMetadata
}

const DEFAULT_PROJECTION_LIMITS = Object.freeze({
  maxSteps: 8,
  maxEvidenceRefs: 8,
  maxBlockers: 5,
  maxTextChars: 240,
})

const WHITESPACE_RE = /\s+/g

/**
 * Builds a bounded model-visible plan-state block without wiring it into any
 * runner. This is the contract for future prompt projection, not a lane router.
 */
export function projectPlanStateForPrompt(
  plan: PlanSpec,
  state: PlanState,
  options: PlanStateProjectionOptions = {},
): PlanStatePromptProjection {
  const limits = {
    maxSteps: positiveLimit(options.maxSteps, DEFAULT_PROJECTION_LIMITS.maxSteps),
    maxEvidenceRefs: positiveLimit(options.maxEvidenceRefs, DEFAULT_PROJECTION_LIMITS.maxEvidenceRefs),
    maxBlockers: positiveLimit(options.maxBlockers, DEFAULT_PROJECTION_LIMITS.maxBlockers),
    maxTextChars: positiveLimit(options.maxTextChars, DEFAULT_PROJECTION_LIMITS.maxTextChars),
  }
  const status = options.status ?? inferPlanStateProjectionStatus(state)
  const authorityRule = getPlanningAuthorityRule('plan_state_reconciler_decision')
  const projectedSteps = plan.steps.slice(0, limits.maxSteps)
  const projectedEvidenceRefs = state.evidenceRefs.slice(0, limits.maxEvidenceRefs)
  const projectedBlockers = state.blockers.slice(0, limits.maxBlockers)

  const lines = [
    PLANNING_ORCHESTRATION_TRUST_LABEL,
    ...PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
    '- This projection is current-run only and must not be persisted to Workspace Memory, Archive, or plast-mem.',
    '',
    `Projection status: ${status}`,
  ]

  if (options.statusReason)
    lines.push(`Status reason: ${boundedText(options.statusReason, limits.maxTextChars)}`)
  if (options.supersededByPlanId)
    lines.push(`Superseded by plan: ${boundedText(options.supersededByPlanId, limits.maxTextChars)}`)

  lines.push(
    `Authority source: ${authorityRule.label}`,
    `May satisfy verification gate: ${String(authorityRule.maySatisfyVerificationGate)}`,
    `May satisfy mutation proof: ${String(authorityRule.maySatisfyMutationProof)}`,
    '',
    `Goal: ${boundedText(plan.goal, limits.maxTextChars)}`,
    `Current step: ${state.currentStepId ? boundedText(state.currentStepId, limits.maxTextChars) : 'none'}`,
    'Projected steps:',
  )

  if (projectedSteps.length === 0) {
    lines.push('- none')
  }
  else {
    for (const step of projectedSteps) {
      const stepStatus = resolveStepStatus(step.id, state)
      const expectedEvidence = step.expectedEvidence
        .map(evidence => `${evidence.source}:${boundedText(evidence.description, limits.maxTextChars)}`)
        .join('; ') || 'none'
      lines.push(
        `- ${boundedText(step.id, limits.maxTextChars)} [${step.lane}/${stepStatus}/${step.riskLevel}${step.approvalRequired ? '/approval_required' : ''}] ${boundedText(step.intent, limits.maxTextChars)}`,
        `  allowedTools: ${step.allowedTools.length > 0 ? step.allowedTools.map(tool => boundedText(tool, limits.maxTextChars)).join(', ') : 'none'}`,
        `  expectedEvidence: ${expectedEvidence}`,
      )
    }
  }

  const omittedStepCount = plan.steps.length - projectedSteps.length
  if (omittedStepCount > 0)
    lines.push(`- omittedSteps: ${omittedStepCount}`)

  lines.push('', 'Evidence refs:')
  if (projectedEvidenceRefs.length === 0) {
    lines.push('- none')
  }
  else {
    for (const evidenceRef of projectedEvidenceRefs) {
      lines.push(`- ${boundedText(evidenceRef.stepId, limits.maxTextChars)} [${evidenceRef.source}] ${boundedText(evidenceRef.summary, limits.maxTextChars)}`)
    }
  }
  const omittedEvidenceRefCount = state.evidenceRefs.length - projectedEvidenceRefs.length
  if (omittedEvidenceRefCount > 0)
    lines.push(`- omittedEvidenceRefs: ${omittedEvidenceRefCount}`)

  lines.push('', 'Blockers:')
  if (projectedBlockers.length === 0) {
    lines.push('- none')
  }
  else {
    for (const blocker of projectedBlockers)
      lines.push(`- ${boundedText(blocker, limits.maxTextChars)}`)
  }
  const omittedBlockerCount = state.blockers.length - projectedBlockers.length
  if (omittedBlockerCount > 0)
    lines.push(`- omittedBlockers: ${omittedBlockerCount}`)

  if (state.lastReplanReason) {
    lines.push(
      '',
      `Last replan reason: ${boundedText(state.lastReplanReason, limits.maxTextChars)}`,
    )
  }

  const block = lines.join('\n')

  return {
    block,
    metadata: {
      scope: 'current_run_plan_projection',
      included: true,
      status,
      characters: block.length,
      projectedStepCount: projectedSteps.length,
      omittedStepCount,
      projectedEvidenceRefCount: projectedEvidenceRefs.length,
      omittedEvidenceRefCount,
      projectedBlockerCount: projectedBlockers.length,
      omittedBlockerCount,
      authoritySource: 'plan_state_reconciler_decision',
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    },
  }
}

function inferPlanStateProjectionStatus(state: PlanState): PlanStateProjectionStatus {
  return state.blockers.length > 0 ? 'blocked' : 'active'
}

function resolveStepStatus(stepId: string, state: PlanState): PlanStepStatus {
  if (state.completedSteps.includes(stepId))
    return 'completed'
  if (state.failedSteps.includes(stepId))
    return 'failed'
  if (state.skippedSteps.includes(stepId))
    return 'skipped'
  if (state.currentStepId === stepId)
    return state.blockers.length > 0 ? 'blocked' : 'in_progress'
  return 'pending'
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
