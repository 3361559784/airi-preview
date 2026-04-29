import type {
  PlanExpectedEvidence,
  PlanReconcilerDecisionRecord,
  PlanSpec,
  PlanState,
  PlanStepStatus,
} from './contract'

export type PlanEvidenceObservationSource = PlanExpectedEvidence['source']

export type PlanEvidenceObservationStatus = 'satisfied' | 'failed'

export interface PlanEvidenceObservation {
  id?: string
  stepId: string
  source: PlanEvidenceObservationSource
  status: PlanEvidenceObservationStatus
  summary: string
  toolName?: string
  reasonCode?: string
}

export type PlanExpectedEvidenceMatchStatus = 'satisfied' | 'missing' | 'failed'

export interface PlanExpectedEvidenceMatch {
  expectedIndex: number
  source: PlanEvidenceObservationSource
  description: string
  status: PlanExpectedEvidenceMatchStatus
  observation?: PlanEvidenceObservation
}

export type PlanStepEvidenceStatus
  = | 'satisfied'
    | 'pending'
    | 'missing_evidence'
    | 'blocked_by_failed_evidence'
    | 'requires_approval'
    | 'skipped'

export interface PlanStepEvidenceReconciliation {
  stepId: string
  planStatus: PlanStepStatus
  evidenceStatus: PlanStepEvidenceStatus
  matches: PlanExpectedEvidenceMatch[]
}

export interface PlanEvidenceReconciliationResult {
  scope: 'current_run_plan_evidence_reconciliation'
  decision: PlanReconcilerDecisionRecord
  stepResults: PlanStepEvidenceReconciliation[]
  ignoredObservationCount: number
  maySatisfyVerificationGate: false
  maySatisfyMutationProof: false
}

/**
 * Reconciles expected plan evidence against explicit current-run observations.
 *
 * This contract intentionally uses exact step/source matching only. It does not
 * infer evidence from natural language summaries, transcript text, memory, or
 * plan completion claims.
 */
export function reconcilePlanEvidence(params: {
  plan: PlanSpec
  state: PlanState
  observations: readonly PlanEvidenceObservation[]
}): PlanEvidenceReconciliationResult {
  const planStepIds = new Set(params.plan.steps.map(step => step.id))
  const inconsistentStateReason = findInconsistentStateReason(params.state, planStepIds)
  if (inconsistentStateReason) {
    return buildResult({
      decision: {
        decision: 'fail',
        reason: inconsistentStateReason.reason,
        stepId: inconsistentStateReason.stepId,
      },
      stepResults: params.plan.steps.map(step => reconcileStepEvidence(step, params.state, params.observations)),
      ignoredObservationCount: countIgnoredObservations(params.observations, planStepIds),
    })
  }

  const unknownCurrentStep = params.state.currentStepId && !planStepIds.has(params.state.currentStepId)
  if (unknownCurrentStep) {
    return buildResult({
      decision: {
        decision: 'replan',
        reason: `Current step is not in plan: ${params.state.currentStepId}`,
        stepId: params.state.currentStepId,
      },
      stepResults: params.plan.steps.map(step => reconcileStepEvidence(step, params.state, params.observations)),
      ignoredObservationCount: countIgnoredObservations(params.observations, planStepIds),
    })
  }

  const stepResults = params.plan.steps.map(step => reconcileStepEvidence(step, params.state, params.observations))
  const ignoredObservationCount = countIgnoredObservations(params.observations, planStepIds)
  if (params.state.blockers.length > 0) {
    return buildResult({
      decision: {
        decision: 'replan',
        reason: 'Plan state has blockers that require replanning.',
        stepId: params.state.currentStepId,
      },
      stepResults,
      ignoredObservationCount,
    })
  }

  const failedStep = stepResults.find(step => step.evidenceStatus === 'blocked_by_failed_evidence')
  if (failedStep) {
    return buildResult({
      decision: {
        decision: 'replan',
        reason: `Plan evidence failed for step: ${failedStep.stepId}`,
        stepId: failedStep.stepId,
      },
      stepResults,
      ignoredObservationCount,
    })
  }

  const approvalStep = stepResults.find(step => step.evidenceStatus === 'requires_approval')
  if (approvalStep) {
    return buildResult({
      decision: {
        decision: 'require_approval',
        reason: `Plan step requires approval evidence: ${approvalStep.stepId}`,
        stepId: approvalStep.stepId,
        requiredApproval: approvalStep.matches.find(match => match.source === 'human_approval')?.description,
      },
      stepResults,
      ignoredObservationCount,
    })
  }

  const requiredStepResults = stepResults.filter(step => step.evidenceStatus !== 'skipped')
  if (requiredStepResults.length > 0 && requiredStepResults.every(step => step.planStatus === 'completed' && step.evidenceStatus === 'satisfied')) {
    return buildResult({
      decision: {
        decision: 'ready_for_final_verification',
        reason: 'All non-skipped plan steps have matched current-run evidence.',
      },
      stepResults,
      ignoredObservationCount,
    })
  }

  const missingCompletedStep = stepResults.find(step => step.planStatus === 'completed' && step.evidenceStatus === 'missing_evidence')
  if (missingCompletedStep) {
    return buildResult({
      decision: {
        decision: 'continue',
        reason: `Completed plan step still lacks expected evidence: ${missingCompletedStep.stepId}`,
        stepId: missingCompletedStep.stepId,
      },
      stepResults,
      ignoredObservationCount,
    })
  }

  return buildResult({
    decision: {
      decision: 'continue',
      reason: 'Plan evidence is not complete yet.',
      stepId: params.state.currentStepId,
    },
    stepResults,
    ignoredObservationCount,
  })
}

function reconcileStepEvidence(
  step: PlanSpec['steps'][number],
  state: PlanState,
  observations: readonly PlanEvidenceObservation[],
): PlanStepEvidenceReconciliation {
  const planStatus = resolveStepStatus(step.id, state)
  const matches = step.expectedEvidence.map((expected, expectedIndex) => matchExpectedEvidence(step.id, expected, expectedIndex, observations))

  if (planStatus === 'skipped') {
    return {
      stepId: step.id,
      planStatus,
      evidenceStatus: 'skipped',
      matches,
    }
  }

  if (matches.some(match => match.status === 'failed')) {
    return {
      stepId: step.id,
      planStatus,
      evidenceStatus: 'blocked_by_failed_evidence',
      matches,
    }
  }

  const isCurrentOrCompletedStep = planStatus === 'in_progress' || planStatus === 'blocked' || planStatus === 'completed'
  if (isCurrentOrCompletedStep && step.approvalRequired && matches.some(match => match.source === 'human_approval' && match.status !== 'satisfied')) {
    return {
      stepId: step.id,
      planStatus,
      evidenceStatus: 'requires_approval',
      matches,
    }
  }

  if (matches.length > 0 && matches.every(match => match.status === 'satisfied')) {
    return {
      stepId: step.id,
      planStatus,
      evidenceStatus: 'satisfied',
      matches,
    }
  }

  if (planStatus === 'completed') {
    return {
      stepId: step.id,
      planStatus,
      evidenceStatus: 'missing_evidence',
      matches,
    }
  }

  return {
    stepId: step.id,
    planStatus,
    evidenceStatus: 'pending',
    matches,
  }
}

function matchExpectedEvidence(
  stepId: string,
  expected: PlanExpectedEvidence,
  expectedIndex: number,
  observations: readonly PlanEvidenceObservation[],
): PlanExpectedEvidenceMatch {
  const observation = observations.find(candidate => candidate.stepId === stepId && candidate.source === expected.source)
  if (!observation) {
    return {
      expectedIndex,
      source: expected.source,
      description: expected.description,
      status: 'missing',
    }
  }

  return {
    expectedIndex,
    source: expected.source,
    description: expected.description,
    status: observation.status === 'satisfied' ? 'satisfied' : 'failed',
    observation: { ...observation },
  }
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

function countIgnoredObservations(
  observations: readonly PlanEvidenceObservation[],
  planStepIds: ReadonlySet<string>,
): number {
  return observations.filter(observation => !planStepIds.has(observation.stepId)).length
}

function findInconsistentStateReason(
  state: PlanState,
  planStepIds: ReadonlySet<string>,
): { reason: string, stepId?: string } | undefined {
  const terminalStepIds = new Map<string, string[]>()

  for (const stepId of state.completedSteps)
    addTerminalStepId(terminalStepIds, stepId, 'completedSteps')
  for (const stepId of state.failedSteps)
    addTerminalStepId(terminalStepIds, stepId, 'failedSteps')
  for (const stepId of state.skippedSteps)
    addTerminalStepId(terminalStepIds, stepId, 'skippedSteps')

  for (const [stepId, buckets] of terminalStepIds) {
    if (!planStepIds.has(stepId))
      return { reason: `Plan state references unknown step: ${stepId}`, stepId }
    if (buckets.length > 1)
      return { reason: `Plan state puts step in multiple terminal buckets: ${stepId}`, stepId }
  }

  if (state.currentStepId && terminalStepIds.has(state.currentStepId)) {
    return {
      reason: `Current step is already terminal: ${state.currentStepId}`,
      stepId: state.currentStepId,
    }
  }

  return undefined
}

function addTerminalStepId(map: Map<string, string[]>, stepId: string, bucket: string): void {
  const buckets = map.get(stepId) ?? []
  buckets.push(bucket)
  map.set(stepId, buckets)
}

function buildResult(params: {
  decision: PlanReconcilerDecisionRecord
  stepResults: PlanStepEvidenceReconciliation[]
  ignoredObservationCount: number
}): PlanEvidenceReconciliationResult {
  return {
    scope: 'current_run_plan_evidence_reconciliation',
    decision: params.decision,
    stepResults: params.stepResults,
    ignoredObservationCount: params.ignoredObservationCount,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  }
}
