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

export function registerAnalyticsTools(server: McpServer, client: ChatLabClient): void {
  // Tools added one at a time in subsequent tasks.
  void server
  void client
  void toolError
  void sqlInternal
  void formatToolResultAsText
  void z
}
