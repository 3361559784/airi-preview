/**
 * Eval-only map from observed live-provider failure text to deterministic replay
 * buckets. This is not runner authority and must not be used to decide runtime
 * completion, verification, or tool access.
 */
export type CodingLiveFailureClass
  = | 'archive_recall_finalization'
    | 'completion_denied_missing_mutation_proof'
    | 'cwd_terminal_detour'
    | 'provider_capacity_or_latency'
    | 'report_only_text_final'
    | 'report_only_tool_adherence'
    | 'report_only_verification_gate'
    | 'shell_misuse_recovery'
    | 'stalled_exploration_governor'
    | 'unknown'

export type CodingLiveFailureDisposition
  = | 'deterministic_replay_first'
    | 'provider_observation_only'
    | 'runtime_follow_up_if_repeated'

export interface CodingLiveFailureClassification {
  failureClass: CodingLiveFailureClass
  disposition: CodingLiveFailureDisposition
  summary: string
}

export interface CodingLiveFailureReplayCase {
  id: string
  failureClass: Exclude<CodingLiveFailureClass, 'unknown'>
  disposition: CodingLiveFailureDisposition
  observedSignal: string
  deterministicAnchor: string
  nextFollowUp: string
  sample: string
}

export const CODING_LIVE_FAILURE_REPLAY_CORPUS = [
  {
    id: 'text-only-final',
    failureClass: 'report_only_text_final',
    disposition: 'runtime_follow_up_if_repeated',
    observedSignal: 'TEXT_ONLY_FINAL after model answered with natural-language completion summary.',
    deterministicAnchor: 'src/coding-runner/coding-runner.test.ts final text-only correction cases',
    nextFollowUp: 'fix(coding-runner): recover once from text-only final',
    sample: 'TEXT_ONLY_FINAL: coding runner ended without an accepted terminal report. lastAssistant=Everything is done.',
  },
  {
    id: 'report-only-unavailable-tool',
    failureClass: 'report_only_tool_adherence',
    disposition: 'runtime_follow_up_if_repeated',
    observedSignal: 'Report-only correction requested a tool outside the exposed tool surface.',
    deterministicAnchor: 'src/coding-runner/coding-runner.test.ts report-only unavailable tool cases',
    nextFollowUp: 'fix(computer-use-mcp): harden fake-completion soak tool-adherence reporting',
    sample: 'TEXT_ONLY_FINAL: report-only correction requested an unavailable tool. lastError=Model tried to call unavailable tool "Bash", Available tools: coding_report_status.',
  },
  {
    id: 'archive-recall-denied-finalization',
    failureClass: 'archive_recall_finalization',
    disposition: 'runtime_follow_up_if_repeated',
    observedSignal: 'Analysis/report guessed an archive artifact id after a no-hit search and hit latest-search-only denial.',
    deterministicAnchor: 'src/coding-runner/coding-runner.test.ts archive recall finalization cases',
    nextFollowUp: 'fix(coding-runner): recover analysis report after archive recall denial',
    sample: 'ARCHIVE_RECALL_DENIED: artifact was not returned by the latest archive search: 0-2-compacted.md',
  },
  {
    id: 'wrong-cwd-terminal-detour',
    failureClass: 'cwd_terminal_detour',
    disposition: 'deterministic_replay_first',
    observedSignal: 'Model executed a terminal command from the wrong cwd, then recovered with fixture-scoped evidence.',
    deterministicAnchor: 'src/coding-runner/coding-runner.test.ts wrong-cwd terminal detour case',
    nextFollowUp: 'test(computer-use-mcp): cover coding provider cwd recovery noise',
    sample: 'terminal_exec({ command: "cat index.ts", cwd: "/Users/liuziheng/airi" }) failed: cat: index.ts: No such file or directory',
  },
  {
    id: 'stalled-read-search',
    failureClass: 'stalled_exploration_governor',
    disposition: 'deterministic_replay_first',
    observedSignal: 'Model repeated read/search exploration without state advancement until the governor fired.',
    deterministicAnchor: 'src/bin/e2e-coding-governor-xsai-soak.test.ts stalled-read and stalled-search cases',
    nextFollowUp: 'test(computer-use-mcp): expand coding governor replay scenarios',
    sample: 'ANALYSIS LIMIT WARNING: You have performed 8 consecutive stalled explorations.',
  },
  {
    id: 'report-only-bad-faith',
    failureClass: 'report_only_verification_gate',
    disposition: 'runtime_follow_up_if_repeated',
    observedSignal: 'Report-only analysis was blocked by verification_bad_faith despite source-discovery evidence.',
    deterministicAnchor: 'src/coding/verification-gate.test.ts report-only source discovery probes',
    nextFollowUp: 'fix(coding-runner): allow report-only source discovery probes',
    sample: 'Verification Gate blocked completion. reason=verification_bad_faith',
  },
  {
    id: 'missing-mutation-proof',
    failureClass: 'completion_denied_missing_mutation_proof',
    disposition: 'runtime_follow_up_if_repeated',
    observedSignal: 'Model reported completion without mutation proof or touched files.',
    deterministicAnchor: 'src/coding-runner/coding-runner.test.ts auto filesTouched proof recovery case',
    nextFollowUp: 'fix(coding-runner): recover after missing mutation proof denial',
    sample: 'Completion Denied: missing_mutation_proof',
  },
  {
    id: 'shell-misuse',
    failureClass: 'shell_misuse_recovery',
    disposition: 'runtime_follow_up_if_repeated',
    observedSignal: 'Model attempted dangerous shell mutation and had to recover through coding_apply_patch.',
    deterministicAnchor: 'src/bin/evaluate-coding-entries.ts shell misuse recovery scenario',
    nextFollowUp: 'fix(coding-runner): tighten shell misuse recovery if repeated',
    sample: 'SHELL_COMMAND_DENIED: dangerous_file_mutation',
  },
  {
    id: 'provider-capacity-latency',
    failureClass: 'provider_capacity_or_latency',
    disposition: 'provider_observation_only',
    observedSignal: 'Provider returned quota/capacity/latency failure after request-shape compatibility was established.',
    deterministicAnchor: 'coding-provider-eval-observations.md provider matrix notes',
    nextFollowUp: 'docs(computer-use-mcp): record provider matrix observation',
    sample: 'Remote sent 429 response: {"error":{"code":"model_price_error","message":"upstream load saturated"}}',
  },
] as const satisfies readonly CodingLiveFailureReplayCase[]

export function classifyCodingLiveFailureText(input: string): CodingLiveFailureClassification {
  const text = input.trim()
  const lower = text.toLowerCase()

  if (!text) {
    return {
      failureClass: 'unknown',
      disposition: 'deterministic_replay_first',
      summary: 'No failure text was provided.',
    }
  }

  if (
    lower.includes('429')
    || lower.includes('too many requests')
    || lower.includes('model_price_error')
    || lower.includes('upstream load')
    || lower.includes('step_timeout')
  ) {
    return {
      failureClass: 'provider_capacity_or_latency',
      disposition: 'provider_observation_only',
      summary: 'Provider capacity, rate-limit, or latency failure; do not map to runner correctness without a non-provider failure body.',
    }
  }

  if (lower.includes('tried to call unavailable tool') && lower.includes('available tools:')) {
    return {
      failureClass: 'report_only_tool_adherence',
      disposition: 'runtime_follow_up_if_repeated',
      summary: 'The model requested a tool outside the current correction surface.',
    }
  }

  if (lower.includes('archive_recall_denied') || lower.includes('archive_recall_finalization_failed')) {
    return {
      failureClass: 'archive_recall_finalization',
      disposition: 'runtime_follow_up_if_repeated',
      summary: 'Archive recall denial should stay enforced; recovery belongs in analysis/report finalization.',
    }
  }

  if (lower.includes('text_only_final')) {
    return {
      failureClass: 'report_only_text_final',
      disposition: 'runtime_follow_up_if_repeated',
      summary: 'The assistant ended with text instead of an accepted coding_report_status call.',
    }
  }

  if (lower.includes('verification_bad_faith')) {
    return {
      failureClass: 'report_only_verification_gate',
      disposition: 'runtime_follow_up_if_repeated',
      summary: 'Verification gate blocked completion; inspect task kind and evidence path before changing prompts.',
    }
  }

  if (lower.includes('missing_mutation_proof') || lower.includes('completion denied')) {
    return {
      failureClass: 'completion_denied_missing_mutation_proof',
      disposition: 'runtime_follow_up_if_repeated',
      summary: 'Completion was denied because runtime mutation proof was missing or insufficient.',
    }
  }

  if (lower.includes('dangerous_file_mutation') || lower.includes('shell_command_denied')) {
    return {
      failureClass: 'shell_misuse_recovery',
      disposition: 'runtime_follow_up_if_repeated',
      summary: 'Shell mutation was denied; recovery should use coding_apply_patch and validation, not shell fallback tools.',
    }
  }

  if (lower.includes('analysis limit warning') || lower.includes('analysis limit exceeded')) {
    return {
      failureClass: 'stalled_exploration_governor',
      disposition: 'deterministic_replay_first',
      summary: 'The exploration governor fired after repeated stalled reads/searches.',
    }
  }

  if (
    lower.includes('no such file or directory')
    || lower.includes('wrong-cwd')
    || lower.includes('terminalstate.effectivecwd')
  ) {
    return {
      failureClass: 'cwd_terminal_detour',
      disposition: 'deterministic_replay_first',
      summary: 'Wrong-cwd terminal noise should be reproduced as a deterministic detour before runtime changes.',
    }
  }

  return {
    failureClass: 'unknown',
    disposition: 'deterministic_replay_first',
    summary: 'Unmapped coding live failure; create a deterministic replay before changing runtime behavior.',
  }
}
