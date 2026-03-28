import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

export async function getMembers(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: string
): Promise<string> {
  const res: any = await client.get(`/api/v1/sessions/${sessionId}/members`)
  const cleaned = { ...res, data: res.data?.map(({ avatar, aliases, ...m }: any) => m) }
  return JSON.stringify(cleaned, null, 2)
}

export function registerMembersTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_members',
    'Lists all members in a session with their platformId, name, and role.',
    { session_id: z.string().describe('Session ID') },
    async ({ session_id }) => {
      try {
        return { content: [{ type: 'text' as const, text: await getMembers(client, session_id) }] }
      } catch (e) {
        return toolError(e, session_id)
      }
    }
  )
}
