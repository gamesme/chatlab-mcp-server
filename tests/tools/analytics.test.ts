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
