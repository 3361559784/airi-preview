import type {
  ContextProjector,
  ProjectedContext,
  ProjectedOperationalTrace,
  ProjectionInput,
  RuntimePruningPolicy,
} from './types'

import type { SessionTraceEntry } from '../types'

const DEFAULT_POLICY: RuntimePruningPolicy = {
  intactTraceEventLimit: 8,
  maxResultLengthBeforeSoftTruncation: 12000,
  pinSystemHeader: true,
}

/**
 * Maps a single SessionTraceEntry into a ProjectedOperationalTrace.
 */
function mapTraceEntry(entry: SessionTraceEntry, index: number): ProjectedOperationalTrace {
  return {
    index,
    event: entry.event,
    toolName: entry.toolName,
    actionPayload: entry.action?.input as Record<string, unknown> | undefined,
    resultPayload: entry.result,
    pruned: false,
  }
}

export const projectContext: ContextProjector = (
  input: ProjectionInput,
  policyOverrides?: Partial<RuntimePruningPolicy>
): ProjectedContext => {
  const policy: RuntimePruningPolicy = { ...DEFAULT_POLICY, ...policyOverrides }

  let originalTraceLength = input.trace.length
  let prunedTraceEvents = 0
  let systemHeader = ''

  // 1. Header Pinning
  if (policy.pinSystemHeader) {
    const parts: string[] = []

    if (input.systemPromptBase) {
      parts.push(input.systemPromptBase)
    }

    if (input.runState) {
      const budget = input.runState.coding?.currentPlan?.steps?.length ? 'Active Plan' : 'No Active Plan'
      parts.push(`【Run State Summary】\nExecution Mode: ${input.runState.executionTarget?.mode ?? 'unknown'}\nStatus: ${budget}`)
    }

    if (input.taskMemoryString) {
      parts.push(`【Current Task Memory】\n${input.taskMemoryString}`)
    }

    systemHeader = parts.join('\n\n---\n\n')
  }

  // 2. Operational Trace Extraction
  // We process the trace backwards to retain the N most recent intact.
  const mappedMessages = input.trace.map(mapTraceEntry)
  const processedTrace: ProjectedOperationalTrace[] = []
  
  let intactEventCount = 0

  for (let i = mappedMessages.length - 1; i >= 0; i--) {
    const msg = { ...mappedMessages[i] }
    intactEventCount++

    if (intactEventCount > policy.intactTraceEventLimit) {
      // Soft truncate the result payload and action payload for old events
      msg.actionPayload = undefined
      msg.resultPayload = undefined
      msg.summary = `[Event ${msg.event} trace pruned]`
      msg.pruned = true
      prunedTraceEvents++
    } else if (msg.resultPayload) {
      // Check length of result payload to avoid massive blowouts even in intact window
      const resultStr = JSON.stringify(msg.resultPayload)
      if (resultStr.length > policy.maxResultLengthBeforeSoftTruncation) {
        msg.resultPayload = undefined
        msg.summary = `[Payload truncated due to length > ${policy.maxResultLengthBeforeSoftTruncation}]`
        msg.pruned = true
        prunedTraceEvents++
      }
    }

    processedTrace.unshift(msg)
  }

  // Token estimate roughly based on 4 chars per token length
  // We stringify the trace.
  const stringifiedLens = systemHeader.length + processedTrace.reduce((acc, msg) => {
    return acc 
      + msg.event.length
      + (msg.toolName?.length || 0)
      + (msg.summary?.length || 0)
      + JSON.stringify(msg.actionPayload || {}).length
      + JSON.stringify(msg.resultPayload || {}).length
  }, 0)

  return {
    systemHeader,
    prunedTrace: processedTrace,
    metadata: {
      originalTraceLength,
      prunedTraceEvents,
      estimatedTokens: Math.ceil(stringifiedLens / 4)
    }
  }
}
