import process from 'node:process'

import { createCodingRunner, createDefaultCodingRunnerConfig } from '../coding-runner'
import { createExecuteAction } from '../server/action-executor'
import { createRuntime } from '../server/runtime'

async function main() {
  const args = process.argv.slice(2)
  const emitEventsJsonl = args.includes('--events-jsonl')
  const taskGoal = args.filter(arg => arg !== '--events-jsonl').join(' ') || 'Report the workspace status.'

  const config = createDefaultCodingRunnerConfig()

  process.stdout.write(`Starting coding runner with model ${config.model} in ${process.cwd()}\n`)
  process.stdout.write(`Task Goal: ${taskGoal}\n\n`)

  const runtime = await createRuntime()
  const executeAction = createExecuteAction(runtime)

  const runner = createCodingRunner(config, { runtime, executeAction })

  const result = await runner.runCodingTask({
    workspacePath: process.cwd(),
    taskGoal,
    onEvent: emitEventsJsonl
      ? (event) => {
          process.stderr.write(`${JSON.stringify(event)}\n`)
        }
      : undefined,
  })

  process.stdout.write('\n--- Runner Execution Finished ---\n\n')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((err) => {
  console.error('CRITICAL ERROR in coding-runner:', err)
  process.exit(1)
})
