import { describe, it, expect, vi } from 'vitest'
import { getStatsOverview } from '../../src/tools/stats.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

describe('getStatsOverview', () => {
  it('calls stats/overview endpoint with session id', async () => {
    const stats = { totalMessages: 1500, activeMemberCount: 12 }
    mockClient.get.mockResolvedValue(stats)

    const result = await getStatsOverview(mockClient as any, 7)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/7/stats/overview')
    expect(JSON.parse(result)).toEqual(stats)
  })
})
