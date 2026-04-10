import { createComputerUseMcpServer } from './src/server'

async function main() {
  const { server } = await createComputerUseMcpServer()
  const tools = (server as any)._registeredTools || {}
  const toolNames = Object.keys(tools)
  console.log('Registered Tools Count:', toolNames.length)
  console.log('Includes desktop_get_state?', toolNames.includes('desktop_get_state'))
  
  if (!toolNames.includes('desktop_get_state')) {
    console.log('What happened to desktop_get_state?')
  }
}

main().catch(console.error)
