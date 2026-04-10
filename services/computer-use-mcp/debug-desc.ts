import { requireDescriptor } from './src/server/tool-descriptors'

async function main() {
  const desc = requireDescriptor('desktop_get_state')
  console.log('desktop_get_state defaultDeferred:', desc.defaultDeferred)
}

main().catch(console.error)
