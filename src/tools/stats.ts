import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

const MESSAGE_TYPES: Record<string, string> = {
  '0': 'text', '1': 'image', '2': 'voice', '3': 'video', '4': 'file',
  '5': 'emoji', '7': 'link', '8': 'location', '20': 'redPacket', '21': 'transfer',
  '22': 'poke', '23': 'call', '24': 'share', '25': 'reply', '26': 'forward',
  '27': 'contact', '80': 'system', '81': 'recall', '99': 'other',
}

export async function getStatsOverview(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: string
): Promise<string> {
  const res: any = await client.get(`/api/v1/sessions/${sessionId}/stats/overview`)
  if (res.data?.messageTypeDistribution) {
    const labeled: Record<string, number> = {}
    for (const [k, v] of Object.entries(res.data.messageTypeDistribution)) {
      labeled[MESSAGE_TYPES[k] ?? `type_${k}`] = v as number
    }
    res.data.messageTypeDistribution = labeled
  }
  return JSON.stringify(res, null, 2)
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
