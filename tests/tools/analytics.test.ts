import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildTimeFilter,
  timezoneOffsetSeconds,
  localTsExpr,
  sqlEscape,
  getMessageContext,
} from '../../src/tools/analytics.js'
import { getConversationBetween } from '../../src/tools/analytics.js'
import { getSessionSummaries } from '../../src/tools/analytics.js'
import { deepSearchMessages } from '../../src/tools/analytics.js'
import { getTimeStats } from '../../src/tools/analytics.js'
import { getMemberActivity } from '../../src/tools/analytics.js'
import { getMemberNameHistory } from '../../src/tools/analytics.js'

const mockClient = { post: vi.fn(), get: vi.fn() }
beforeEach(() => {
  mockClient.post.mockReset()
  mockClient.get.mockReset()
})

describe('analytics helpers', () => {
  it('buildTimeFilter handles no filters', () => {
    expect(buildTimeFilter(undefined, undefined)).toBe('')
  })

  it('buildTimeFilter handles start only', () => {
    expect(buildTimeFilter(1700000000, undefined)).toBe(' AND ts >= 1700000000')
  })

  it('buildTimeFilter handles end only', () => {
    expect(buildTimeFilter(undefined, 1700100000)).toBe(' AND ts <= 1700100000')
  })

  it('buildTimeFilter handles both', () => {
    expect(buildTimeFilter(1700000000, 1700100000)).toBe(
      ' AND ts >= 1700000000 AND ts <= 1700100000'
    )
  })

  it('buildTimeFilter respects custom tsColumn', () => {
    expect(buildTimeFilter(1700000000, undefined, 'start_ts')).toBe(' AND start_ts >= 1700000000')
  })

  it('timezoneOffsetSeconds returns 0 for UTC', () => {
    expect(timezoneOffsetSeconds('UTC')).toBe(0)
  })

  it('timezoneOffsetSeconds returns positive for Asia/Shanghai', () => {
    expect(timezoneOffsetSeconds('Asia/Shanghai')).toBe(8 * 3600)
  })

  it('timezoneOffsetSeconds returns 0 for invalid name', () => {
    expect(timezoneOffsetSeconds('Not/A/Zone')).toBe(0)
  })

  it('localTsExpr embeds offset', () => {
    expect(localTsExpr('Asia/Shanghai')).toBe('(ts + 28800)')
    expect(localTsExpr('UTC', 'm.ts')).toBe('(m.ts + 0)')
  })

  it('sqlEscape doubles single quotes', () => {
    expect(sqlEscape("O'Brien")).toBe("O''Brien")
  })
})

describe('get_message_context', () => {
  it('builds SQL with id range for single target', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [100],
      context_size: 5,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.id BETWEEN 95 AND 105/)
    expect(sql).toMatch(/ORDER BY m\.id/)
  })

  it('builds SQL with multiple id ranges joined by OR', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [100, 500],
      context_size: 2,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.id BETWEEN 98 AND 102/)
    expect(sql).toMatch(/m\.id BETWEEN 498 AND 502/)
    expect(sql).toMatch(/ OR /)
  })

  it('defaults context_size to 20 and caps at 100', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMessageContext(mockClient as any, { session_id: 's1', message_ids: [50], format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/BETWEEN 30 AND 70/)

    mockClient.post.mockClear()
    await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [200],
      context_size: 9999,
      format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/BETWEEN 100 AND 300/)
  })

  it('formats text output with sender names and timestamps', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        rows: [
          { id: 99, ts: 1700000000, senderName: 'Alice', content: 'hi' },
          { id: 100, ts: 1700000060, senderName: 'Bob', content: 'hey' },
        ],
      },
    })
    const out = await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [100],
      context_size: 1,
      format: 'text',
    })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/Bob/)
    expect(out).toMatch(/hi/)
  })

  it('returns informative text on empty result', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    const out = await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [999],
      format: 'text',
    })
    expect(out).toMatch(/no.*messages|No matching/i)
  })
})

describe('get_conversation_between', () => {
  it('filters by sender_id IN (a, b)', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getConversationBetween(mockClient as any, {
      session_id: 's1',
      member_id_1: 5,
      member_id_2: 9,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.sender_id IN \(5, 9\)/)
    expect(sql).toMatch(/ORDER BY m\.ts/)
  })

  it('applies time filters', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getConversationBetween(mockClient as any, {
      session_id: 's1',
      member_id_1: 5,
      member_id_2: 9,
      start_time: 1700000000,
      end_time: 1700100000,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.ts >= 1700000000/)
    expect(sql).toMatch(/m\.ts <= 1700100000/)
  })

  it('defaults limit to 100, caps at 1000', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getConversationBetween(mockClient as any, {
      session_id: 's1', member_id_1: 1, member_id_2: 2, format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 100/)

    mockClient.post.mockClear()
    await getConversationBetween(mockClient as any, {
      session_id: 's1', member_id_1: 1, member_id_2: 2, limit: 99999, format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 1000/)
  })

  it('formats text output', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        rows: [
          { id: 1, ts: 1700000000, senderName: 'Alice', content: 'hi' },
          { id: 2, ts: 1700000060, senderName: 'Bob', content: 'hey' },
        ],
      },
    })
    const out = await getConversationBetween(mockClient as any, {
      session_id: 's1', member_id_1: 1, member_id_2: 2, format: 'text',
    })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/Bob/)
  })
})

describe('get_session_summaries', () => {
  it('queries chat_session table with summary filter', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getSessionSummaries(mockClient as any, { session_id: 's1', format: 'json' })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/FROM chat_session/)
    expect(sql).toMatch(/summary IS NOT NULL/)
    expect(sql).toMatch(/ORDER BY start_ts DESC/)
  })

  it('applies start/end time filter on start_ts column', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getSessionSummaries(mockClient as any, {
      session_id: 's1',
      start_time: 1700000000,
      end_time: 1700100000,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/start_ts >= 1700000000/)
    expect(sql).toMatch(/start_ts <= 1700100000/)
  })

  it('filters by keyword client-side after fetching rows', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        rows: [
          { id: 1, start_ts: 100, end_ts: 200, message_count: 50, summary: 'discussed travel plans' },
          { id: 2, start_ts: 300, end_ts: 400, message_count: 30, summary: 'lunch decision' },
          { id: 3, start_ts: 500, end_ts: 600, message_count: 20, summary: 'travel costs' },
        ],
      },
    })
    const out = await getSessionSummaries(mockClient as any, {
      session_id: 's1',
      keywords: ['travel'],
      format: 'json',
    })
    const data = JSON.parse(out)
    expect(data.returned).toBe(2)
    expect(data.sessions.every((s: any) => /travel/i.test(s.summary))).toBe(true)
  })

  it('returns informative text when no summaries exist', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    const out = await getSessionSummaries(mockClient as any, { session_id: 's1', format: 'text' })
    expect(out).toMatch(/no.*summar|generate|haven't/i)
  })

  it('returns informative text when table missing (older schema)', async () => {
    mockClient.post.mockRejectedValue(new Error('SQL execution error: no such table: chat_session'))
    const out = await getSessionSummaries(mockClient as any, { session_id: 's1', format: 'text' })
    expect(out).toMatch(/newer.*schema|reimport/i)
  })
})

describe('deep_search_messages', () => {
  it('joins message_fts and uses MATCH with OR-joined keywords', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { rows: [{ id: 50, ts: 1000 }] } })  // hits
      .mockResolvedValueOnce({ data: { rows: [] } })                       // context
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['hello', 'world'], format: 'json',
    })
    const sql1 = mockClient.post.mock.calls[0][1].sql as string
    expect(sql1).toMatch(/JOIN message_fts/)
    expect(sql1).toMatch(/message_fts MATCH/)
    expect(sql1).toMatch(/"hello" OR "world"/)
  })

  it('escapes double quotes in keywords', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { rows: [] } })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['say "hi"'], format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/"say ""hi"""/)
  })

  it('expands hits into context window via second query', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { rows: [{ id: 100, ts: 1000 }, { id: 200, ts: 2000 }] } })
      .mockResolvedValueOnce({
        data: {
          rows: [
            { id: 98, ts: 990, content: 'before', senderName: 'A' },
            { id: 100, ts: 1000, content: 'hit1', senderName: 'B' },
            { id: 198, ts: 1990, content: 'before2', senderName: 'A' },
            { id: 200, ts: 2000, content: 'hit2', senderName: 'B' },
          ],
        },
      })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['x'], context_before: 2, context_after: 0, format: 'json',
    })
    const sql2 = mockClient.post.mock.calls[1][1].sql as string
    expect(sql2).toMatch(/m\.id BETWEEN 98 AND 100/)
    expect(sql2).toMatch(/m\.id BETWEEN 198 AND 200/)
  })

  it('applies sender_id and time filters in hits query', async () => {
    mockClient.post.mockResolvedValueOnce({ data: { rows: [] } })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['x'],
      sender_id: 7, start_time: 1700000000, end_time: 1700100000,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.sender_id = 7/)
    expect(sql).toMatch(/m\.ts >= 1700000000/)
    expect(sql).toMatch(/m\.ts <= 1700100000/)
  })

  it('returns informative text when no hits', async () => {
    mockClient.post.mockResolvedValueOnce({ data: { rows: [] } })
    const out = await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['nothing'], format: 'text',
    })
    expect(out).toMatch(/no.*match|0 hits/i)
  })

  it('caps limit at 1000', async () => {
    mockClient.post.mockResolvedValueOnce({ data: { rows: [] } })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['x'], limit: 99999, format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 1000/)
  })

  it('runs the context query even when context_before=0 and context_after=0', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { rows: [{ id: 50, ts: 1000 }] } })
      .mockResolvedValueOnce({ data: { rows: [{ id: 50, ts: 1000, content: 'hit', senderName: 'A' }] } })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['x'], context_before: 0, context_after: 0, format: 'json',
    })
    expect(mockClient.post).toHaveBeenCalledTimes(2)
    const ctxSql = mockClient.post.mock.calls[1][1].sql as string
    expect(ctxSql).toMatch(/m\.id BETWEEN 50 AND 50/)
  })
})

describe('get_time_stats', () => {
  it('hourly groups by strftime %H on localized ts', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'hourly', timezone: 'Asia/Shanghai', format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/strftime\('%H'/)
    expect(sql).toMatch(/\(ts \+ 28800\)/)
    expect(sql).toMatch(/GROUP BY bucket/)
  })

  it('weekday groups by strftime %w', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'weekday', format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/strftime\('%w'/)
  })

  it('daily groups by date()', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'daily', format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/date\(/)
  })

  it('formats hourly text output with peak hour', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [
        { bucket: 9, count: 100 },
        { bucket: 21, count: 500 },
      ] },
    })
    const out = await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'hourly', format: 'text',
    })
    expect(out).toMatch(/peakHour: 21:00/)
    expect(out).toMatch(/500/)
  })

  it('formats weekday text output with weekday names', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [{ bucket: 1, count: 50 }, { bucket: 0, count: 200 }] },
    })
    const out = await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'weekday', format: 'text',
    })
    expect(out).toMatch(/Sunday/i)
    expect(out).toMatch(/200/)
  })

  it('applies time filter', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'hourly',
      start_time: 1700000000, end_time: 1700100000, format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/ts >= 1700000000/)
  })

  it('formats daily text output with peakDay and avgPerActiveDay', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [
        { bucket: '2025-01-01', count: 100 },
        { bucket: '2025-01-02', count: 300 },
        { bucket: '2025-01-03', count: 200 },
      ] },
    })
    const out = await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'daily', format: 'text',
    })
    expect(out).toMatch(/peakDay: 2025-01-02 \(300\)/)
    expect(out).toMatch(/days: 3/)
    expect(out).toMatch(/total: 600/)
    expect(out).toMatch(/avgPerActiveDay: 200/)
  })

  it('handles empty rows in text mode via formatToolResultAsText', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    const out = await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'hourly', format: 'text',
    })
    expect(out).toMatch(/total: 0/)
    expect(out).toMatch(/type: hourly/)
  })
})

describe('get_member_activity', () => {
  it('uses CTE with percentage', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMemberActivity(mockClient as any, { session_id: 's1', format: 'json' })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/WITH counts AS/)
    expect(sql).toMatch(/JOIN member/)
    expect(sql).toMatch(/percentage/)
    expect(sql).toMatch(/ORDER BY c\.msg_count DESC/)
  })

  it('caps top_n at 50', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMemberActivity(mockClient as any, { session_id: 's1', top_n: 9999, format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 50/)
  })

  it('defaults top_n to 10', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMemberActivity(mockClient as any, { session_id: 's1', format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 10/)
  })

  it('formats text output with rank/name/count/percent', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [
        { id: 1, platform_id: 'a', account_name: 'Alice', group_nickname: null, msg_count: 100, percentage: 50.0 },
        { id: 2, platform_id: 'b', account_name: null, group_nickname: 'Bob', msg_count: 100, percentage: 50.0 },
      ] },
    })
    const out = await getMemberActivity(mockClient as any, { session_id: 's1', format: 'text' })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/Bob/)
    expect(out).toMatch(/50/)
  })
})

describe('get_member_name_history', () => {
  it('queries member_name_history filtered by member_id', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMemberNameHistory(mockClient as any, {
      session_id: 's1', member_id: 7, format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/FROM member_name_history/)
    expect(sql).toMatch(/member_id = 7/)
    expect(sql).toMatch(/ORDER BY start_ts/)
  })

  it('formats text output with name_type and time range', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [
        { name_type: 'account', name: 'Alice', start_ts: 1700000000, end_ts: null },
        { name_type: 'nickname', name: 'A', start_ts: 1700000500, end_ts: 1700100000 },
      ] },
    })
    const out = await getMemberNameHistory(mockClient as any, {
      session_id: 's1', member_id: 7, format: 'text',
    })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/account/)
    expect(out).toMatch(/nickname/)
  })

  it('returns informative text when no history rows', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    const out = await getMemberNameHistory(mockClient as any, {
      session_id: 's1', member_id: 99, format: 'text',
    })
    expect(out).toMatch(/no.*history|not found/i)
  })
})
