import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchMessagesViaRest } from '../../src/tools/messages.js'

const mockClient: any = { get: vi.fn(), post: vi.fn() }

beforeEach(() => {
  mockClient.get.mockReset()
  mockClient.post.mockReset()
})

describe('fetchMessagesViaRest', () => {
  it('calls messages endpoint with session_id', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [{ id: 1, senderName: 'A', senderPlatformId: 'pa', content: 'Hi', timestamp: 100, type: 0 }], total: 1, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc' })

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
})
