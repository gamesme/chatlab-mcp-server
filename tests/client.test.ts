import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChatLabClient, ChatLabError } from '../src/client.js'

describe('ChatLabClient', () => {
  const client = new ChatLabClient('http://127.0.0.1:5200', 'test-token')

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('get()', () => {
    it('sends GET with Bearer token and returns JSON', async () => {
      const mockData = [{ id: 1, name: 'Test Session' }]
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(mockData), { status: 200 }))

      const result = await client.get('/api/v1/sessions')

      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5200/api/v1/sessions',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      )
      expect(result).toEqual(mockData)
    })

    it('appends query params to URL', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))

      await client.get('/api/v1/sessions/1/messages', { keyword: 'hello', page: '2' })

      const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
      expect(calledUrl).toContain('keyword=hello')
      expect(calledUrl).toContain('page=2')
    })

    it('throws ChatLabError with null status on connection error', async () => {
      vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'))

      const promise = client.get('/api/v1/sessions')
      await expect(promise).rejects.toThrow(ChatLabError)
      await expect(promise).rejects.toMatchObject({
        status: null,
        message: expect.stringContaining('ChatLab is not running'),
      })
    })

    it('throws ChatLabError(401) on invalid token', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }))

      const promise = client.get('/api/v1/sessions')
      await expect(promise).rejects.toThrow(ChatLabError)
      await expect(promise).rejects.toMatchObject({
        status: 401,
        message: expect.stringContaining('Invalid API token'),
      })
    })

    it('throws ChatLabError(404) on not found', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Not Found', { status: 404 }))

      const promise = client.get('/api/v1/sessions/99')
      await expect(promise).rejects.toThrow(ChatLabError)
      await expect(promise).rejects.toMatchObject({ status: 404 })
    })

    it('throws ChatLabError with status and body on other HTTP errors', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 })
      )

      await expect(client.get('/api/v1/sessions')).rejects.toMatchObject({
        status: 500,
        message: expect.stringContaining('500'),
      })
    })
  })

  describe('post()', () => {
    it('sends POST with JSON body and Bearer token', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('{"rows":[]}', { status: 200 }))

      const body = { query: 'SELECT 1' }
      await client.post('/api/v1/sessions/1/sql', body)

      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5200/api/v1/sessions/1/sql',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(body),
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
        })
      )
    })

    it('throws ChatLabError(401) on invalid token', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }))

      const promise = client.post('/api/v1/sessions/1/sql', { query: 'SELECT 1' })
      await expect(promise).rejects.toMatchObject({ status: 401 })
    })

    it('throws ChatLabError with null status on connection error', async () => {
      vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'))

      const promise = client.post('/api/v1/sessions/1/sql', { query: 'SELECT 1' })
      await expect(promise).rejects.toMatchObject({ status: null })
    })
  })
})
