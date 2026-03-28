import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

const MAX_LIMIT = 100

const getMessagesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keyword: z.string().optional().describe('Substring search'),
  start_time: z.number().optional().describe('Start time as Unix timestamp (seconds)'),
  end_time: z.number().optional().describe('End time as Unix timestamp (seconds)'),
  sender_id: z.string().optional().describe('Filter by member platformId'),
  type: z.number().optional().describe('Filter by message type number'),
  page: z.number().optional().describe('Page number (default: 1)'),
  limit: z.number().optional().describe(`Messages per page, max ${MAX_LIMIT} (default: 20). Use pagination to retrieve more.`),
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
  query.limit = String(Math.min(filters.limit ?? 20, MAX_LIMIT))

  const result: any = await client.get(`/api/v1/sessions/${session_id}/messages`, query)
  if (result.data?.messages) {
    result.data.messages = result.data.messages.map(
      ({ senderAvatar, senderAliases, senderId, senderPlatformId, id, replyToMessageId, ...msg }: any) => msg
    )
    const { total, page: p = 1, messages } = result.data
    if (total !== undefined && messages.length < total) {
      result.data.has_more = true
      result.data.hint = `Showing ${messages.length} of ${total} messages. Use page=${Number(p) + 1} to get the next batch.`
    }
  }
  return JSON.stringify(result, null, 2)
}

export function registerMessagesTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_messages',
    `The primary tool for reading message content. Retrieves up to ${MAX_LIMIT} messages per call with filters for keyword, time range, and sender. Use page to paginate. Always prefer this over execute_sql when reading messages.`,
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
