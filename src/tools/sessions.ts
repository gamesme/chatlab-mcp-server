import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

function stripSession(s: any): object {
  const { groupAvatar, dbPath, ...rest } = s
  return rest
}

export async function listSessions(client: Pick<ChatLabClient, 'get'>): Promise<string> {
  const res: any = await client.get('/api/v1/sessions')
  const cleaned = { ...res, data: res.data?.map(stripSession) }
  return JSON.stringify(cleaned, null, 2)
}

export async function getSession(
  client: Pick<ChatLabClient, 'get'>,
  id: string
): Promise<string> {
  const res: any = await client.get(`/api/v1/sessions/${id}`)
  const cleaned = { ...res, data: stripSession(res.data) }
  return JSON.stringify(cleaned, null, 2)
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
    { id: z.string().describe('Session ID') },
    async ({ id }) => {
      try {
        return { content: [{ type: 'text' as const, text: await getSession(client, id) }] }
      } catch (e) {
        return toolError(e, id)
      }
    }
  )
}
