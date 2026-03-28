import { describe, it, expect, vi } from 'vitest'
import { listSessions, getSession } from '../../src/tools/sessions.js'
import { ChatLabError } from '../../src/client.js'

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
}

describe('listSessions', () => {
  it('strips groupAvatar and dbPath, returns cleaned sessions', async () => {
    const raw = {
      success: true,
      data: [{ id: 1, name: 'Work Chat', platform: 'Slack', groupAvatar: 'data:image/...', dbPath: '/private/db' }],
    }
    mockClient.get.mockResolvedValue(raw)

    const result = await listSessions(mockClient as any)
    const parsed = JSON.parse(result)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions')
    expect(parsed.data[0]).not.toHaveProperty('groupAvatar')
    expect(parsed.data[0]).not.toHaveProperty('dbPath')
    expect(parsed.data[0].name).toBe('Work Chat')
  })

  it('propagates errors from client', async () => {
    mockClient.get.mockRejectedValue(new ChatLabError(null, 'ChatLab is not running'))

    await expect(listSessions(mockClient as any)).rejects.toThrow('ChatLab is not running')
  })
})

describe('getSession', () => {
  it('strips groupAvatar and dbPath from single session', async () => {
    const raw = {
      success: true,
      data: { id: 42, name: 'Team Chat', platform: 'WeChat', groupAvatar: 'data:image/...', dbPath: '/private/db' },
    }
    mockClient.get.mockResolvedValue(raw)

    const result = await getSession(mockClient as any, 42)
    const parsed = JSON.parse(result)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/42')
    expect(parsed.data).not.toHaveProperty('groupAvatar')
    expect(parsed.data).not.toHaveProperty('dbPath')
    expect(parsed.data.name).toBe('Team Chat')
  })
})
