import { describe, it, expect, vi } from 'vitest'
import { exportSession } from '../../src/tools/export.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

describe('exportSession', () => {
  it('calls export endpoint with session id', async () => {
    const exportData = { version: 1, messages: [{ id: 1 }] }
    mockClient.get.mockResolvedValue(exportData)

    const result = await exportSession(mockClient as any, 9)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/9/export')
    expect(JSON.parse(result)).toEqual(exportData)
  })
})
