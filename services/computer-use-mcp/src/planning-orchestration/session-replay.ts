import type {
  PlanHostRuntimeSessionEvent,
  PlanHostRuntimeSessionSnapshot,
} from './runtime-session'
import type { PlanHostSessionWorkflowRunResult } from './workflow-session'

const MAX_PREVIEW_CHARS = 500

export type PlanSessionRecoveryReplayClass
  = | 'transition_blocked'
    | 'transition_rejected'
    | 'replan_requested'
    | 'replacement_blocked'
    | 'workflow_execution_blocked'
    | 'workflow_reconciliation_skipped'
    | 'unknown'

export interface PlanSessionRecoveryReplayCase {
  failureClass: PlanSessionRecoveryReplayClass
  summary: string
  deterministicAnchor: string
  nextFollowUp: string
}

export interface PlanSessionRecoveryReplayEventSummary {
  sequence: number
  generation: number
  kind: PlanHostRuntimeSessionEvent['kind']
  status: string
  problemReasons: string[]
  detailPreview?: string
  proposalKind?: string
  stateUpdated?: boolean
  activeRuntimeReplaced?: boolean
}

export interface PlanSessionRecoveryReplayWorkflowRunSummary {
  status: PlanHostSessionWorkflowRunResult['status']
  executionStatus: PlanHostSessionWorkflowRunResult['execution']['status']
  executed: boolean
  reconciliationIncluded: boolean
  reconciliationSkippedReason?: string
  problemReasons: string[]
  detailPreview?: string
}

export interface PlanSessionRecoveryReplayRow {
  scope: 'current_run_plan_session_recovery_replay'
  source: 'host_plan_runtime_session'
  sessionId: string
  generation: number
  activeGoalPreview: string
  activeCurrentStepId?: string
  eventCount: number
  transitionCount: number
  replacementCount: number
  failureClass: PlanSessionRecoveryReplayClass
  classificationSummary: string
  deterministicAnchor: string
  nextFollowUp: string
  latestEvent?: PlanSessionRecoveryReplayEventSummary
  workflowRun?: PlanSessionRecoveryReplayWorkflowRunSummary
  eventHistory: PlanSessionRecoveryReplayEventSummary[]
  mutatesPersistentState: false
  mayExecute: false
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

export interface NormalizePlanSessionRecoveryReplayInput {
  session: PlanHostRuntimeSessionSnapshot
  workflowRun?: PlanHostSessionWorkflowRunResult
}

const PLAN_SESSION_RECOVERY_REPLAY_CASES = [
  {
    failureClass: 'transition_blocked',
    summary: 'A host-reviewed plan transition was blocked before current-run PlanState mutation.',
    deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts blocked transition case',
    nextFollowUp: 'test(computer-use-mcp): add deterministic replay for blocked plan session transition',
  },
  {
    failureClass: 'transition_rejected',
    summary: 'A host explicitly rejected a plan transition; this is audit evidence, not a runtime failure by itself.',
    deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts rejected transition case',
    nextFollowUp: 'test(computer-use-mcp): add deterministic replay for rejected plan session transition',
  },
  {
    failureClass: 'replan_requested',
    summary: 'A host requested replanning instead of accepting the current transition.',
    deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts replan requested transition case',
    nextFollowUp: 'test(computer-use-mcp): add deterministic replay for plan session replan request',
  },
  {
    failureClass: 'replacement_blocked',
    summary: 'A host-supplied replacement PlanSpec was blocked before becoming the active current-run plan.',
    deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts blocked replacement case',
    nextFollowUp: 'test(computer-use-mcp): add deterministic replay for blocked replacement plan acceptance',
  },
  {
    failureClass: 'workflow_execution_blocked',
    summary: 'Mapped workflow execution was blocked before workflow evidence could update the plan session.',
    deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts blocked workflow execution case',
    nextFollowUp: 'test(computer-use-mcp): add deterministic replay for blocked plan workflow execution',
  },
  {
    failureClass: 'workflow_reconciliation_skipped',
    summary: 'Workflow execution did not produce a usable plan reconciliation transition.',
    deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts skipped workflow reconciliation case',
    nextFollowUp: 'test(computer-use-mcp): add deterministic replay for skipped plan workflow reconciliation',
  },
  {
    failureClass: 'unknown',
    summary: 'Unmapped plan session recovery signal; add deterministic replay before changing orchestration runtime behavior.',
    deterministicAnchor: 'src/planning-orchestration/session-replay.test.ts unknown recovery fallback',
    nextFollowUp: 'test(computer-use-mcp): add deterministic replay for unmapped plan session recovery',
  },
] as const satisfies readonly PlanSessionRecoveryReplayCase[]

/**
 * Normalizes current-run plan session recovery evidence into a bounded replay
 * row. This is for deterministic triage only; it never executes lanes, mutates
 * PlanState, or exports memory.
 */
export function normalizePlanSessionRecoveryReplay(
  input: NormalizePlanSessionRecoveryReplayInput,
): PlanSessionRecoveryReplayRow {
  const eventHistory = input.session.history.map(summarizeSessionEvent)
  const latestEvent = eventHistory.at(-1)
  const workflowRun = input.workflowRun ? summarizeWorkflowRun(input.workflowRun) : undefined
  const failureClass = classifyPlanSessionRecoveryReplay({
    latestEvent,
    workflowRun,
  })
  const replayCase = findPlanSessionRecoveryReplayCase(failureClass)

  return {
    scope: 'current_run_plan_session_recovery_replay',
    source: 'host_plan_runtime_session',
    sessionId: input.session.sessionId,
    generation: input.session.generation,
    activeGoalPreview: previewString(input.session.activeSnapshot.plan.goal) ?? '',
    ...(input.session.activeSnapshot.state.currentStepId
      ? { activeCurrentStepId: input.session.activeSnapshot.state.currentStepId }
      : {}),
    eventCount: input.session.eventCount,
    transitionCount: input.session.transitionCount,
    replacementCount: input.session.replacementCount,
    failureClass,
    classificationSummary: replayCase.summary,
    deterministicAnchor: replayCase.deterministicAnchor,
    nextFollowUp: replayCase.nextFollowUp,
    ...(latestEvent ? { latestEvent } : {}),
    ...(workflowRun ? { workflowRun } : {}),
    eventHistory,
    mutatesPersistentState: false,
    mayExecute: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}

export function findPlanSessionRecoveryReplayCase(
  failureClass: PlanSessionRecoveryReplayClass,
): PlanSessionRecoveryReplayCase {
  return PLAN_SESSION_RECOVERY_REPLAY_CASES.find(entry => entry.failureClass === failureClass)
    ?? PLAN_SESSION_RECOVERY_REPLAY_CASES.at(-1)!
}

function classifyPlanSessionRecoveryReplay(params: {
  latestEvent?: PlanSessionRecoveryReplayEventSummary
  workflowRun?: PlanSessionRecoveryReplayWorkflowRunSummary
}): PlanSessionRecoveryReplayClass {
  if (params.workflowRun && !params.latestEvent) {
    if (params.workflowRun.executionStatus === 'blocked')
      return 'workflow_execution_blocked'
    if (!params.workflowRun.reconciliationIncluded)
      return 'workflow_reconciliation_skipped'
  }

  if (params.latestEvent?.kind === 'transition') {
    if (params.latestEvent.status === 'blocked')
      return 'transition_blocked'
    if (params.latestEvent.status === 'rejected')
      return 'transition_rejected'
    if (params.latestEvent.status === 'replan_requested')
      return 'replan_requested'
  }

  if (params.latestEvent?.kind === 'replacement' && params.latestEvent.status === 'blocked')
    return 'replacement_blocked'

  if (params.workflowRun?.executionStatus === 'blocked')
    return 'workflow_execution_blocked'
  if (params.workflowRun && !params.workflowRun.reconciliationIncluded)
    return 'workflow_reconciliation_skipped'

  return 'unknown'
}

function summarizeSessionEvent(event: PlanHostRuntimeSessionEvent): PlanSessionRecoveryReplayEventSummary {
  if (event.kind === 'transition') {
    const transition = event.transitionRecord.transition
    return {
      sequence: event.sequence,
      generation: event.generation,
      kind: event.kind,
      status: transition.status,
      problemReasons: transition.problems.map(problem => problem.reason),
      detailPreview: previewString(transition.problems.map(problem => problem.detail).join('\n')),
      proposalKind: transition.proposalKind,
      stateUpdated: event.transitionRecord.stateUpdated,
    }
  }

  return {
    sequence: event.sequence,
    generation: event.generation,
    kind: event.kind,
    status: event.replacement.status,
    problemReasons: event.replacement.problems.map(problem => problem.reason),
    detailPreview: previewString(event.replacement.problems.map(problem => problem.detail).join('\n')),
    activeRuntimeReplaced: event.activeRuntimeReplaced,
  }
}

function summarizeWorkflowRun(run: PlanHostSessionWorkflowRunResult): PlanSessionRecoveryReplayWorkflowRunSummary {
  return {
    status: run.status,
    executionStatus: run.execution.status,
    executed: run.execution.executed,
    reconciliationIncluded: run.reconciliation.included,
    ...(run.reconciliation.skippedReason ? { reconciliationSkippedReason: run.reconciliation.skippedReason } : {}),
    problemReasons: run.problems.map(problem => problem.reason),
    detailPreview: previewString(run.problems.map(problem => problem.detail).join('\n')),
  }
}

function previewString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed)
    return undefined
  return trimmed.length > MAX_PREVIEW_CHARS ? trimmed.slice(0, MAX_PREVIEW_CHARS) : trimmed
}
