import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildTimeFilter,
  timezoneOffsetSeconds,
  localTsExpr,
  sqlEscape,
  fetchMessageContextViaSql,
} from '../../src/tools/analytics.js'
import { fetchConversationBetweenViaSql } from '../../src/tools/analytics.js'
import { getSessionSummaries } from '../../src/tools/analytics.js'
import { fetchDeepSearchViaSql } from '../../src/tools/analytics.js'
import { getTimeStats } from '../../src/tools/analytics.js'
import { getMemberActivity } from '../../src/tools/analytics.js'
import { getMemberNameHistory } from '../../src/tools/analytics.js'
import { getResponseTimeAnalysis } from '../../src/tools/analytics.js'

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

describe('fetchMessageContextViaSql', () => {
  it('queries with ts window (not id BETWEEN) around target message IDs', async () => {
    // First call: look up target ts
    mockClient.post
      .mockResolvedValueOnce({
        data: { columns: ['ts'], rows: [[1000]] },
      })
      // Second call: expand with ts window
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'ts', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: [
            [42, 950, 0, 'before', 'pa', 'Alice'],
            [43, 1000, 0, 'target', 'pb', 'Bob'],
            [44, 1050, 0, 'after', 'pa', 'Alice'],
          ],
        },
      })

    const result = await fetchMessageContextViaSql(mockClient as any, {
      session_id: 's1',
      message_ids: [43],
      context_size: 10,
    })

    expect(mockClient.post).toHaveBeenCalledTimes(2)
    const secondSql = mockClient.post.mock.calls[1][1].sql as string
    expect(secondSql).toContain('m.ts')
    expect(secondSql).not.toContain('m.id BETWEEN')
    expect(result.messages).toHaveLength(3)
  })

  it('returns empty result when no targets exist', async () => {
    mockClient.post.mockResolvedValueOnce({
      data: { columns: ['ts'], rows: [] },
    })

    const result = await fetchMessageContextViaSql(mockClient as any, {
      session_id: 's1',
      message_ids: [99999],
    })

    expect(result.messages).toEqual([])
  })

  it('clamps context_size to [1, 100]', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { columns: ['ts'], rows: [[1000]] } })
      .mockResolvedValueOnce({ data: { columns: ['id'], rows: [] } })

    await fetchMessageContextViaSql(mockClient as any, {
      session_id: 's1',
      message_ids: [1],
      context_size: 999,
    })

    const sql = mockClient.post.mock.calls[1][1].sql as string
    // 100 messages before + 100 after each target, with 1 target = max 200 messages
    expect(sql).toMatch(/LIMIT (200|2000|210)/)
  })
})

describe('fetchConversationBetweenViaSql', () => {
  it('returns RawMessage[] with id, senderName, senderPlatformId, content, timestamp, type', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'ts', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [[1, 100, 0, 'hi', 'pa', 'Alice']],
      },
    })

    const result = await fetchConversationBetweenViaSql(mockClient as any, {
      session_id: 's1',
      member_id_1: 1,
      member_id_2: 2,
    })

    expect(result.messages).toEqual([
      { id: 1, senderName: 'Alice', senderPlatformId: 'pa', content: 'hi', timestamp: 100, type: 0 },
    ])
  })

  it('clamps limit to [1, 1000]', async () => {
    mockClient.post.mockResolvedValue({ data: { columns: ['id'], rows: [] } })

    await fetchConversationBetweenViaSql(mockClient as any, {
      session_id: 's1',
      member_id_1: 1,
      member_id_2: 2,
      limit: 99999,
    })

    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/LIMIT 1000/)
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

describe('fetchDeepSearchViaSql', () => {
  it('runs two SQL queries: FTS5 hits + context expansion', async () => {
    mockClient.post
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'ts'],
          rows: [[5, 500], [10, 1000]],
        },
      })
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'ts', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: [
            [3, 300, 0, 'before', 'pa', 'Alice'],
            [5, 500, 0, 'hit1', 'pa', 'Alice'],
            [10, 1000, 0, 'hit2', 'pb', 'Bob'],
          ],
        },
      })

    const result = await fetchDeepSearchViaSql(mockClient as any, {
      session_id: 's1',
      keywords: ['hello'],
    })

    expect(mockClient.post).toHaveBeenCalledTimes(2)
    expect(result.messages).toHaveLength(3)
    expect(result.extra).toEqual({ hits: 2 })
  })

  it('reports missing schema gracefully', async () => {
    mockClient.post.mockRejectedValue(new Error('no such table: message_fts'))

    const result = await fetchDeepSearchViaSql(mockClient as any, {
      session_id: 's1',
      keywords: ['hello'],
    })

    expect(result.messages).toEqual([])
    expect(result.extra?.message).toMatch(/newer database schema/i)
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

describe('get_response_time_analysis', () => {
  it('uses LAG window function and excludes same-sender pairs', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', format: 'json' })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/LAG\(ts\)/)
    expect(sql).toMatch(/LAG\(sender_id\)/)
    expect(sql).toMatch(/prev_sender <> sender_id/)
    expect(sql).toMatch(/BETWEEN 1 AND 3600/)
  })

  it('joins member table for names', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', format: 'json' })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/JOIN member/)
  })

  it('defaults top_n to 10, caps at 50', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 10/)

    mockClient.post.mockClear()
    await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', top_n: 9999, format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 50/)
  })

  it('formats text output with from→to and timings', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [{
        from_id: 1, to_id: 2,
        from_name: 'Alice', to_name: 'Bob',
        reply_count: 100, min_seconds: 5, avg_seconds: 120.5, max_seconds: 3500,
      }] },
    })
    const out = await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', format: 'text' })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/Bob/)
    expect(out).toMatch(/100/)
  })
})

