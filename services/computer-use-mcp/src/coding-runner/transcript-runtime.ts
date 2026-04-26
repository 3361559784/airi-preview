import type { ArchiveCandidate } from '../archived-context/types'
import type { ComputerUseServerRuntime } from '../server/runtime'
import type { TranscriptProjectionResult } from '../transcript/types'

import { join } from 'node:path'

import { buildArchiveCandidates } from '../archived-context/candidates'
import { ArchiveContextStore } from '../archived-context/store'
import { projectContext } from '../projection/context-projector'
import { projectTranscript } from '../transcript/projector'
import { InMemoryTranscriptStore, TranscriptStore } from '../transcript/store'

export interface CodingTranscriptRuntime {
  store: TranscriptStore
  archiveStore: ArchiveContextStore
}

export interface CodingTurnProjection extends TranscriptProjectionResult {
  archiveCandidates: ArchiveCandidate[]
}

const CODING_TRANSCRIPT_PROJECTION_LIMITS = {
  maxFullToolBlocks: 5,
  maxFullTextBlocks: 3,
  maxCompactedBlocks: 4,
} as const

export async function createTranscriptRuntime(
  runtime: ComputerUseServerRuntime,
  runId: string,
  useInMemory = false,
): Promise<CodingTranscriptRuntime> {
  const store = useInMemory
    ? new InMemoryTranscriptStore()
    : new TranscriptStore(join(runtime.config.sessionRoot, 'transcript.jsonl'))
  await store.init()

  const archiveRoot = join(runtime.config.sessionRoot, 'archived-context')
  const archiveStore = new ArchiveContextStore(archiveRoot)
  // V1: task_id = run_id
  await archiveStore.init(runId, runId)

  return { store, archiveStore }
}

export function projectForCodingTurn(
  store: TranscriptStore,
  systemPromptBase: string,
  runtime: ComputerUseServerRuntime,
): CodingTurnProjection {
  const transcriptEntries = store.getAll()
  const { systemHeader, prunedTrace } = projectContext({
    trace: runtime.session.getRecentTrace(50),
    runState: runtime.stateManager.getState(),
    systemPromptBase,
    taskMemoryString: runtime.taskMemory.toContextString(),
  })

  const systemWithOperationalTrace = prunedTrace.length > 0
    ? `${systemHeader}\n\n【Recent Operational Trace】\n${JSON.stringify(prunedTrace, null, 2)}`
    : systemHeader

  const projection = projectTranscript(transcriptEntries, {
    systemPromptBase: systemWithOperationalTrace,
    ...CODING_TRANSCRIPT_PROJECTION_LIMITS,
  })

  return {
    ...projection,
    archiveCandidates: buildArchiveCandidates(transcriptEntries, CODING_TRANSCRIPT_PROJECTION_LIMITS),
  }
}
