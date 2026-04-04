import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'
import { formatStatsOverviewAsText } from '../format.js'

const MESSAGE_TYPES: Record<string, string> = {
  '0': 'text', '1': 'image', '2': 'voice', '3': 'video', '4': 'emoji',
  '5': 'file', '7': 'location', '8': 'system', '21': 'voip', '23': 'quote',
  '24': 'pat', '25': 'link', '27': 'music', '80': 'miniapp', '99': 'other',
}

export async function getStatsOverview(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: string,
  format: 'json' | 'text' = 'text'
): Promise<string> {
  const res: any = await client.get(`/api/v1/sessions/${sessionId}/stats/overview`)

  // 转换消息类型为可读名称
  if (res.data?.messageTypeDistribution) {
    const labeled: Record<string, number> = {}
    for (const [k, v] of Object.entries(res.data.messageTypeDistribution)) {
      labeled[MESSAGE_TYPES[k] ?? `type_${k}`] = v as number
    }
    res.data.messageTypeDistribution = labeled
  }

  if (format === 'text') {
    return formatStatsOverviewAsText(res.data)
  }

  return JSON.stringify(res, null, 2)
}

export function registerStatsTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_stats_overview',
    'Returns statistical overview of a session: message counts, active members, time distribution. Returns plain text by default (set format=json for JSON).',
    {
      session_id: z.string().describe('Session ID'),
      format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
    },
    async ({ session_id, format = 'text' }) => {
      try {
        return {
          content: [{ type: 'text' as const, text: await getStatsOverview(client, session_id, format) }],
        }
      } catch (e) {
        return toolError(e, session_id)
      }
    }
  )
}
