import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSQL } from '../../src/tools/sql.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

beforeEach(() => mockClient.post.mockReset())

describe('executeSQL', () => {
  it('posts SELECT query to sql endpoint', async () => {
    const rows = { rows: [{ count: 42 }] }
    mockClient.post.mockResolvedValue(rows)

    const result = await executeSQL(mockClient as any, 5, 'SELECT count(*) FROM messages')

    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/sessions/5/sql', {
      query: 'SELECT count(*) FROM messages',
    })
    expect(JSON.parse(result)).toEqual(rows)
  })

  it('rejects non-SELECT queries', async () => {
    await expect(
      executeSQL(mockClient as any, 5, 'DROP TABLE messages')
    ).rejects.toThrow('Only SELECT queries are allowed')
  })

  it('rejects DELETE with leading whitespace', async () => {
    await expect(
      executeSQL(mockClient as any, 5, '  DELETE FROM messages')
    ).rejects.toThrow('Only SELECT queries are allowed')
  })

  it('allows SELECT with leading whitespace', async () => {
    mockClient.post.mockResolvedValue({ rows: [] })
    await expect(
      executeSQL(mockClient as any, 5, '  SELECT 1')
    ).resolves.toBeDefined()
  })
})
