import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

const getMessagesSchema = z.object({
  session_id: z.number().describe('Session ID'),
  keyword: z.string().optional().describe('Substring search'),
  start_time: z.number().optional().describe('Start time as Unix timestamp (seconds)'),
  end_time: z.number().optional().describe('End time as Unix timestamp (seconds)'),
  sender_id: z.string().optional().describe('Filter by member platformId'),
  type: z.number().optional().describe('Filter by message type number'),
  page: z.number().optional().describe('Page number (default: 1)'),
  limit: z.number().optional().describe('Messages per page, max 1000 (default: 20)'),
})

type GetMessagesParams = z.infer<typeof getMessagesSchema>

export async function getMessages(
  client: Pick<ChatLabClient, 'get'>,
  params: GetMessagesParams
): Promise<string> {
  const { session_id, ...filters } = params
  const query: Record<string, string> = {}
  if (filters.keyword !== undefined) query.keyword = filters.keyword
  if (filters.start_time !== undefined) query.start_time = String(filters.start_time)
  if (filters.end_time !== undefined) query.end_time = String(filters.end_time)
  if (filters.sender_id !== undefined) query.sender_id = filters.sender_id
  if (filters.type !== undefined) query.type = String(filters.type)
  if (filters.page !== undefined) query.page = String(filters.page)
  if (filters.limit !== undefined) query.limit = String(filters.limit)

  const result = await client.get(`/api/v1/sessions/${session_id}/messages`, query)
  return JSON.stringify(result, null, 2)
}

export function registerMessagesTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_messages',
    'Retrieves messages from a session with optional filters for keyword, date range, sender, and pagination.',
    getMessagesSchema.shape,
    async (args) => {
      try {
        const text = await getMessages(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
}
