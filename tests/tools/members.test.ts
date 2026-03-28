import { describe, it, expect, vi } from 'vitest'
import { getMembers } from '../../src/tools/members.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

describe('getMembers', () => {
  it('calls members endpoint with session id', async () => {
    const members = [{ platformId: 'user1', name: 'Alice', role: 'member' }]
    mockClient.get.mockResolvedValue(members)

    const result = await getMembers(mockClient as any, 3)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/3/members')
    expect(JSON.parse(result)).toEqual(members)
  })
})
