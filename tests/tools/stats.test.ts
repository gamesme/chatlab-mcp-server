import { describe, it, expect, vi } from 'vitest'
import { getStatsOverview } from '../../src/tools/stats.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

describe('getStatsOverview', () => {
  it('calls stats/overview endpoint with session id', async () => {
    const stats = { totalMessages: 1500, activeMemberCount: 12 }
    mockClient.get.mockResolvedValue(stats)

    const result = await getStatsOverview(mockClient as any, 'chat_7_abc')

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/chat_7_abc/stats/overview')
    expect(JSON.parse(result)).toEqual(stats)
  })
})
