import { describe, it, expect, vi } from 'vitest'
import { getStatsOverview } from '../../src/tools/stats.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

describe('getStatsOverview', () => {
  it('calls stats/overview endpoint with session id', async () => {
    mockClient.get.mockResolvedValue({ data: { messageCount: 1500 } })

    const result = await getStatsOverview(mockClient as any, 'chat_7_abc', 'json')

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/chat_7_abc/stats/overview')
    expect(JSON.parse(result).data.messageCount).toBe(1500)
  })

  it('converts numeric messageTypeDistribution keys to labels', async () => {
    mockClient.get.mockResolvedValue({
      data: { messageTypeDistribution: { '0': 100, '1': 20, '99': 5 } },
    })

    const result = JSON.parse(await getStatsOverview(mockClient as any, 'chat_7_abc', 'json'))
    const dist = result.data.messageTypeDistribution

    expect(dist).toHaveProperty('text', 100)
    expect(dist).toHaveProperty('image', 20)
    expect(dist).toHaveProperty('other', 5)
    expect(dist).not.toHaveProperty('0')
  })
})
