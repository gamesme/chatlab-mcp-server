import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError, formatMessagesCompact } from './utils.js'

// ── get_message_context ────────────────────────────────────────────────────

const getMessageContextSchema = z.object({
  session_id: z.string().describe('Session ID'),
  ids: z
    .union([z.number(), z.array(z.number())])
    .describe('Message ID or array of message IDs to retrieve context around'),
  context_size: z
    .number()
    .optional()
    .describe('Number of messages before and after each target (default: 20)'),
})

type GetMessageContextParams = z.infer<typeof getMessageContextSchema>

export async function getMessageContext(
  client: Pick<ChatLabClient, 'get'>,
  params: GetMessageContextParams
): Promise<string> {
  const { session_id, ids, context_size } = params
  const idsStr = Array.isArray(ids) ? ids.join(',') : String(ids)
  const query: Record<string, string> = { ids: idsStr }
  if (context_size !== undefined) query.context_size = String(context_size)

  const res: any = await client.get(`/api/v1/sessions/${session_id}/messages/context`, query)
  const messages: any[] = res?.data ?? []
  if (messages.length === 0) return 'No context messages found.'
  return formatMessagesCompact(messages)
}

// ── search_chat_sessions ───────────────────────────────────────────────────

const searchChatSessionsSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keyword: z.string().optional().describe('Keyword to search within conversation segments'),
  start_time: z
    .number()
    .optional()
    .describe('Filter: segments starting after this Unix timestamp'),
  end_time: z
    .number()
    .optional()
    .describe('Filter: segments starting before this Unix timestamp'),
  limit: z.number().optional().describe('Max segments to return (max 100)'),
  preview_count: z
    .number()
    .optional()
    .describe('Preview messages per segment (max 20, default 5)'),
})

type SearchChatSessionsParams = z.infer<typeof searchChatSessionsSchema>

export async function searchChatSessions(
  client: Pick<ChatLabClient, 'get'>,
  params: SearchChatSessionsParams
): Promise<string> {
  const { session_id, keyword, start_time, end_time, limit, preview_count } = params
  const query: Record<string, string> = {}
  if (keyword !== undefined) query.keyword = keyword
  if (start_time !== undefined) query.start_time = String(start_time)
  if (end_time !== undefined) query.end_time = String(end_time)
  if (limit !== undefined) query.limit = String(Math.min(limit, 100))
  if (preview_count !== undefined) query.preview_count = String(Math.min(preview_count, 20))

  const res: any = await client.get(`/api/v1/sessions/${session_id}/chat-sessions`, query)
  const sessions: any[] = res?.data ?? []
  if (sessions.length === 0) return 'No conversation segments found.'

  const lines: string[] = [`Found ${sessions.length} conversation segment(s):\n`]
  for (const seg of sessions) {
    const startDate = new Date(seg.startTs * 1000).toLocaleString()
    const endDate = new Date(seg.endTs * 1000).toLocaleString()
    lines.push(
      `[id:${seg.id}] ${startDate} → ${endDate}  (${seg.messageCount} messages${seg.isComplete ? '' : ', partial'})`
    )
    if (seg.previewMessages?.length > 0) {
      for (const msg of seg.previewMessages) {
        const content = msg.content ?? ''
        const truncated = content.length > 100 ? content.slice(0, 100) + '…' : content
        lines.push(`  ${msg.senderName}: ${truncated}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ── get_chat_session_messages ──────────────────────────────────────────────

const getChatSessionMessagesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  chat_session_id: z
    .number()
    .describe('Conversation segment ID (from search_chat_sessions)'),
  limit: z.number().optional().describe('Max messages to return (max 1000, default 500)'),
})

type GetChatSessionMessagesParams = z.infer<typeof getChatSessionMessagesSchema>

export async function getChatSessionMessages(
  client: Pick<ChatLabClient, 'get'>,
  params: GetChatSessionMessagesParams
): Promise<string> {
  const { session_id, chat_session_id, limit } = params
  const query: Record<string, string> = {}
  if (limit !== undefined) query.limit = String(Math.min(limit, 1000))

  const res: any = await client.get(
    `/api/v1/sessions/${session_id}/chat-sessions/${chat_session_id}/messages`,
    query
  )
  const data = res?.data
  if (!data) return 'No data returned.'

  return formatMessagesCompact(data.messages ?? [], {
    total: data.messageCount,
    returnedCount: data.returnedCount,
    startTs: data.startTs,
    endTs: data.endTs,
    participants: data.participants,
  })
}

// ── get_chat_session_summaries ─────────────────────────────────────────────

const getChatSessionSummariesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  start_time: z
    .number()
    .optional()
    .describe('Filter: summaries for segments starting after this Unix timestamp'),
  end_time: z
    .number()
    .optional()
    .describe('Filter: summaries for segments starting before this Unix timestamp'),
  limit: z.number().optional().describe('Max summaries to return (max 100)'),
})

type GetChatSessionSummariesParams = z.infer<typeof getChatSessionSummariesSchema>

export async function getChatSessionSummaries(
  client: Pick<ChatLabClient, 'get'>,
  params: GetChatSessionSummariesParams
): Promise<string> {
  const { session_id, start_time, end_time, limit } = params
  const query: Record<string, string> = {}
  if (start_time !== undefined) query.start_time = String(start_time)
  if (end_time !== undefined) query.end_time = String(end_time)
  if (limit !== undefined) query.limit = String(Math.min(limit, 100))

  const res: any = await client.get(
    `/api/v1/sessions/${session_id}/chat-sessions/summaries`,
    query
  )
  const summaries: any[] = res?.data ?? []
  if (summaries.length === 0)
    return 'No summaries found. Sessions may not have been analyzed yet.'

  const lines: string[] = [`${summaries.length} conversation summary(s):\n`]
  for (const s of summaries) {
    const startDate = new Date(s.startTs * 1000).toLocaleString()
    const endDate = new Date(s.endTs * 1000).toLocaleString()
    const participants = s.participants?.join(', ') ?? 'unknown'
    lines.push(`[id:${s.id}] ${startDate} → ${endDate}  (${s.messageCount} msgs)`)
    lines.push(`Participants: ${participants}`)
    lines.push(`Summary: ${s.summary ?? '(none)'}`)
    lines.push('')
  }
  return lines.join('\n')
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerChatSessionTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_message_context',
    'Retrieves surrounding messages around one or more specific message IDs. Use after finding a relevant message to read the full conversation context. Returns compact text format.',
    getMessageContextSchema.shape,
    async (args) => {
      try {
        return { content: [{ type: 'text' as const, text: await getMessageContext(client, args) }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'search_chat_sessions',
    'Searches conversation segments (auto-split by 30-min activity gaps). Returns segments with preview messages. Use the returned chat_session_id with get_chat_session_messages to read the full conversation.',
    searchChatSessionsSchema.shape,
    async (args) => {
      try {
        return {
          content: [{ type: 'text' as const, text: await searchChatSessions(client, args) }],
        }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'get_chat_session_messages',
    'Retrieves all messages in a specific conversation segment. Use the chat_session_id from search_chat_sessions. Returns compact text with participants and time range header.',
    getChatSessionMessagesSchema.shape,
    async (args) => {
      try {
        return {
          content: [
            { type: 'text' as const, text: await getChatSessionMessages(client, args) },
          ],
        }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'get_chat_session_summaries',
    'Retrieves AI-generated summaries for conversation segments. Only returns segments that have been summarized by ChatLab. Use to understand discussed topics without reading full messages.',
    getChatSessionSummariesSchema.shape,
    async (args) => {
      try {
        return {
          content: [
            { type: 'text' as const, text: await getChatSessionSummaries(client, args) },
          ],
        }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
}
