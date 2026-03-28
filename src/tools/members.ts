import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function getMembers(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: number
): Promise<string> {
  const members = await client.get(`/api/v1/sessions/${sessionId}/members`)
  return JSON.stringify(members, null, 2)
}

export function registerMembersTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_members',
    'Lists all members in a session with their platformId, name, and role.',
    { session_id: z.number().describe('Session ID') },
    async ({ session_id }) => {
      try {
        return { content: [{ type: 'text' as const, text: await getMembers(client, session_id) }] }
      } catch (e) {
        const message =
          e instanceof ChatLabError && e.status === 404
            ? `Session not found: ${session_id}`
            : e instanceof Error
              ? e.message
              : 'Unknown error'
        return { content: [{ type: 'text' as const, text: message }], isError: true as const }
      }
    }
  )
}
