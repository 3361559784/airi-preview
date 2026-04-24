import process from 'node:process'
import { env } from 'node:process'

import { createExecuteAction } from '../server/action-executor'
import { createRuntime } from '../server/runtime'
import { createCodingRunner, createDefaultCodingRunnerConfig } from '../coding-runner'

async function main() {
  const taskGoal = process.argv.slice(2).join(' ') || 'Report the workspace status.'

  const config = createDefaultCodingRunnerConfig()

  console.log(`Starting coding runner with model ${config.model} in ${process.cwd()}`)
  console.log(`Task Goal: ${taskGoal}\n`)

  const runtime = await createRuntime()
  const executeAction = createExecuteAction(runtime)

  const runner = createCodingRunner(config, { runtime, executeAction })

  const result = await runner.runCodingTask({
    workspacePath: process.cwd(),
    taskGoal,
  })

  console.log('\n--- Runner Execution Finished ---\n')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('CRITICAL ERROR in coding-runner:', err)
  process.exit(1)
})
