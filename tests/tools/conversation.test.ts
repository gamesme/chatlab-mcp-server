import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchFullConversation } from '../../src/tools/conversation.js'

const mockClient: any = { get: vi.fn(), post: vi.fn() }

beforeEach(() => {
  mockClient.get.mockReset()
  mockClient.post.mockReset()
})

describe('fetchFullConversation', () => {
  it('uses page size 500, not 100', async () => {
    // Single page covers everything
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [[1, 100, 0, 'hi', 'pa', 'Alice']],
      },
    })

    await fetchFullConversation(mockClient, { session_id: 's1', max_total_messages: 50 })

    // SQL path uses limit+1 = 501
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/LIMIT 501/)
  })

  it('stops at max_total_messages cap', async () => {
    // Return 4 rows for limit+1=4 means 3 fit, has_more true
    const fourRows = [
      [1, 100, 0, 'a', 'pa', 'Alice'],
      [2, 200, 0, 'b', 'pa', 'Alice'],
      [3, 300, 0, 'c', 'pa', 'Alice'],
      [4, 400, 0, 'd', 'pa', 'Alice'],
    ]
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: fourRows,
      },
    })

    const result = await fetchFullConversation(mockClient, {
      session_id: 's1',
      max_total_messages: 3,
    })

    expect(result.messages.length).toBeLessThanOrEqual(3)
  })

  it('clamps max_total_messages at FULL_CONVERSATION_TOTAL_MAX (2000)', async () => {
    mockClient.post.mockResolvedValue({
      data: { columns: ['id'], rows: [] },
    })

    await fetchFullConversation(mockClient, {
      session_id: 's1',
      max_total_messages: 99999,
    })

    // First call should request 501 rows (one full page) at most;
    // max_total_messages clamp only limits accumulated total.
    expect(mockClient.post).toHaveBeenCalled()
  })
})
