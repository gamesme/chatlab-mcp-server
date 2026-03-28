import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ChatLabClient } from './client.js'
import { createServer } from './server.js'

function parseArgs(): { url: string; token: string } {
  const args = process.argv.slice(2)
  let url = process.env.CHATLAB_URL ?? 'http://127.0.0.1:5200'
  let token = process.env.CHATLAB_TOKEN ?? ''

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) url = args[++i]
    else if (args[i] === '--token' && args[i + 1]) token = args[++i]
  }

  if (!token) {
    process.stderr.write(
      'Error: CHATLAB_TOKEN is required. Set it via --token flag or CHATLAB_TOKEN env var.\n'
    )
    process.exit(1)
  }

  return { url, token }
}

async function main(): Promise<void> {
  const { url, token } = parseArgs()
  const client = new ChatLabClient(url, token)
  const server = createServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
