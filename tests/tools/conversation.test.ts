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

    expect(result.messages.length).toBe(3)
  })

  it('clamps max_total_messages at FULL_CONVERSATION_TOTAL_MAX (2000)', async () => {
    // Mock the SQL response to always return one full page of 500 + 1 trailing row (501 rows).
    // With max_total_messages=99999, the function should loop and accumulate; we cap collection.
    // Provide 4 full pages worth of data; expect accumulation stops at 2000.
    const fullPage = (offset: number) =>
      Array.from({ length: 501 }, (_, i) => [offset + i, offset + i, 0, `msg${offset + i}`, 'pa', 'Alice'])

    mockClient.post
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: fullPage(0),
        },
      })
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: fullPage(500),
        },
      })
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: fullPage(1000),
        },
      })
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: fullPage(1500),
        },
      })

    const result = await fetchFullConversation(mockClient, {
      session_id: 's1',
      max_total_messages: 99999,
    })

    expect(result.messages.length).toBe(2000)
  })

  it('accumulates messages across multiple pages and reports pagesFetched in extra', async () => {
    // Page 1: full 500-row page (sqlInternal returns 501 rows; trimmed to 500)
    const fullPage = Array.from({ length: 501 }, (_, i) => [i, i, 0, `m${i}`, 'pa', 'Alice'])
    // Page 2: short page (10 rows) → terminates the loop
    const shortPage = Array.from({ length: 10 }, (_, i) => [500 + i, 500 + i, 0, `m${500 + i}`, 'pa', 'Alice'])

    mockClient.post
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: fullPage,
        },
      })
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: shortPage,
        },
      })

    const result = await fetchFullConversation(mockClient, {
      session_id: 's1',
      max_total_messages: 1000,
    })

    expect(result.messages.length).toBe(510)
    expect(result.extra?.pagesFetched).toBe(2)
  })

  it('forwards filter_invalid=false to the underlying fetch so SQL fast path is bypassed', async () => {
    // When filter_invalid is false, fetchMessagesViaRest should route to REST not SQL.
    mockClient.get.mockResolvedValue({
      data: { messages: [], total: 0, page: 1 },
    })

    await fetchFullConversation(mockClient, {
      session_id: 's1',
      filter_invalid: false,
      max_total_messages: 50,
    })

    expect(mockClient.get).toHaveBeenCalled()
    expect(mockClient.post).not.toHaveBeenCalled()
  })
})
