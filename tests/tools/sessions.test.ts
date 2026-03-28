import { describe, it, expect, vi } from 'vitest'
import { listSessions, getSession } from '../../src/tools/sessions.js'
import { ChatLabError } from '../../src/client.js'

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
}

describe('listSessions', () => {
  it('returns JSON string of sessions list', async () => {
    const sessions = [{ id: 1, name: 'Work Chat', platform: 'Slack' }]
    mockClient.get.mockResolvedValue(sessions)

    const result = await listSessions(mockClient as any)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions')
    expect(JSON.parse(result)).toEqual(sessions)
  })

  it('propagates errors from client', async () => {
    mockClient.get.mockRejectedValue(new ChatLabError(null, 'ChatLab is not running'))

    await expect(listSessions(mockClient as any)).rejects.toThrow('ChatLab is not running')
  })
})

describe('getSession', () => {
  it('returns JSON string of session by id', async () => {
    const session = { id: 42, name: 'Team Chat', platform: 'WeChat' }
    mockClient.get.mockResolvedValue(session)

    const result = await getSession(mockClient as any, 42)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/42')
    expect(JSON.parse(result)).toEqual(session)
  })
})
