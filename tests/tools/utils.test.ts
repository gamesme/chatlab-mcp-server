import { describe, it, expect, vi } from 'vitest'
import { sqlInternal } from '../../src/tools/utils.js'

describe('sqlInternal', () => {
  it('posts to /sql endpoint with given sessionId and sql', async () => {
    const mockClient = { post: vi.fn().mockResolvedValue({ data: { rows: [{ n: 1 }] } }) }
    const rows = await sqlInternal(mockClient as any, 's1', 'SELECT 1')

    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/sessions/s1/sql', { sql: 'SELECT 1' })
    expect(rows).toEqual([{ n: 1 }])
  })

  it('returns empty array when response has no data', async () => {
    const mockClient = { post: vi.fn().mockResolvedValue({}) }
    const rows = await sqlInternal(mockClient as any, 's1', 'SELECT 1')
    expect(rows).toEqual([])
  })

  it('handles result.data being an array directly (legacy shape)', async () => {
    const mockClient = { post: vi.fn().mockResolvedValue({ data: [{ n: 2 }] }) }
    const rows = await sqlInternal(mockClient as any, 's1', 'SELECT 1')
    expect(rows).toEqual([{ n: 2 }])
  })

  it('converts 2D array { columns, rows } to object array', async () => {
    const mockClient = {
      post: vi.fn().mockResolvedValue({
        data: {
          columns: ['id', 'ts'],
          rows: [
            [50, 1000],
            [100, 2000],
          ],
        },
      }),
    }
    const rows = await sqlInternal(mockClient as any, 's1', 'SELECT id, ts FROM message')
    expect(rows).toEqual([
      { id: 50, ts: 1000 },
      { id: 100, ts: 2000 },
    ])
  })
})
