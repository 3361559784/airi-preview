import type {
  PlanHostRuntimeSessionEvent,
  PlanHostRuntimeSessionSnapshot,
} from './runtime-session'

import {
  getPlanningAuthorityRule,
  PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
} from './contract'

export type PlanRuntimeSessionProjectionStatus = 'active' | 'blocked' | 'stale' | 'superseded'

export interface PlanRuntimeSessionProjectionOptions {
  status?: PlanRuntimeSessionProjectionStatus
  statusReason?: string
  maxEvents?: number
  maxTextChars?: number
}

export interface PlanRuntimeSessionProjectionMetadata {
  scope: 'current_run_plan_runtime_session_projection'
  included: boolean
  status: PlanRuntimeSessionProjectionStatus
  characters: number
  generation: number
  transitionCount: number
  replacementCount: number
  projectedEventCount: number
  omittedEventCount: number
  authoritySource: 'plan_state_reconciler_decision'
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface PlanRuntimeSessionPromptProjection {
  block: string
  metadata: PlanRuntimeSessionProjectionMetadata
}

const DEFAULT_SESSION_PROJECTION_LIMITS = Object.freeze({
  maxEvents: 8,
  maxTextChars: 240,
})

const WHITESPACE_RE = /\s+/g

/**
 * Projects a host-owned current-run plan session as bounded runtime guidance.
 * This summarizes session history only; it does not expose a session control
 * surface, execute lanes, or satisfy proof gates.
 */
export function projectPlanRuntimeSessionForPrompt(
  session: PlanHostRuntimeSessionSnapshot,
  options: PlanRuntimeSessionProjectionOptions = {},
): PlanRuntimeSessionPromptProjection {
  const limits = {
    maxEvents: positiveLimit(options.maxEvents, DEFAULT_SESSION_PROJECTION_LIMITS.maxEvents),
    maxTextChars: positiveLimit(options.maxTextChars, DEFAULT_SESSION_PROJECTION_LIMITS.maxTextChars),
  }
  const authorityRule = getPlanningAuthorityRule('plan_state_reconciler_decision')
  const status = options.status ?? inferSessionProjectionStatus(session)
  const projectedEvents = session.history.slice(0, limits.maxEvents)
  const omittedEventCount = session.history.length - projectedEvents.length
  const activeState = session.activeSnapshot.state

  const lines = [
    'Plan runtime session summary (runtime guidance, not authority):',
    ...PLANNING_ORCHESTRATION_TRUST_BOUNDARY_LINES,
    '- Session history is current-run guidance only and must not be persisted to Workspace Memory, Archive, or plast-mem.',
    '- Session generation and event claims cannot execute lanes or satisfy completion proof.',
    '',
    `Projection status: ${status}`,
  ]

  if (options.statusReason)
    lines.push(`Status reason: ${boundedText(options.statusReason, limits.maxTextChars)}`)

  lines.push(
    `Authority source: ${authorityRule.label}`,
    `Mutates persistent state: ${String(session.mutatesPersistentState)}`,
    `May execute lanes: ${String(session.mayExecute)}`,
    `May satisfy verification gate: ${String(session.maySatisfyVerificationGate)}`,
    `May satisfy mutation proof: ${String(session.maySatisfyMutationProof)}`,
    '',
    'Session summary:',
    `- sessionId: ${boundedText(session.sessionId, limits.maxTextChars)}`,
    `- generation: ${session.generation}`,
    `- activeGoal: ${boundedText(session.activeSnapshot.plan.goal, limits.maxTextChars)}`,
    `- activeCurrentStepId: ${activeState.currentStepId ? boundedText(activeState.currentStepId, limits.maxTextChars) : 'none'}`,
    `- completedStepCount: ${activeState.completedSteps.length}`,
    `- failedStepCount: ${activeState.failedSteps.length}`,
    `- skippedStepCount: ${activeState.skippedSteps.length}`,
    `- blockerCount: ${activeState.blockers.length}`,
    `- transitionCount: ${session.transitionCount}`,
    `- replacementCount: ${session.replacementCount}`,
    '',
    'Projected session events:',
  )

  if (projectedEvents.length === 0) {
    lines.push('- none')
  }
  else {
    for (const event of projectedEvents)
      lines.push(...formatSessionEvent(event, limits.maxTextChars))
  }

  if (omittedEventCount > 0)
    lines.push(`- omittedEvents: ${omittedEventCount}`)

  const block = lines.join('\n')

  return {
    block,
    metadata: {
      scope: 'current_run_plan_runtime_session_projection',
      included: true,
      status,
      characters: block.length,
      generation: session.generation,
      transitionCount: session.transitionCount,
      replacementCount: session.replacementCount,
      projectedEventCount: projectedEvents.length,
      omittedEventCount,
      authoritySource: 'plan_state_reconciler_decision',
      mutatesPersistentState: false,
      mayExecute: false,
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: false,
    },
  }
}

function inferSessionProjectionStatus(session: PlanHostRuntimeSessionSnapshot): PlanRuntimeSessionProjectionStatus {
  return session.activeSnapshot.state.blockers.length > 0 ? 'blocked' : 'active'
}

function formatSessionEvent(event: PlanHostRuntimeSessionEvent, maxTextChars: number): string[] {
  if (event.kind === 'transition') {
    return [
      `- #${event.sequence} generation=${event.generation} transition status=${event.transitionRecord.transition.status} stateUpdated=${String(event.transitionRecord.stateUpdated)}`,
      `  currentStepId: ${event.snapshot.state.currentStepId ? boundedText(event.snapshot.state.currentStepId, maxTextChars) : 'none'}`,
      `  reason: ${boundedText(event.transitionRecord.transition.hostEntry.rationale, maxTextChars)}`,
    ]
  }

  return [
    `- #${event.sequence} generation=${event.generation} replacement status=${event.replacement.status} activeRuntimeReplaced=${String(event.activeRuntimeReplaced)}`,
    `  actor: ${boundedText(event.replacement.actor, maxTextChars)}`,
    `  rationale: ${boundedText(event.replacement.rationale, maxTextChars)}`,
    `  previousCurrentStepId: ${event.previousSnapshot.state.currentStepId ? boundedText(event.previousSnapshot.state.currentStepId, maxTextChars) : 'none'}`,
    `  nextCurrentStepId: ${event.nextSnapshot.state.currentStepId ? boundedText(event.nextSnapshot.state.currentStepId, maxTextChars) : 'none'}`,
  ]
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
