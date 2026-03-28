export class ChatLabError extends Error {
  constructor(
    public readonly status: number | null,
    message: string
  ) {
    super(message)
    this.name = 'ChatLabError'
  }
}

export class ChatLabClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>
  ): Promise<T> {
    const url = new URL(path, this.baseUrl)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
    }

    let response: Response
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new ChatLabError(
        null,
        'ChatLab is not running or API is disabled. Please start ChatLab and enable the API in Settings.'
      )
    }

    if (response.status === 401) {
      throw new ChatLabError(401, 'Invalid API token. Please check your CHATLAB_TOKEN.')
    }
    if (response.status === 404) {
      throw new ChatLabError(404, `Not found: ${path}`)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ChatLabError(response.status, `API error ${response.status}: ${text}`)
    }

    return response.json() as Promise<T>
  }

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, undefined, params)
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }
}
