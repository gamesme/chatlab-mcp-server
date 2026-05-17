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

/**
 * If the error indicates a missing table (older schema lacking
 * chat_session / message_fts / etc.), return a friendly hint string.
 * Otherwise return null so the caller can rethrow.
 *
 * Shared by tools that depend on newer schema features.
 */
function missingTableHint(sql: string, err: Error): string | null {
  const msg = err.message || ''
  if (/no such table/i.test(msg)) {
    return 'This feature requires a newer database schema (chat_session / message_fts). Please reimport the session in the latest ChatLab version.'
  }
  void sql
  return null
}

const getMessageContextSchema = z.object({
  session_id: z.string().describe('Session ID'),
  message_ids: z.array(z.number().finite()).min(1).describe('Target message IDs (one or many)'),
  context_size: z.number().finite().optional().describe('Messages before AND after each target (default 20, max 100)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetMessageContextParams = z.infer<typeof getMessageContextSchema>

export async function getMessageContext(
  client: Pick<ChatLabClient, 'post'>,
  params: GetMessageContextParams
): Promise<string> {
  const { session_id, message_ids, format = 'text', timezone = 'Asia/Shanghai' } = params
  const ctx = params.context_size !== undefined && Number.isFinite(params.context_size)
    ? Math.min(Math.max(params.context_size, 1), 100)
    : 20

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
  member_id_1: z.number().finite().describe('First member numeric ID (from get_members)'),
  member_id_2: z.number().finite().describe('Second member numeric ID (from get_members)'),
  start_time: z.number().finite().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().finite().optional().describe('End time (Unix seconds)'),
  limit: z.number().finite().optional().describe('Max messages (default 100, max 1000)'),
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
  const limit = params.limit !== undefined && Number.isFinite(params.limit)
    ? Math.min(Math.max(params.limit, 1), 1000)
    : 100

  const sql = `
    SELECT m.id, m.ts, m.type, m.content,
           mem.platform_id AS senderPlatformId,
           COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    JOIN member mem ON m.sender_id = mem.id
    WHERE m.sender_id IN (${Math.floor(member_id_1)}, ${Math.floor(member_id_2)})
      ${buildTimeFilter(start_time, end_time, 'm.ts')}
    ORDER BY m.ts, m.id
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

const getSessionSummariesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keywords: z.array(z.string()).optional().describe('Filter summaries containing any of these keywords (case-insensitive)'),
  limit: z.number().finite().optional().describe('Max rows to return (default 20, max 100)'),
  start_time: z.number().finite().optional().describe('Earliest start_ts (Unix seconds)'),
  end_time: z.number().finite().optional().describe('Latest start_ts (Unix seconds)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetSessionSummariesParams = z.infer<typeof getSessionSummariesSchema>

export async function getSessionSummaries(
  client: Pick<ChatLabClient, 'post'>,
  params: GetSessionSummariesParams
): Promise<string> {
  const { session_id, keywords, start_time, end_time, format = 'text', timezone = 'Asia/Shanghai' } = params
  const limit = params.limit !== undefined && Number.isFinite(params.limit)
    ? Math.min(Math.max(params.limit, 1), 100)
    : 20
  const fetchLimit = keywords && keywords.length > 0 ? Math.max(limit * 5, 100) : limit

  const sql = `
    SELECT id, start_ts, end_ts, message_count, summary
    FROM chat_session
    WHERE summary IS NOT NULL
      ${buildTimeFilter(start_time, end_time, 'start_ts')}
    ORDER BY start_ts DESC
    LIMIT ${fetchLimit}
  `.trim()

  let rows: any[]
  try {
    rows = await sqlInternal(client, session_id, sql)
  } catch (e) {
    const hint = missingTableHint(sql, e as Error)
    if (hint) {
      return format === 'json' ? JSON.stringify({ message: hint }, null, 2) : hint
    }
    throw e
  }

  let filtered = rows
  if (keywords && keywords.length > 0) {
    const lowered = keywords.map((k) => k.toLowerCase())
    filtered = rows.filter((r) =>
      typeof r.summary === 'string' && lowered.some((k) => r.summary.toLowerCase().includes(k))
    )
  }
  filtered = filtered.slice(0, limit)

  if (filtered.length === 0) {
    const msg = "No AI-generated summaries found. Generate them in ChatLab's session timeline first."
    return format === 'json'
      ? JSON.stringify({ total: 0, returned: 0, sessions: [], message: msg }, null, 2)
      : msg
  }

  const sessions = filtered.map((r) => ({
    sessionId: r.id,
    startTs: r.start_ts,
    endTs: r.end_ts,
    messageCount: r.message_count,
    summary: r.summary,
  }))

  if (format === 'json') {
    return JSON.stringify({ total: filtered.length, returned: sessions.length, sessions }, null, 2)
  }

  const fmtTime = (ts: number) =>
    new Date(ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })

  const lines = sessions.map(
    (s) => `[${s.sessionId}] ${fmtTime(s.startTs)} ~ ${fmtTime(s.endTs)} (${s.messageCount} msgs)\n  ${s.summary}`
  )

  return formatToolResultAsText({
    total: filtered.length,
    returned: sessions.length,
    summaries: lines,
  })
}

const deepSearchSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keywords: z.array(z.string()).min(1).describe('Keywords to search (FTS5 MATCH, joined by OR)'),
  sender_id: z.number().finite().optional().describe('Restrict to a specific sender (numeric member.id)'),
  start_time: z.number().finite().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().finite().optional().describe('End time (Unix seconds)'),
  limit: z.number().finite().optional().describe('Max hits before context expansion (default 100, max 1000)'),
  context_before: z.number().finite().optional().describe('Context messages before each hit (default 2, max 20)'),
  context_after: z.number().finite().optional().describe('Context messages after each hit (default 2, max 20)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type DeepSearchParams = z.infer<typeof deepSearchSchema>

function ftsEscape(keyword: string): string {
  // FTS5 quoted phrases — embedded double quotes are doubled.
  return `"${keyword.replace(/"/g, '""')}"`
}

export async function deepSearchMessages(
  client: Pick<ChatLabClient, 'post'>,
  params: DeepSearchParams
): Promise<string> {
  const { session_id, keywords, sender_id, start_time, end_time, format = 'text', timezone = 'Asia/Shanghai' } = params
  const limit = params.limit !== undefined && Number.isFinite(params.limit)
    ? Math.min(Math.max(params.limit, 1), 1000)
    : 100
  const before = params.context_before !== undefined && Number.isFinite(params.context_before)
    ? Math.min(Math.max(params.context_before, 0), 20)
    : 2
  const after = params.context_after !== undefined && Number.isFinite(params.context_after)
    ? Math.min(Math.max(params.context_after, 0), 20)
    : 2

  const matchExpr = keywords.map(ftsEscape).join(' OR ')

  let senderClause = ''
  if (sender_id !== undefined && Number.isFinite(sender_id)) {
    senderClause = ` AND m.sender_id = ${Math.floor(sender_id)}`
  }

  const hitsSql = `
    SELECT m.id, m.ts
    FROM message m
    JOIN message_fts ON m.id = message_fts.rowid
    WHERE message_fts MATCH '${sqlEscape(matchExpr)}'
      ${senderClause}
      ${buildTimeFilter(start_time, end_time, 'm.ts')}
    ORDER BY m.ts, m.id
    LIMIT ${limit}
  `.trim()

  let hits: any[]
  try {
    hits = await sqlInternal(client, session_id, hitsSql)
  } catch (e) {
    const hint = missingTableHint(hitsSql, e as Error)
    if (hint) return format === 'json' ? JSON.stringify({ message: hint }, null, 2) : hint
    throw e
  }

  if (hits.length === 0) {
    const msg = `No matches for keywords: ${keywords.join(', ')}`
    return format === 'json' ? JSON.stringify({ total: 0, returned: 0, rawMessages: [] }, null, 2) : msg
  }

  const ranges = hits
    .map((h) => `(m.id BETWEEN ${h.id - before} AND ${h.id + after})`)
    .join(' OR ')

  const contextSql = `
    SELECT m.id, m.ts, m.type, m.content,
           mem.platform_id AS senderPlatformId,
           COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    LEFT JOIN member mem ON m.sender_id = mem.id
    WHERE ${ranges}
    ORDER BY m.id
    LIMIT 5000
  `.trim()

  const expanded = await sqlInternal(client, session_id, contextSql)

  return formatRowsAsConversation(expanded, format, timezone, {
    hits: hits.length,
    total: expanded.length,
  })
}

function formatRowsAsConversation(
  rows: any[],
  format: 'json' | 'text',
  timezone: string,
  extra: Record<string, unknown>
): string {
  if (format === 'json') {
    return JSON.stringify({ ...extra, returned: rows.length, rawMessages: rows }, null, 2)
  }
  const lines = rows.map((r) => {
    const time = new Date(r.ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    return `${time} ${r.senderName ?? '?'}: ${r.content ?? '[no content]'}`
  })
  return formatToolResultAsText({ ...extra, returned: rows.length, messages: lines })
}

const WEEKDAY_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const getTimeStatsSchema = z.object({
  session_id: z.string().describe('Session ID'),
  type: z.enum(['hourly', 'weekday', 'daily']).describe('Bucket granularity'),
  start_time: z.number().finite().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().finite().optional().describe('End time (Unix seconds)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for bucketing (default Asia/Shanghai)'),
})

export type GetTimeStatsParams = z.infer<typeof getTimeStatsSchema>

export async function getTimeStats(
  client: Pick<ChatLabClient, 'post'>,
  params: GetTimeStatsParams
): Promise<string> {
  const { session_id, type, start_time, end_time, format = 'text', timezone = 'Asia/Shanghai' } = params
  const tsExpr = localTsExpr(timezone)
  let bucketExpr: string
  switch (type) {
    case 'hourly':
      bucketExpr = `CAST(strftime('%H', ${tsExpr}, 'unixepoch') AS INTEGER)`
      break
    case 'weekday':
      bucketExpr = `CAST(strftime('%w', ${tsExpr}, 'unixepoch') AS INTEGER)`
      break
    case 'daily':
      bucketExpr = `date(${tsExpr}, 'unixepoch')`
      break
  }

  const sql = `
    SELECT ${bucketExpr} AS bucket, COUNT(*) AS count
    FROM message
    WHERE 1=1 ${buildTimeFilter(start_time, end_time, 'ts')}
    GROUP BY bucket
    ORDER BY bucket
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (format === 'json') {
    return JSON.stringify({ type, timezone, rows }, null, 2)
  }

  if (rows.length === 0) {
    return formatToolResultAsText({ type, timezone, total: 0, distribution: [] })
  }

  const peak = rows.reduce((max, r) => (r.count > max.count ? r : max), rows[0])

  const details: Record<string, unknown> = { type, timezone }
  const distribution: string[] = []

  if (type === 'hourly') {
    const fmt = (n: number) => `${String(n).padStart(2, '0')}:00`
    details.peakHour = `${fmt(peak.bucket)} (${peak.count})`
    for (const r of rows) distribution.push(`${fmt(r.bucket)} ${r.count}`)
  } else if (type === 'weekday') {
    details.peakDay = `${WEEKDAY_NAMES_EN[peak.bucket]} (${peak.count})`
    for (const r of rows) distribution.push(`${WEEKDAY_NAMES_EN[r.bucket]} ${r.count}`)
  } else {
    const total = rows.reduce((s, r) => s + (r.count as number), 0)
    details.peakDay = `${peak.bucket} (${peak.count})`
    details.days = rows.length
    details.total = total
    details.avgPerActiveDay = Math.round(total / rows.length)
    for (const r of rows) distribution.push(`${r.bucket} ${r.count}`)
  }
  details.distribution = distribution

  return formatToolResultAsText(details)
}

const getMemberActivitySchema = z.object({
  session_id: z.string().describe('Session ID'),
  top_n: z.number().finite().optional().describe('Top N members (default 10, max 50)'),
  start_time: z.number().finite().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().finite().optional().describe('End time (Unix seconds)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
})

export type GetMemberActivityParams = z.infer<typeof getMemberActivitySchema>

export async function getMemberActivity(
  client: Pick<ChatLabClient, 'post'>,
  params: GetMemberActivityParams
): Promise<string> {
  const { session_id, start_time, end_time, format = 'text' } = params
  const topN = params.top_n !== undefined && Number.isFinite(params.top_n)
    ? Math.min(Math.max(params.top_n, 1), 50)
    : 10

  const sql = `
    WITH counts AS (
      SELECT m.sender_id, COUNT(*) AS msg_count
      FROM message m
      WHERE 1=1 ${buildTimeFilter(start_time, end_time, 'm.ts')}
      GROUP BY m.sender_id
    ), total AS (
      SELECT COALESCE(SUM(msg_count), 0) AS t FROM counts
    )
    SELECT mem.id, mem.platform_id, mem.account_name, mem.group_nickname,
           c.msg_count,
           CASE WHEN total.t = 0 THEN 0
                ELSE ROUND(c.msg_count * 100.0 / total.t, 2) END AS percentage
    FROM counts c
    JOIN member mem ON mem.id = c.sender_id
    CROSS JOIN total
    ORDER BY c.msg_count DESC
    LIMIT ${topN}
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (format === 'json') {
    return JSON.stringify({ topN, count: rows.length, members: rows }, null, 2)
  }

  if (rows.length === 0) {
    return 'No members with messages in the given range.'
  }

  const lines = rows.map((r, i) => {
    const name = r.group_nickname || r.account_name || r.platform_id
    return `${i + 1}. ${name} (id=${r.id}) - ${r.msg_count} msgs (${r.percentage}%)`
  })

  return formatToolResultAsText({ topN, returned: rows.length, members: lines })
}

const getMemberNameHistorySchema = z.object({
  session_id: z.string().describe('Session ID'),
  member_id: z.number().finite().describe('Member numeric ID (from get_members)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetMemberNameHistoryParams = z.infer<typeof getMemberNameHistorySchema>

export async function getMemberNameHistory(
  client: Pick<ChatLabClient, 'post'>,
  params: GetMemberNameHistoryParams
): Promise<string> {
  const { session_id, member_id, format = 'text', timezone = 'Asia/Shanghai' } = params

  const sql = `
    SELECT name_type, name, start_ts, end_ts
    FROM member_name_history
    WHERE member_id = ${Math.floor(member_id)}
    ORDER BY start_ts
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (rows.length === 0) {
    const msg = `No name history found for member id=${member_id}.`
    return format === 'json' ? JSON.stringify({ total: 0, history: [] }, null, 2) : msg
  }

  if (format === 'json') {
    return JSON.stringify({ total: rows.length, history: rows }, null, 2)
  }

  const fmt = (ts: number | null) =>
    ts === null ? '(current)' : new Date(ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      year: 'numeric', month: 'numeric', day: 'numeric',
    })

  const lines = rows.map((r) => `[${r.name_type}] ${r.name}: ${fmt(r.start_ts)} ~ ${fmt(r.end_ts)}`)

  return formatToolResultAsText({ member_id, total: rows.length, history: lines })
}

const getResponseTimeSchema = z.object({
  session_id: z.string().describe('Session ID'),
  top_n: z.number().finite().optional().describe('Top N (from, to) pairs (default 10, max 50)'),
  start_time: z.number().finite().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().finite().optional().describe('End time (Unix seconds)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
})

export type GetResponseTimeParams = z.infer<typeof getResponseTimeSchema>

export async function getResponseTimeAnalysis(
  client: Pick<ChatLabClient, 'post'>,
  params: GetResponseTimeParams
): Promise<string> {
  const { session_id, start_time, end_time, format = 'text' } = params
  const topN = params.top_n !== undefined && Number.isFinite(params.top_n)
    ? Math.min(Math.max(params.top_n, 1), 50)
    : 10

  const sql = `
    WITH ordered AS (
      SELECT ts, sender_id,
             LAG(ts) OVER (ORDER BY ts) AS prev_ts,
             LAG(sender_id) OVER (ORDER BY ts) AS prev_sender
      FROM message
      WHERE 1=1 ${buildTimeFilter(start_time, end_time, 'ts')}
    )
    SELECT prev_sender AS from_id,
           sender_id   AS to_id,
           COALESCE(m_from.group_nickname, m_from.account_name, m_from.platform_id) AS from_name,
           COALESCE(m_to.group_nickname,   m_to.account_name,   m_to.platform_id)   AS to_name,
           COUNT(*)             AS reply_count,
           MIN(ts - prev_ts)    AS min_seconds,
           ROUND(AVG(ts - prev_ts), 2) AS avg_seconds,
           MAX(ts - prev_ts)    AS max_seconds
    FROM ordered
    LEFT JOIN member m_from ON m_from.id = prev_sender
    LEFT JOIN member m_to   ON m_to.id   = sender_id
    WHERE prev_sender IS NOT NULL
      AND prev_sender <> sender_id
      AND (ts - prev_ts) BETWEEN 1 AND 3600
    GROUP BY from_id, to_id
    ORDER BY reply_count DESC
    LIMIT ${topN}
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (format === 'json') {
    return JSON.stringify({ topN, count: rows.length, pairs: rows }, null, 2)
  }

  if (rows.length === 0) {
    return 'No reply pairs found in the given range.'
  }

  const lines = rows.map(
    (r, i) =>
      `${i + 1}. ${r.from_name} → ${r.to_name}: ${r.reply_count} replies (min=${r.min_seconds}s, avg=${r.avg_seconds}s, max=${r.max_seconds}s)`
  )

  return formatToolResultAsText({ topN, returned: rows.length, pairs: lines })
}

const keywordFrequencySchema = z.object({
  session_id: z.string().describe('Session ID (unused; tool returns info only)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
})

export type KeywordFrequencyParams = z.infer<typeof keywordFrequencySchema>

const KEYWORD_FREQUENCY_MESSAGE = `keyword_frequency is not implemented in chatlab-mcp-server.

This feature requires CJK word segmentation (jieba / kuromoji), which the MCP
server does not bundle to keep the package lightweight.

Alternatives:
1. Run keyword_frequency in the ChatLab desktop app (Insights > Word Cloud).
2. Use execute_sql with LIKE patterns for known phrases:
     SELECT content, COUNT(*) AS c FROM message
     WHERE content LIKE '%<phrase>%'
     GROUP BY content ORDER BY c DESC LIMIT 20
3. Use get_messages with a keyword filter and count occurrences in your reply.`

const KEYWORD_FREQUENCY_ALTERNATIVES = [
  "Run keyword_frequency in the ChatLab desktop app (Insights > Word Cloud).",
  "Use execute_sql with LIKE patterns to count occurrences of known phrases.",
  "Use get_messages with a keyword filter and count in the LLM response.",
]

export async function keywordFrequency(params: KeywordFrequencyParams): Promise<string> {
  void params.session_id
  if (params.format === 'json') {
    return JSON.stringify(
      { message: KEYWORD_FREQUENCY_MESSAGE, available_alternatives: KEYWORD_FREQUENCY_ALTERNATIVES },
      null,
      2
    )
  }
  return KEYWORD_FREQUENCY_MESSAGE
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

  server.tool(
    'get_session_summaries',
    'Get AI-generated summaries of chat sub-sessions from the chat_session table. Use to quickly survey what topics have been discussed. Supports keyword filtering and time range. Returns text by default.',
    getSessionSummariesSchema.shape,
    async (args) => {
      try {
        const text = await getSessionSummaries(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'deep_search_messages',
    'Full-text search messages via FTS5, then expand each hit with surrounding context messages. Use for "did anyone mention X" style queries where conversation context matters.',
    deepSearchSchema.shape,
    async (args) => {
      try {
        const text = await deepSearchMessages(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'get_time_stats',
    'Get message count distribution bucketed by hour, weekday, or day. Use for "when are people most active" type questions. Timezone-aware bucketing.',
    getTimeStatsSchema.shape,
    async (args) => {
      try {
        const text = await getTimeStats(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'get_member_activity',
    'Top members ranked by message count with percentage of total. Use for "who talks the most" or "most active members" type questions. Supports top_n and time filters.',
    getMemberActivitySchema.shape,
    async (args) => {
      try {
        const text = await getMemberActivity(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'get_member_name_history',
    'Get the historical name changes (account name, nickname) for a single member. Useful for tracking identity changes over time.',
    getMemberNameHistorySchema.shape,
    async (args) => {
      try {
        const text = await getMemberNameHistory(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'get_response_time_analysis',
    'Reply intervals between consecutive messages from different senders, grouped by (from, to) pair. Excludes same-sender continuations and gaps over 1 hour. Use for "who responds fastest" type questions.',
    getResponseTimeSchema.shape,
    async (args) => {
      try {
        const text = await getResponseTimeAnalysis(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  server.tool(
    'keyword_frequency',
    'Word/keyword frequency analysis. Currently not implemented in the MCP server due to NLP dependency size; returns a stub message with alternative approaches.',
    keywordFrequencySchema.shape,
    async (args) => {
      try {
        const text = await keywordFrequency(args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
}
