/**
 * Transcript Store — append-only truth source for LLM conversation messages.
 *
 * Persists to `transcript.jsonl` under the session root. Never mutates
 * or deletes existing entries. Prompt pruning is handled by the projection
 * layer, not the store.
 *
 * This store is completely independent from `audit.jsonl` (operational trace).
 */

import type { TranscriptEntry, TranscriptToolCall } from './types'

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class TranscriptStore {
  private entries: TranscriptEntry[] = []
  private nextId = 0
  private initialized = false

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.initialized)
      return

    await mkdir(dirname(this.filePath), { recursive: true })

    // Attempt to load existing transcript from disk
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const lines = raw.split('\n').filter(l => l.trim().length > 0)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as TranscriptEntry
          this.entries.push(entry)
          if (entry.id >= this.nextId) {
            this.nextId = entry.id + 1
          }
        }
        catch {
          // Skip malformed lines — defensive against partial writes
        }
      }
    }
    catch {
      // File doesn't exist yet — that's fine for a fresh session
    }

    this.initialized = true
  }

  /**
   * Append a user message to the transcript.
   */
  async appendUser(content: string): Promise<TranscriptEntry> {
    return this.append({ role: 'user', content })
  }

  /**
   * Append an assistant message (text-only, no tool calls).
   */
  async appendAssistantText(content: string): Promise<TranscriptEntry> {
    return this.append({ role: 'assistant', content })
  }

  /**
   * Append an assistant message that contains tool calls.
   */
  async appendAssistantToolCalls(
    toolCalls: TranscriptToolCall[],
    content?: string,
  ): Promise<TranscriptEntry> {
    return this.append({ role: 'assistant', content, toolCalls })
  }

  /**
   * Append a tool result message.
   */
  async appendToolResult(toolCallId: string, content: string): Promise<TranscriptEntry> {
    return this.append({ role: 'tool', content, toolCallId })
  }

  /**
   * Append a system message.
   */
  async appendSystem(content: string): Promise<TranscriptEntry> {
    return this.append({ role: 'system', content })
  }

  /**
   * Get all entries (full transcript). The store is the truth source;
   * the projection layer decides what subset to project into the prompt.
   */
  getAll(): readonly TranscriptEntry[] {
    return this.entries
  }

  /**
   * Get entries by id range (inclusive). Useful for targeted projection.
   */
  getRange(fromId: number, toId: number): TranscriptEntry[] {
    return this.entries.filter(e => e.id >= fromId && e.id <= toId)
  }

  /**
   * Get the total number of entries.
   */
  get length(): number {
    return this.entries.length
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async append(
    partial: Omit<TranscriptEntry, 'id' | 'at'>,
  ): Promise<TranscriptEntry> {
    const entry: TranscriptEntry = {
      ...partial,
      id: this.nextId++,
      at: new Date().toISOString(),
    }

    this.entries.push(entry)

    // Persist — append-only JSONL
    await this.persist(entry)

    return entry
  }

  /** Override in subclasses to skip or redirect I/O. */
  protected async persist(entry: TranscriptEntry): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8')
  }
}

// ---------------------------------------------------------------------------
// In-memory variant for testing (no disk I/O)
// ---------------------------------------------------------------------------

/**
 * A TranscriptStore that operates purely in memory.
 * Drop-in replacement for tests and soak runner mocks.
 */
export class InMemoryTranscriptStore extends TranscriptStore {
  constructor() {
    // Use a dummy path — init() and persist() are overridden to skip disk I/O
    super('/dev/null/transcript.jsonl')
  }

  override async init(): Promise<void> {
    // No-op: skip disk I/O entirely
  }

  protected override async persist(_entry: TranscriptEntry): Promise<void> {
    // No-op: skip disk persistence
  }
}
