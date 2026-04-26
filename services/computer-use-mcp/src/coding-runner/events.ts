import type { CodingRunnerEventEnvelope, CodingRunnerEventHandler } from './types'

export type CodingRunnerEventPayload<TKind extends CodingRunnerEventEnvelope['kind']>
  = Extract<CodingRunnerEventEnvelope, { kind: TKind }>['payload']

export interface CodingRunnerEventEmitter {
  emit: <TKind extends CodingRunnerEventEnvelope['kind']>(
    kind: TKind,
    payload: CodingRunnerEventPayload<TKind>,
  ) => Promise<void>
}

export function createCodingRunnerEventEmitter(
  runId: string,
  onEvent?: CodingRunnerEventHandler,
): CodingRunnerEventEmitter {
  let seq = 0

  return {
    async emit(kind, payload) {
      if (!onEvent)
        return

      const event = {
        runId,
        seq: seq++,
        at: new Date().toISOString(),
        kind,
        payload,
      } as CodingRunnerEventEnvelope

      await onEvent(event)
    },
  }
}
