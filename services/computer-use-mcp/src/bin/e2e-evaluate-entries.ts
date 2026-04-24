import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { mkdtemp, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'

import { registerComputerUseTools } from '../server/register-tools'
import { createRuntimeCoordinator } from '../server/runtime-coordinator'
import { initializeGlobalRegistry } from '../server/tool-descriptors'
import { RunStateManager } from '../state'
import { createTestConfig } from '../test-fixtures'
import { generateText } from '@xsai/generate-text'

// Add basic scaffolding...
console.log("Evaluation script scaffold created.")
