import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getMessages } from '../../src/tools/messages.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

beforeEach(() => mockClient.get.mockReset())

describe('getMessages', () => {
  it('calls messages endpoint with session_id', async () => {
    const page = { messages: [{ id: 1, content: 'Hello' }], total: 1 }
    mockClient.get.mockResolvedValue(page)

    await getMessages(mockClient as any, { session_id: 'chat_5_abc' })

    expect(mockClient.get).toHaveBeenCalledWith(
      '/api/v1/sessions/chat_5_abc/messages',
      expect.any(Object)
    )
  })

  it('passes all optional filters as string query params', async () => {
    mockClient.get.mockResolvedValue({ messages: [] })

    await getMessages(mockClient as any, {
      session_id: 'chat_5_abc',
      keyword: 'hello',
      start_time: 1700000000,
      end_time: 1700100000,
      sender_id: 'user123',
      type: 1,
      page: 2,
      limit: 50,
    })

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/chat_5_abc/messages', {
      keyword: 'hello',
      start_time: '1700000000',
      end_time: '1700100000',
      sender_id: 'user123',
      type: '1',
      page: '2',
      limit: '50',
    })
  })

  it('omits undefined optional params from query', async () => {
    mockClient.get.mockResolvedValue({ messages: [] })

    await getMessages(mockClient as any, { session_id: 'chat_5_abc' })

    const params = mockClient.get.mock.calls[0][1]
    expect(params).not.toHaveProperty('keyword')
    expect(params).not.toHaveProperty('sender_id')
    expect(params).not.toHaveProperty('start_time')
  })

  it('returns JSON string of response', async () => {
    const page = { messages: [{ id: 1 }], total: 1 }
    mockClient.get.mockResolvedValue(page)

    const result = await getMessages(mockClient as any, { session_id: 'chat_5_abc' })
    expect(JSON.parse(result)).toEqual(page)
  })
})
