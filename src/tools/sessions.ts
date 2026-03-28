import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function listSessions(client: Pick<ChatLabClient, 'get'>): Promise<string> {
  const sessions = await client.get('/api/v1/sessions')
  return JSON.stringify(sessions, null, 2)
}

export async function getSession(
  client: Pick<ChatLabClient, 'get'>,
  id: number
): Promise<string> {
  const session = await client.get(`/api/v1/sessions/${id}`)
  return JSON.stringify(session, null, 2)
}

function toolError(e: unknown, sessionId?: number): { content: [{ type: 'text'; text: string }]; isError: true } {
  let message: string
  if (e instanceof ChatLabError && e.status === 404 && sessionId !== undefined) {
    message = `Session not found: ${sessionId}`
  } else {
    message = e instanceof Error ? e.message : 'Unknown error'
  }
  return { content: [{ type: 'text' as const, text: message }], isError: true as const }
}

export function registerSessionTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'list_sessions',
    'Lists all imported chat sessions with name, platform, message count, and time range.',
    {},
    async () => {
      try {
        return { content: [{ type: 'text' as const, text: await listSessions(client) }] }
      } catch (e) {
        return toolError(e)
      }
    }
  )

  server.tool(
    'get_session',
    'Gets full details of a single session by ID.',
    { id: z.number().describe('Session ID') },
    async ({ id }) => {
      try {
        return { content: [{ type: 'text' as const, text: await getSession(client, id) }] }
      } catch (e) {
        return toolError(e, id)
      }
    }
  )
}
