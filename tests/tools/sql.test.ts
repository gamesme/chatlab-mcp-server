import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSQL } from '../../src/tools/sql.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

beforeEach(() => mockClient.post.mockReset())

describe('executeSQL', () => {
  it('posts SELECT query to sql endpoint', async () => {
    const rows = { rows: [{ count: 42 }] }
    mockClient.post.mockResolvedValue(rows)

    const result = await executeSQL(mockClient as any, 'chat_5_abc', 'SELECT count(*) FROM message')

    expect(mockClient.post).toHaveBeenCalledWith('/api/v1/sessions/chat_5_abc/sql', {
      sql: 'SELECT count(*) FROM message LIMIT 200',
    })
    expect(JSON.parse(result)).toEqual(rows)
  })

  it('does not inject LIMIT when query already has one', async () => {
    mockClient.post.mockResolvedValue({ rows: [] })

    await executeSQL(mockClient as any, 'chat_5_abc', 'SELECT * FROM message LIMIT 10')

    const { sql } = mockClient.post.mock.calls[0][1] as { sql: string }
    expect(sql.toUpperCase().match(/LIMIT/g)?.length).toBe(1)
  })

  it('rejects non-SELECT queries', async () => {
    await expect(
      executeSQL(mockClient as any, 'chat_5_abc', 'DROP TABLE message')
    ).rejects.toThrow('Only SELECT queries are allowed')
  })

  it('rejects DELETE with leading whitespace', async () => {
    await expect(
      executeSQL(mockClient as any, 'chat_5_abc', '  DELETE FROM message')
    ).rejects.toThrow('Only SELECT queries are allowed')
  })

  it('allows SELECT with leading whitespace', async () => {
    mockClient.post.mockResolvedValue({ rows: [] })
    await expect(
      executeSQL(mockClient as any, 'chat_5_abc', '  SELECT 1')
    ).resolves.toBeDefined()
  })
})
