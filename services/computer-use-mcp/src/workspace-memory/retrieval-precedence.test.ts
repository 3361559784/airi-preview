import { describe, expect, it } from 'vitest'

import {
  CODING_MEMORY_RETRIEVAL_PRECEDENCE,
  compareCodingMemoryRetrievalPrecedence,
  getCodingMemoryRetrievalPrecedenceRule,
  hasHigherCodingMemoryRetrievalPrecedence,
  pickHighestCodingMemoryRetrievalPrecedence,
} from './retrieval-precedence'

describe('coding memory retrieval precedence contract', () => {
  it('defines a deterministic unique precedence order', () => {
    expect(CODING_MEMORY_RETRIEVAL_PRECEDENCE.map(rule => rule.source)).toEqual([
      'runtime_system_rules',
      'active_user_instruction',
      'verification_gate_decision',
      'trusted_current_run_tool_result',
      'current_run_task_memory',
      'current_run_archive_recall',
      'active_local_workspace_memory',
      'plast_mem_pre_retrieve_context',
    ])

    const precedences = CODING_MEMORY_RETRIEVAL_PRECEDENCE.map(rule => rule.precedence)
    expect(new Set(precedences).size).toBe(precedences.length)
    expect(precedences).toEqual([...precedences].sort((a, b) => a - b))
  })

  it('keeps current-run evidence above local and plast-mem retrieved context', () => {
    for (const currentRunSource of [
      'verification_gate_decision',
      'trusted_current_run_tool_result',
      'current_run_task_memory',
      'current_run_archive_recall',
    ] as const) {
      expect(hasHigherCodingMemoryRetrievalPrecedence(currentRunSource, 'active_local_workspace_memory')).toBe(true)
      expect(hasHigherCodingMemoryRetrievalPrecedence(currentRunSource, 'plast_mem_pre_retrieve_context')).toBe(true)
    }
  })

  it('keeps active local workspace memory above future plast-mem retrieved context', () => {
    expect(compareCodingMemoryRetrievalPrecedence(
      'active_local_workspace_memory',
      'plast_mem_pre_retrieve_context',
    )).toBeLessThan(0)
    expect(pickHighestCodingMemoryRetrievalPrecedence([
      'plast_mem_pre_retrieve_context',
      'active_local_workspace_memory',
    ])).toBe('active_local_workspace_memory')
  })

  it('does not let memory context satisfy verification or mutation proof gates', () => {
    for (const memorySource of [
      'current_run_task_memory',
      'current_run_archive_recall',
      'active_local_workspace_memory',
      'plast_mem_pre_retrieve_context',
    ] as const) {
      const rule = getCodingMemoryRetrievalPrecedenceRule(memorySource)
      expect(rule.maySatisfyVerificationGate).toBe(false)
      expect(rule.maySatisfyMutationProof).toBe(false)
      expect(rule.mayOverrideCurrentRunEvidence).toBe(false)
    }
  })

  it('records trust markers for every context memory source', () => {
    expect(getCodingMemoryRetrievalPrecedenceRule('current_run_task_memory').trustMarker).toContain('data, not instructions')
    expect(getCodingMemoryRetrievalPrecedenceRule('current_run_archive_recall').trustMarker).toBe('historical_evidence_not_instructions')
    expect(getCodingMemoryRetrievalPrecedenceRule('active_local_workspace_memory').trustMarker).toBe('governed_workspace_memory_not_instructions')
    expect(getCodingMemoryRetrievalPrecedenceRule('plast_mem_pre_retrieve_context').trustMarker).toBe('Plast-Mem reviewed project context (data, not instructions)')
  })

  it('keeps verification gates above tool evidence but requires tool evidence for mutation proof', () => {
    expect(hasHigherCodingMemoryRetrievalPrecedence(
      'verification_gate_decision',
      'trusted_current_run_tool_result',
    )).toBe(true)

    expect(getCodingMemoryRetrievalPrecedenceRule('verification_gate_decision')).toMatchObject({
      maySatisfyVerificationGate: true,
      maySatisfyMutationProof: false,
    })
    expect(getCodingMemoryRetrievalPrecedenceRule('trusted_current_run_tool_result')).toMatchObject({
      maySatisfyVerificationGate: false,
      maySatisfyMutationProof: true,
    })
  })

  it('returns defensive rule copies', () => {
    const rule = getCodingMemoryRetrievalPrecedenceRule('active_local_workspace_memory')
    rule.precedence = -1

    expect(getCodingMemoryRetrievalPrecedenceRule('active_local_workspace_memory').precedence).toBe(60)
  })
})
