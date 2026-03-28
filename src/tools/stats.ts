import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

export async function getStatsOverview(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: string
): Promise<string> {
  const stats = await client.get(`/api/v1/sessions/${sessionId}/stats/overview`)
  return JSON.stringify(stats, null, 2)
}

export function registerStatsTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_stats_overview',
    'Returns statistical overview of a session: message counts, active members, time distribution.',
    { session_id: z.string().describe('Session ID') },
    async ({ session_id }) => {
      try {
        return {
          content: [{ type: 'text' as const, text: await getStatsOverview(client, session_id) }],
        }
      } catch (e) {
        return toolError(e, session_id)
      }
    }
  )
}
