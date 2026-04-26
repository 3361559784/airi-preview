import type { CodingRunState } from '../state'

const NON_MUTATING_COMPLETION_INTENTS = new Set(['analysis', 'report', 'investigation'])

export interface ReportOnlyCompletionCandidate {
  summary?: string
  nextStep?: string
}

export interface ReportOnlyCompletionEvidenceDecision {
  ok: boolean
  evidence: string[]
  issues: string[]
}

export function getCodingCompletionIntent(codingState?: CodingRunState): string | undefined {
  const session = codingState?.currentPlanSession as { changeIntent?: unknown } | undefined
  const selection = codingState?.lastTargetSelection as { changeIntent?: unknown } | undefined
  const intent = session?.changeIntent ?? selection?.changeIntent
  return typeof intent === 'string' ? intent : undefined
}

export function isReportOnlyCodingTask(codingState?: CodingRunState): boolean {
  return codingState?.taskKind === 'analysis_report'
    || NON_MUTATING_COMPLETION_INTENTS.has(getCodingCompletionIntent(codingState) || '')
}

export function evaluateReportOnlyCompletionEvidence(
  codingState?: CodingRunState,
  candidate: ReportOnlyCompletionCandidate = {},
): ReportOnlyCompletionEvidenceDecision {
  const evidence: string[] = []
  const issues: string[] = []

  if (!codingState) {
    issues.push('coding state is missing')
    return { ok: false, evidence, issues }
  }

  if (!isReportOnlyCodingTask(codingState)) {
    issues.push('task is not marked as analysis/report-only')
  }

  const summary = candidate.summary ?? codingState.lastCodingReport?.summary ?? ''
  if (summary.trim().length < 20) {
    issues.push('final report summary is too short to audit')
  }
  else {
    evidence.push('report_summary')
  }

  const hasRecentReadEvidence = codingState.recentReads.length > 0
  const hasRecentSearchEvidence = codingState.recentSearches.length > 0
  if (hasRecentReadEvidence) {
    evidence.push(`recent_reads:${codingState.recentReads.length}`)
  }
  if (hasRecentSearchEvidence) {
    evidence.push(`recent_searches:${codingState.recentSearches.length}`)
  }

  const compressedContext = codingState.lastCompressedContext
  const hasCompressedContext = Boolean(
    compressedContext
    && hasMeaningfulText(compressedContext.goal)
    && (
      hasMeaningfulText(compressedContext.filesSummary)
      || hasMeaningfulText(compressedContext.recentResultSummary)
      || hasMeaningfulText(compressedContext.unresolvedIssues)
      || hasMeaningfulText(compressedContext.nextStepRecommendation)
    ),
  )
  if (hasCompressedContext) {
    evidence.push('compressed_context')
  }

  const impact = codingState.lastImpactAnalysis
  const hasImpactAnalysis = Boolean(
    impact
    && (
      hasMeaningfulText(impact.explanation)
      || impact.targetCandidates.length > 0
      || impact.directReferences.length > 0
      || impact.importExportNeighbors.length > 0
      || impact.likelyCompanionFiles.length > 0
      || impact.likelyImpactedTests.length > 0
    ),
  )
  if (hasImpactAnalysis) {
    evidence.push(`impact_analysis:${impact?.status || 'unknown'}`)
  }

  const investigation = codingState.lastInvestigation
  const hasInvestigation = Boolean(
    investigation
    && hasMeaningfulText(investigation.summary)
    && investigation.evidence.length > 0,
  )
  if (hasInvestigation) {
    evidence.push(`investigation:${investigation?.trigger || 'unknown'}`)
  }

  const hasSourceEvidence = hasRecentReadEvidence || hasRecentSearchEvidence || hasImpactAnalysis
  if (!hasSourceEvidence) {
    issues.push('no read/search/impact evidence is available')
  }

  const hasStructuredArtifact = hasCompressedContext || hasImpactAnalysis || hasInvestigation
  if (!hasStructuredArtifact) {
    issues.push('no structured analysis/report artifact is available')
  }

  return {
    ok: issues.length === 0,
    evidence,
    issues,
  }
}

export function isReportOnlyCompletedReport(codingState?: CodingRunState): boolean {
  if (codingState?.lastCodingReport?.status !== 'completed') {
    return false
  }

  if (codingState.lastCodingReport.filesTouched.length > 0) {
    return false
  }

  return evaluateReportOnlyCompletionEvidence(codingState).ok
}

function hasMeaningfulText(value?: string): boolean {
  if (!value) {
    return false
  }

  const normalized = value.trim().toLowerCase()
  return normalized.length > 0
    && normalized !== 'auto'
    && normalized !== 'none'
    && normalized !== 'n/a'
    && normalized !== 'no tracked file activity.'
    && normalized !== 'no commands run.'
}
