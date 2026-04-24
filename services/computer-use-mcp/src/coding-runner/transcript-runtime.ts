import { join } from 'node:path'

import type { ComputerUseServerRuntime } from '../server/runtime'

import { ArchiveContextStore } from '../archived-context/store'
import { projectTranscript } from '../transcript/projector'
import { InMemoryTranscriptStore, TranscriptStore } from '../transcript/store'

export interface CodingTranscriptRuntime {
  store: TranscriptStore
  archiveStore: ArchiveContextStore
}

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
) {
  return projectTranscript(
    store.getAll(),
    {
      systemPromptBase,
      taskMemoryString: runtime.taskMemory.toContextString(),
      runState: runtime.stateManager.getState(),
      operationalTrace: runtime.session.getRecentTrace(50),
      maxFullToolBlocks: 5,
      maxFullTextBlocks: 3,
      maxCompactedBlocks: 4,
    },
  )
}
