import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError, sqlInternal } from './utils.js'
import { formatToolResultAsText } from '../format.js'

/**
 * Build SQL fragment for optional ts range filter.
 * Returns the WHERE-suffix and the param values (positional).
 * Caller composes "WHERE 1=1" then appends the fragment.
 */
export function buildTimeFilter(
  start?: number,
  end?: number,
  tsColumn: string = 'ts'
): string {
  const parts: string[] = []
  if (start !== undefined && Number.isFinite(start)) {
    parts.push(`${tsColumn} >= ${Math.floor(start)}`)
  }
  if (end !== undefined && Number.isFinite(end)) {
    parts.push(`${tsColumn} <= ${Math.floor(end)}`)
  }
  return parts.length ? ' AND ' + parts.join(' AND ') : ''
}

/**
 * Compute the UTC offset (in seconds) of an IANA timezone at "now".
 * Used to bucket SQLite UTC timestamps into the caller's local hours/days.
 * Falls back to 0 if the IANA name is invalid.
 */
export function timezoneOffsetSeconds(timezone: string): number {
  try {
    const now = new Date()
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    })
    const parts = fmt.formatToParts(now)
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0'
    const m = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
    if (!m) return 0
    const sign = m[1] === '-' ? -1 : 1
    const hours = parseInt(m[2], 10)
    const minutes = m[3] ? parseInt(m[3], 10) : 0
    return sign * (hours * 3600 + minutes * 60)
  } catch {
    return 0
  }
}

/**
 * SQL expression that converts the UTC ts column to a local-time epoch
 * for use with strftime(). The offset is embedded as a number, not a param.
 */
export function localTsExpr(timezone: string, tsColumn: string = 'ts'): string {
  const off = timezoneOffsetSeconds(timezone)
  return `(${tsColumn} + ${off})`
}

/**
 * Escape single quotes for safe interpolation into SQL string literals.
 * Caller is responsible for surrounding with quotes.
 */
export function sqlEscape(value: string): string {
  return value.replace(/'/g, "''")
}

const getMessageContextSchema = z.object({
  session_id: z.string().describe('Session ID'),
  message_ids: z.array(z.number()).min(1).describe('Target message IDs (one or many)'),
  context_size: z.number().optional().describe('Messages before AND after each target (default 20, max 100)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetMessageContextParams = z.infer<typeof getMessageContextSchema>

export async function getMessageContext(
  client: Pick<ChatLabClient, 'post'>,
  params: GetMessageContextParams
): Promise<string> {
  const { session_id, message_ids, format = 'text', timezone = 'Asia/Shanghai' } = params
  const ctx = Math.min(Math.max(params.context_size ?? 20, 1), 100)

  const ranges = message_ids.map((id) => `(m.id BETWEEN ${id - ctx} AND ${id + ctx})`).join(' OR ')

  const sql = `
    SELECT m.id, m.ts, m.type, m.content,
           mem.platform_id AS senderPlatformId,
           COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    LEFT JOIN member mem ON m.sender_id = mem.id
    WHERE ${ranges}
    ORDER BY m.id
    LIMIT 2000
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (rows.length === 0) {
    return format === 'json'
      ? JSON.stringify({ total: 0, returned: 0, rawMessages: [] }, null, 2)
      : 'No matching messages found for the given message IDs.'
  }

  if (format === 'json') {
    return JSON.stringify({ total: rows.length, returned: rows.length, rawMessages: rows }, null, 2)
  }

  const lines = rows.map((r) => {
    const time = new Date(r.ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    const content = r.content ?? '[no content]'
    return `${time} ${r.senderName}: ${content}`
  })

  const details: Record<string, unknown> = {
    total: rows.length,
    returned: rows.length,
    requestedMessageIds: message_ids,
    contextSize: ctx,
    messages: lines,
  }
  return formatToolResultAsText(details)
}

const getConversationBetweenSchema = z.object({
  session_id: z.string().describe('Session ID'),
  member_id_1: z.number().describe('First member numeric ID (from get_members)'),
  member_id_2: z.number().describe('Second member numeric ID (from get_members)'),
  start_time: z.number().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().optional().describe('End time (Unix seconds)'),
  limit: z.number().optional().describe('Max messages (default 100, max 1000)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetConversationBetweenParams = z.infer<typeof getConversationBetweenSchema>

export async function getConversationBetween(
  client: Pick<ChatLabClient, 'post'>,
  params: GetConversationBetweenParams
): Promise<string> {
  const {
    session_id, member_id_1, member_id_2,
    start_time, end_time, format = 'text', timezone = 'Asia/Shanghai',
  } = params
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000)

  const sql = `
    SELECT m.id, m.ts, m.type, m.content,
           mem.platform_id AS senderPlatformId,
           COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    JOIN member mem ON m.sender_id = mem.id
    WHERE m.sender_id IN (${Math.floor(member_id_1)}, ${Math.floor(member_id_2)})
      ${buildTimeFilter(start_time, end_time, 'm.ts')}
    ORDER BY m.ts
    LIMIT ${limit}
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (rows.length === 0) {
    return format === 'json'
      ? JSON.stringify({ total: 0, returned: 0, rawMessages: [] }, null, 2)
      : 'No conversation found between these two members in the given range.'
  }

  if (format === 'json') {
    return JSON.stringify({ total: rows.length, returned: rows.length, rawMessages: rows }, null, 2)
  }

  const lines = rows.map((r) => {
    const time = new Date(r.ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    return `${time} ${r.senderName}: ${r.content ?? '[no content]'}`
  })

  return formatToolResultAsText({
    total: rows.length,
    returned: rows.length,
    member_id_1, member_id_2,
    messages: lines,
  })
}

export function registerAnalyticsTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_message_context',
    'Get N messages before and after one or more specific message IDs. Use when the user references "what was being said around message X" or wants to see the conversation surrounding a specific message.',
    getMessageContextSchema.shape,
    async (args) => {
      try {
        const text = await getMessageContext(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'get_conversation_between',
    'Get messages between two specific members (interleaved by time). Use when the user asks "what did A and B talk about". Members must be referenced by their numeric DB id; call get_members first to look them up.',
    getConversationBetweenSchema.shape,
    async (args) => {
      try {
        const text = await getConversationBetween(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
}
