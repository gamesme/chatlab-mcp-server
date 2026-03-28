import { describe, it, expect, vi } from 'vitest'
import { getMembers } from '../../src/tools/members.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

describe('getMembers', () => {
  it('strips avatar from members', async () => {
    const raw = {
      success: true,
      data: [{ platformId: 'user1', name: 'Alice', role: 'member', avatar: 'data:image/...' }],
    }
    mockClient.get.mockResolvedValue(raw)

    const result = await getMembers(mockClient as any, 'chat_3_abc')
    const parsed = JSON.parse(result)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/chat_3_abc/members')
    expect(parsed.data[0]).not.toHaveProperty('avatar')
    expect(parsed.data[0].name).toBe('Alice')
  })
})
