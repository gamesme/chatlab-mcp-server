import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChatLabClient } from '../client.js'
import {
  MESSAGES_PER_PAGE_MAX,
  type RawMessage,
  formatMessagesAsPlainText,
  formatToolResultAsText,
} from '../format.js'
import { toolError, sqlInternal } from './utils.js'

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

async function fetchMessagesViaSql(
  client: Pick<ChatLabClient, 'post'>,
  params: FetchMessagesParams,
): Promise<FetchMessagesResult> {
  const page =
    params.page !== undefined && Number.isFinite(params.page)
      ? Math.max(1, Math.floor(params.page))
      : 1
  const limit =
    params.limit !== undefined && Number.isFinite(params.limit)
      ? Math.min(Math.max(1, Math.floor(params.limit)), MESSAGES_PER_PAGE_MAX)
      : 100
  const offset = (page - 1) * limit

  const conditions: string[] = ['1=1']

  if (params.type !== undefined && Number.isFinite(params.type)) {
    conditions.push(`msg.type = ${Math.floor(params.type)}`)
  } else if (params.filter_invalid !== false) {
    // default: only text messages
    conditions.push('msg.type = 0')
  }

  if (params.start_time !== undefined && Number.isFinite(params.start_time)) {
    conditions.push(`msg.ts >= ${Math.floor(params.start_time)}`)
  }
  if (params.end_time !== undefined && Number.isFinite(params.end_time)) {
    conditions.push(`msg.ts <= ${Math.floor(params.end_time)}`)
  }
  if (params.sender_id !== undefined) {
    const safe = params.sender_id.replace(/'/g, "''")
    conditions.push(`m.platform_id = '${safe}'`)
  }

  // SQL-level filter_invalid (mirrors upstream getRecentMessages)
  conditions.push("msg.content IS NOT NULL")
  conditions.push("msg.content != ''")
  conditions.push("COALESCE(m.account_name, '') != '系统消息'")

  // Request limit+1 rows to detect has_more without a separate COUNT query
  const sql = `
    SELECT
      msg.id AS id,
      msg.ts AS timestamp,
      msg.type AS type,
      msg.content AS content,
      m.platform_id AS senderPlatformId,
      COALESCE(m.group_nickname, m.account_name, m.platform_id) AS senderName
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY msg.ts DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `.trim()

  const rows = await sqlInternal(client, params.session_id, sql)
  const hasMore = rows.length > limit
  const trimmed = hasMore ? rows.slice(0, limit) : rows

  const messages: RawMessage[] = trimmed.map((r: any) => ({
    id: r.id,
    senderName: r.senderName,
    senderPlatformId: r.senderPlatformId,
    content: r.content,
    timestamp: r.timestamp,
    type: r.type,
  }))

  return { messages, page, has_more: hasMore }
}

/**
 * 拉取消息。当无关键字且 filter_invalid 开启(默认)时走 SQL fast path;
 * 有关键字时走 REST 以利用 FTS5。
 */
export async function fetchMessagesViaRest(
  client: Pick<ChatLabClient, 'get' | 'post'>,
  params: FetchMessagesParams,
): Promise<FetchMessagesResult> {
  // SQL fast path: when no keyword and filter_invalid is on (default),
  // or when caller explicitly wants only text messages (type=0),
  // bypass REST and run the filtered SQL directly. Saves bandwidth and
  // avoids the post-fetch JS filter.
  const useSqlFastPath =
    (!params.keyword && params.filter_invalid !== false) || params.type === 0

  if (useSqlFastPath) {
    return fetchMessagesViaSql(client, params)
  }

  // ─── REST path (unchanged below) ──────────────────
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
  client: Pick<ChatLabClient, 'get' | 'post'>,
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
