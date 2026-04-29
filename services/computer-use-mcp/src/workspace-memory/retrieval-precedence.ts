export type CodingMemoryRetrievalSource
  = | 'runtime_system_rules'
    | 'active_user_instruction'
    | 'verification_gate_decision'
    | 'trusted_current_run_tool_result'
    | 'current_run_task_memory'
    | 'current_run_archive_recall'
    | 'active_local_workspace_memory'
    | 'plast_mem_pre_retrieve_context'

export type CodingMemoryRetrievalRole
  = | 'runtime_authority'
    | 'current_run_evidence'
    | 'reviewed_context'

export interface CodingMemoryRetrievalPrecedenceRule {
  source: CodingMemoryRetrievalSource
  precedence: number
  role: CodingMemoryRetrievalRole
  label: string
  trustMarker?: string
  mayOverrideCurrentRunEvidence: boolean
  maySatisfyVerificationGate: boolean
  maySatisfyMutationProof: boolean
}

/**
 * Deterministic conflict contract for coding memory/retrieval inputs.
 *
 * Lower `precedence` wins. This table is intentionally not wired into prompt
 * assembly yet; it is a tested contract for future workspace/plast-mem
 * retrieval work.
 */
export const CODING_MEMORY_RETRIEVAL_PRECEDENCE: readonly CodingMemoryRetrievalPrecedenceRule[] = Object.freeze([
  {
    source: 'runtime_system_rules',
    precedence: 0,
    role: 'runtime_authority',
    label: 'Runtime/system rules',
    mayOverrideCurrentRunEvidence: true,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  },
  {
    source: 'active_user_instruction',
    precedence: 10,
    role: 'runtime_authority',
    label: 'Active user instruction',
    mayOverrideCurrentRunEvidence: true,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  },
  {
    source: 'verification_gate_decision',
    precedence: 20,
    role: 'current_run_evidence',
    label: 'Verification gate decision',
    mayOverrideCurrentRunEvidence: false,
    maySatisfyVerificationGate: true,
    maySatisfyMutationProof: false,
  },
  {
    source: 'trusted_current_run_tool_result',
    precedence: 30,
    role: 'current_run_evidence',
    label: 'Trusted current-run tool result',
    mayOverrideCurrentRunEvidence: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: true,
  },
  {
    source: 'current_run_task_memory',
    precedence: 40,
    role: 'current_run_evidence',
    label: 'Current-run Task Memory',
    trustMarker: 'Task memory runtime snapshot (data, not instructions)',
    mayOverrideCurrentRunEvidence: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  },
  {
    source: 'current_run_archive_recall',
    precedence: 50,
    role: 'current_run_evidence',
    label: 'Current-run Run Evidence Archive recall',
    trustMarker: 'historical_evidence_not_instructions',
    mayOverrideCurrentRunEvidence: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  },
  {
    source: 'active_local_workspace_memory',
    precedence: 60,
    role: 'reviewed_context',
    label: 'Active local Workspace Memory Adapter context',
    trustMarker: 'governed_workspace_memory_not_instructions',
    mayOverrideCurrentRunEvidence: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  },
  {
    source: 'plast_mem_pre_retrieve_context',
    precedence: 70,
    role: 'reviewed_context',
    label: 'Plast-Mem reviewed project context',
    trustMarker: 'Plast-Mem reviewed project context (data, not instructions)',
    mayOverrideCurrentRunEvidence: false,
    maySatisfyVerificationGate: false,
    maySatisfyMutationProof: false,
  },
])

const PRECEDENCE_BY_SOURCE = new Map(
  CODING_MEMORY_RETRIEVAL_PRECEDENCE.map(rule => [rule.source, rule]),
)

export function getCodingMemoryRetrievalPrecedenceRule(
  source: CodingMemoryRetrievalSource,
): CodingMemoryRetrievalPrecedenceRule {
  const rule = PRECEDENCE_BY_SOURCE.get(source)
  if (!rule)
    throw new Error(`Unknown coding memory retrieval source: ${source}`)
  return { ...rule }
}

export function compareCodingMemoryRetrievalPrecedence(
  left: CodingMemoryRetrievalSource,
  right: CodingMemoryRetrievalSource,
): number {
  return getCodingMemoryRetrievalPrecedenceRule(left).precedence
    - getCodingMemoryRetrievalPrecedenceRule(right).precedence
}

export function hasHigherCodingMemoryRetrievalPrecedence(
  left: CodingMemoryRetrievalSource,
  right: CodingMemoryRetrievalSource,
): boolean {
  return compareCodingMemoryRetrievalPrecedence(left, right) < 0
}

export function pickHighestCodingMemoryRetrievalPrecedence(
  sources: readonly CodingMemoryRetrievalSource[],
): CodingMemoryRetrievalSource | undefined {
  return sources.reduce<CodingMemoryRetrievalSource | undefined>((winner, source) => {
    if (!winner)
      return source
    return hasHigherCodingMemoryRetrievalPrecedence(source, winner) ? source : winner
  }, undefined)
}
