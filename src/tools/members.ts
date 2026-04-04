import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'
import { formatMembersAsText } from '../format.js'

export async function getMembers(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: string,
  format: 'json' | 'text' = 'text'
): Promise<string> {
  const res: any = await client.get(`/api/v1/sessions/${sessionId}/members`)

  if (format === 'text') {
    const members = res.data || []
    return formatMembersAsText(members)
  }

  const cleaned = { ...res, data: res.data?.map(({ avatar, aliases, id, ...m }: any) => m) }
  return JSON.stringify(cleaned, null, 2)
}

export function registerMembersTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_members',
    'Lists all members in a session with their platformId, name, and role. Returns plain text by default (set format=json for JSON).',
    {
      session_id: z.string().describe('Session ID'),
      format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
    },
    async ({ session_id, format = 'text' }) => {
      try {
        return { content: [{ type: 'text' as const, text: await getMembers(client, session_id, format) }] }
      } catch (e) {
        return toolError(e, session_id)
      }
    }
  )
}
