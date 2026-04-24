import { env } from 'node:process'
import type { CodingRunnerConfig } from './types'

export function createDefaultCodingRunnerConfig(): CodingRunnerConfig {
  return {
    model: env.AIRI_AGENT_MODEL || 'gpt-4o-mini',
    baseURL: env.AIRI_AGENT_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.AIRI_AGENT_API_KEY || '',
    systemPromptBase: env.AIRI_SYSTEM_PROMPT || 'You are an autonomous AI coding agent.',
    maxSteps: Number.parseInt(env.AIRI_MAX_STEPS || '15', 10),
    stepTimeoutMs: Number.parseInt(env.AIRI_STEP_TIMEOUT_MS || '60000', 10),
  }
}
