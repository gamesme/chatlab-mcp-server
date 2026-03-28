import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

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
