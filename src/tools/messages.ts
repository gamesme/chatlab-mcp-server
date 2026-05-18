import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChatLabClient } from '../client.js'
import {
  MESSAGES_PER_PAGE_MAX,
  type RawMessage,
  formatMessagesAsPlainText,
  formatToolResultAsText,
} from '../format.js'
import { toolError } from './utils.js'

export interface FetchMessagesParams {
  session_id: string
  keyword?: string
  start_time?: number
  end_time?: number
  sender_id?: string
  type?: number
  page?: number
  limit?: number
  filter_invalid?: boolean
  // remaining shared params (format/timezone/merge_consecutive) are unused here
}

export interface FetchMessagesResult {
  messages: RawMessage[]
  total?: number
  page: number
  has_more?: boolean
}

/**
 * 拉取消息(REST 通道)。
 * SQL fast path 由 Task 5 增加;本任务先只走 REST。
 */
export async function fetchMessagesViaRest(
  client: Pick<ChatLabClient, 'get'>,
  params: FetchMessagesParams,
): Promise<FetchMessagesResult> {
  const query: Record<string, string> = {}
  if (params.keyword !== undefined) query.keyword = params.keyword
  if (params.start_time !== undefined && Number.isFinite(params.start_time)) {
    query.startTime = String(params.start_time)
  }
  if (params.end_time !== undefined && Number.isFinite(params.end_time)) {
    query.endTime = String(params.end_time)
  }
  if (params.sender_id !== undefined) query.sender_id = params.sender_id
  if (params.type !== undefined && Number.isFinite(params.type)) {
    query.type = String(params.type)
  }
  if (params.page !== undefined && Number.isFinite(params.page)) {
    query.page = String(params.page)
  }
  const effectiveLimit =
    params.limit !== undefined && Number.isFinite(params.limit) ? params.limit : 100
  query.limit = String(Math.min(effectiveLimit, MESSAGES_PER_PAGE_MAX))

  const result: any = await client.get(
    `/api/v1/sessions/${params.session_id}/messages`,
    query,
  )

  const rawMessages: RawMessage[] = (result.data?.messages ?? []).map((m: any) => ({
    id: m.id,
    senderName: m.senderName,
    senderPlatformId: m.senderPlatformId,
    content: m.content,
    timestamp: m.timestamp,
    type: m.type,
  }))

  return {
    messages: rawMessages,
    total: result.data?.total,
    page: result.data?.page ?? Number(query.page ?? 1),
  }
}

// ─── Temporary backwards-compatible getMessages() ──────────────────────────
// Task 6 deletes this and migrates to registerMessageTool. Kept here for one
// task so existing server.tool registration continues to compile.

const MESSAGE_TYPE_DESC =
  '0=text 1=image 2=voice 3=video 4=emoji 5=file 7=location 8=system ' +
  '21=voip 23=quote 24=pat 25=link 27=music 80=miniapp 99=other'

const getMessagesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keyword: z.string().optional()
    .describe('Full-text search via FTS5 when available, falls back to LIKE'),
  start_time: z.number().finite().optional().describe('Start time as Unix seconds'),
  end_time: z.number().finite().optional().describe('End time as Unix seconds'),
  sender_id: z.string().optional().describe('Filter by member platformId'),
  type: z.number().finite().optional()
    .describe(`Filter by message type code. ${MESSAGE_TYPE_DESC}`),
  page: z.number().finite().optional()
    .describe('Page number (default 1). page=1 returns the LATEST messages; within each page messages are sorted chronologically (ascending)'),
  limit: z.number().finite().optional()
    .describe(`Messages per page (default 100, max ${MESSAGES_PER_PAGE_MAX})`),
  format: z.enum(['json', 'text']).optional().describe('Output format'),
  merge_consecutive: z.boolean().optional().describe('Merge consecutive (text only)'),
  filter_invalid: z.boolean().optional().describe('Filter invalid (text only)'),
  timezone: z.string().optional().describe('Timezone for time display'),
})

type GetMessagesParams = z.infer<typeof getMessagesSchema>

export async function getMessages(
  client: Pick<ChatLabClient, 'get'>,
  params: GetMessagesParams,
): Promise<string> {
  const { format = 'text', timezone = 'Asia/Shanghai', merge_consecutive, filter_invalid, ...rest } = params
  const result = await fetchMessagesViaRest(client, rest as FetchMessagesParams)

  const sorted = [...result.messages].sort((a, b) => a.timestamp - b.timestamp)

  if (format === 'text') {
    const plainText = formatMessagesAsPlainText(sorted, {
      mergeConsecutive: merge_consecutive ?? true,
      filterInvalid: filter_invalid ?? true,
      timezone,
    })
    const details: Record<string, unknown> = {
      total: result.total,
      returned: sorted.length,
      page: result.page,
    }
    if (plainText) details.messages = plainText.split('\n')
    if (result.total !== undefined && sorted.length < result.total) {
      const nextPage = result.page + 1
      const remaining = result.total - sorted.length
      details.instruction =
        `还有 ${remaining} 条未显示。调用 get_messages(session_id="${params.session_id}", page=${nextPage}) 获取下一页`
    }
    return formatToolResultAsText(details)
  }

  return JSON.stringify({
    data: {
      messages: sorted,
      total: result.total,
      page: result.page,
    },
  }, null, 2)
}

export function registerMessagesTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_messages',
    `The primary tool for reading message content. Retrieves up to ${MESSAGES_PER_PAGE_MAX} messages per call with filters for keyword (FTS5 when available), time range, sender, and type. Returns plain text by default; pass format=json for raw structured output. Prefer this over execute_sql when reading messages.`,
    getMessagesSchema.shape,
    async (args) => {
      try {
        const text = await getMessages(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    },
  )
}
