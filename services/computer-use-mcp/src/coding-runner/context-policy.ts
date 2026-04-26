import type { RuntimePruningPolicy } from '../projection/types'
import type { TranscriptRetentionLimits } from '../transcript/retention'

import { DEFAULT_TRANSCRIPT_RETENTION_LIMITS } from '../transcript/retention'

export interface CodingTurnOperationalTracePolicy {
  intactTraceEventLimit: number
  maxResultLengthBeforeSoftTruncation: number
}

export interface CodingTurnContextPolicy {
  recentTraceEntryLimit: number
  operationalTrace: CodingTurnOperationalTracePolicy
  transcriptRetention: TranscriptRetentionLimits
}

export interface CodingTurnContextPolicyOverrides {
  recentTraceEntryLimit?: number
  operationalTrace?: Partial<CodingTurnOperationalTracePolicy>
  transcriptRetention?: Partial<TranscriptRetentionLimits>
}

export const DEFAULT_CODING_TURN_CONTEXT_POLICY = {
  recentTraceEntryLimit: 50,
  operationalTrace: {
    intactTraceEventLimit: 8,
    maxResultLengthBeforeSoftTruncation: 12000,
  },
  transcriptRetention: DEFAULT_TRANSCRIPT_RETENTION_LIMITS,
} as const satisfies CodingTurnContextPolicy

export function resolveCodingTurnContextPolicy(
  overrides: CodingTurnContextPolicyOverrides = {},
): CodingTurnContextPolicy {
  return {
    recentTraceEntryLimit: normalizeLimit(
      overrides.recentTraceEntryLimit,
      DEFAULT_CODING_TURN_CONTEXT_POLICY.recentTraceEntryLimit,
    ),
    operationalTrace: {
      intactTraceEventLimit: normalizeLimit(
        overrides.operationalTrace?.intactTraceEventLimit,
        DEFAULT_CODING_TURN_CONTEXT_POLICY.operationalTrace.intactTraceEventLimit,
      ),
      maxResultLengthBeforeSoftTruncation: normalizeLimit(
        overrides.operationalTrace?.maxResultLengthBeforeSoftTruncation,
        DEFAULT_CODING_TURN_CONTEXT_POLICY.operationalTrace.maxResultLengthBeforeSoftTruncation,
      ),
    },
    transcriptRetention: {
      maxFullToolBlocks: normalizeLimit(
        overrides.transcriptRetention?.maxFullToolBlocks,
        DEFAULT_TRANSCRIPT_RETENTION_LIMITS.maxFullToolBlocks,
      ),
      maxFullTextBlocks: normalizeLimit(
        overrides.transcriptRetention?.maxFullTextBlocks,
        DEFAULT_TRANSCRIPT_RETENTION_LIMITS.maxFullTextBlocks,
      ),
      maxCompactedBlocks: normalizeLimit(
        overrides.transcriptRetention?.maxCompactedBlocks,
        DEFAULT_TRANSCRIPT_RETENTION_LIMITS.maxCompactedBlocks,
      ),
    },
  }
}

export function toRuntimePruningPolicy(
  policy: CodingTurnOperationalTracePolicy,
): RuntimePruningPolicy {
  return {
    ...policy,
    // Coding runner task memory and system safety prompt are not budget knobs.
    pinSystemHeader: true,
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined)
    return fallback
  if (!Number.isFinite(value))
    return fallback
  return Math.max(0, Math.floor(value))
}
