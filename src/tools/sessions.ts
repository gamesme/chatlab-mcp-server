import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'
import { formatSessionsAsText, formatSessionAsText } from '../format.js'

function stripSession(s: any): object {
  const { groupAvatar, memberAvatar, dbPath, groupId, ownerId, importedAt, summaryCount, aiConversationCount, ...rest } = s
  return rest
}

export async function listSessions(
  client: Pick<ChatLabClient, 'get'>,
  format: 'json' | 'text' = 'text'
): Promise<string> {
  const res: any = await client.get('/api/v1/sessions')

  if (format === 'text') {
    const sessions = res.data || []
    return formatSessionsAsText(sessions)
  }

  const cleaned = { ...res, data: res.data?.map(stripSession) }
  return JSON.stringify(cleaned, null, 2)
}

export async function getSession(
  client: Pick<ChatLabClient, 'get'>,
  id: string,
  format: 'json' | 'text' = 'text'
): Promise<string> {
  const res: any = await client.get(`/api/v1/sessions/${id}`)

  if (format === 'text') {
    return formatSessionAsText(res.data)
  }

  const cleaned = { ...res, data: stripSession(res.data) }
  return JSON.stringify(cleaned, null, 2)
}

export function registerSessionTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'list_sessions',
    'Lists all imported chat sessions with name, platform, message count, and time range. Returns plain text by default (set format=json for JSON).',
    {
      format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
    },
    async ({ format = 'text' }) => {
      try {
        return { content: [{ type: 'text' as const, text: await listSessions(client, format) }] }
      } catch (e) {
        return toolError(e)
      }
    }
  )

  server.tool(
    'get_session',
    'Gets full details of a single session by ID. Returns plain text by default (set format=json for JSON).',
    {
      id: z.string().describe('Session ID'),
      format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
    },
    async ({ id, format = 'text' }) => {
      try {
        return { content: [{ type: 'text' as const, text: await getSession(client, id, format) }] }
      } catch (e) {
        return toolError(e, id)
      }
    }
  )
}
