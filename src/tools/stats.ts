import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function getStatsOverview(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: number
): Promise<string> {
  const stats = await client.get(`/api/v1/sessions/${sessionId}/stats/overview`)
  return JSON.stringify(stats, null, 2)
}

export function registerStatsTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_stats_overview',
    'Returns statistical overview of a session: message counts, active members, time distribution.',
    { session_id: z.number().describe('Session ID') },
    async ({ session_id }) => {
      try {
        return {
          content: [{ type: 'text' as const, text: await getStatsOverview(client, session_id) }],
        }
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
