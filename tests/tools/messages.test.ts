import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchMessagesViaRest, getMessages } from '../../src/tools/messages.js'

const mockClient: any = { get: vi.fn(), post: vi.fn() }

beforeEach(() => {
  mockClient.get.mockReset()
  mockClient.post.mockReset()
})

describe('fetchMessagesViaRest', () => {
  it('calls messages endpoint with session_id', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [{ id: 1, senderName: 'A', senderPlatformId: 'pa', content: 'Hi', timestamp: 100, type: 0 }], total: 1, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc', filter_invalid: false })

    expect(mockClient.get).toHaveBeenCalledWith(
      '/api/v1/sessions/chat_5_abc/messages',
      expect.any(Object),
    )
  })

  it('defaults limit to 100', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc', filter_invalid: false })

    const params = mockClient.get.mock.calls[0][1]
    expect(params.limit).toBe('100')
  })

  it('caps limit at MESSAGES_PER_PAGE_MAX (500)', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc', limit: 9999, filter_invalid: false })

    const params = mockClient.get.mock.calls[0][1]
    expect(params.limit).toBe('500')
  })

  it('passes all REST-eligible filters as string query params', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, {
      session_id: 'chat_5_abc',
      keyword: 'hello',
      start_time: 1700000000,
      end_time: 1700100000,
      sender_id: 'user123',
      type: 1,
      page: 2,
      limit: 50,
      filter_invalid: false,
    })

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/chat_5_abc/messages', {
      keyword: 'hello',
      startTime: '1700000000',
      endTime: '1700100000',
      sender_id: 'user123',
      type: '1',
      page: '2',
      limit: '50',
    })
  })

  it('preserves id and senderPlatformId in RawMessage output', async () => {
    mockClient.get.mockResolvedValue({
      data: {
        messages: [
          {
            id: 42,
            senderName: 'Alice',
            senderPlatformId: 'p_alice',
            senderAvatar: 'http://example.com/a.png',
            senderAliases: ['Al'],
            senderId: 999,
            content: 'Hi',
            timestamp: 100,
            type: 0,
            replyToMessageId: null,
          },
        ],
        total: 1,
        page: 1,
      },
    })

    const result = await fetchMessagesViaRest(mockClient, {
      session_id: 's1',
      keyword: 'hi',
      filter_invalid: false,
    })

    expect(result.messages[0]).toEqual({
      id: 42,
      senderName: 'Alice',
      senderPlatformId: 'p_alice',
      content: 'Hi',
      timestamp: 100,
      type: 0,
    })
  })

  it('returns total and page from REST response', async () => {
    mockClient.get.mockResolvedValue({
      data: { messages: [], total: 250, page: 3 },
    })

    const result = await fetchMessagesViaRest(mockClient, {
      session_id: 's1',
      keyword: 'x',
      filter_invalid: false,
    })

    expect(result.total).toBe(250)
    expect(result.page).toBe(3)
  })

  it('omits undefined optional params from query', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc', filter_invalid: false })

    const params = mockClient.get.mock.calls[0][1]
    expect(params).not.toHaveProperty('keyword')
    expect(params).not.toHaveProperty('startTime')
    expect(params).not.toHaveProperty('endTime')
  })

  it('forwards filter_invalid through getMessages so callers can opt out of SQL', async () => {
    mockClient.get.mockResolvedValue({
      data: { messages: [], total: 0, page: 1 },
    })

    await getMessages(mockClient, {
      session_id: 's1',
      filter_invalid: false,
      keyword: undefined,
    })

    expect(mockClient.get).toHaveBeenCalled()
    expect(mockClient.post).not.toHaveBeenCalled()
  })
})

describe('fetchMessagesViaRest — SQL fast path routing', () => {
  it('routes to SQL when filter_invalid is true (default) and no keyword', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [[1, 100, 0, 'hi', 'pa', 'Alice']],
      },
    })

    await fetchMessagesViaRest(mockClient, { session_id: 's1' })

    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/v1/sessions/s1/sql',
      expect.objectContaining({ sql: expect.stringContaining('FROM message msg') }),
    )
    expect(mockClient.get).not.toHaveBeenCalled()
  })

  it('routes to REST when keyword is present (FTS5 lives upstream)', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 's1', keyword: 'hello' })

    expect(mockClient.get).toHaveBeenCalled()
    expect(mockClient.post).not.toHaveBeenCalled()
  })

  it('routes to REST when filter_invalid is explicitly false', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 's1', filter_invalid: false })

    expect(mockClient.get).toHaveBeenCalled()
    expect(mockClient.post).not.toHaveBeenCalled()
  })

  it('SQL path filters system messages and non-text types by default', async () => {
    mockClient.post.mockResolvedValue({ data: { columns: ['id'], rows: [] } })

    await fetchMessagesViaRest(mockClient, { session_id: 's1' })

    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toContain('msg.type = 0')
    expect(sql).toContain("msg.content != ''")
    expect(sql).toContain("COALESCE(m.account_name, '') != '系统消息'")
  })

  it('SQL path returns has_more=true when more than `limit` rows returned', async () => {
    // Request limit+1 trick: 3 limit means SQL returns up to 4 rows
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [
          [1, 100, 0, 'a', 'p1', 'A'],
          [2, 200, 0, 'b', 'p2', 'B'],
          [3, 300, 0, 'c', 'p3', 'C'],
          [4, 400, 0, 'd', 'p4', 'D'],
        ],
      },
    })

    const result = await fetchMessagesViaRest(mockClient, { session_id: 's1', limit: 3 })

    expect(result.messages).toHaveLength(3)
    expect(result.has_more).toBe(true)
  })

  it('SQL path returns has_more=false when fewer than limit+1 rows', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [[1, 100, 0, 'a', 'p1', 'A']],
      },
    })

    const result = await fetchMessagesViaRest(mockClient, { session_id: 's1', limit: 3 })

    expect(result.has_more).toBe(false)
    expect(result.messages).toHaveLength(1)
  })

  it('routes to REST when both keyword and type=0 are present (keyword wins)', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 's1', keyword: 'hello', type: 0 })

    expect(mockClient.get).toHaveBeenCalled()
    expect(mockClient.post).not.toHaveBeenCalled()
  })

  it('getMessages emits a pagination instruction when SQL path reports has_more', async () => {
    // 4 rows for limit=3 → has_more=true
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [
          [1, 100, 0, 'a', 'p1', 'A'],
          [2, 200, 0, 'b', 'p2', 'B'],
          [3, 300, 0, 'c', 'p3', 'C'],
          [4, 400, 0, 'd', 'p4', 'D'],
        ],
      },
    })

    const text = await getMessages(mockClient, { session_id: 's1', limit: 3 })

    expect(text).toContain('page=2')
    expect(text).toContain('s1')
  })
})
