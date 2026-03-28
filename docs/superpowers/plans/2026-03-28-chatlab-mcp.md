# chatlab-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript MCP server exposing 7 tools for querying ChatLab chat history via stdio transport.

**Architecture:** A single Node.js process receives MCP tool calls over stdin/stdout, translates them to HTTP requests against ChatLab's local REST API (`http://127.0.0.1:5200/api/v1`), and returns results as JSON text. The HTTP layer (`client.ts`) handles auth and error normalization; each tool group is a focused module that registers handlers on the McpServer.

**Tech Stack:** TypeScript 5, `@modelcontextprotocol/sdk` (McpServer + StdioServerTransport), `zod` (parameter schemas), `vitest` (testing), `tsx` (dev runner)

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Parse `--url`/`--token` CLI flags and env vars, connect StdioServerTransport |
| `src/client.ts` | fetch wrapper with Bearer auth and unified error handling; exports `ChatLabClient` and `ChatLabError` |
| `src/server.ts` | Create McpServer, register all 7 tools by calling each tool module's `register*` function |
| `src/tools/sessions.ts` | `list_sessions`, `get_session` tools; exports handler functions for testing |
| `src/tools/messages.ts` | `get_messages` tool with all filter params |
| `src/tools/members.ts` | `get_members` tool |
| `src/tools/stats.ts` | `get_stats_overview` tool |
| `src/tools/sql.ts` | `execute_sql` tool with SELECT-only guard |
| `src/tools/export.ts` | `export_session` tool |
| `tests/client.test.ts` | Unit tests for ChatLabClient with mocked fetch |
| `tests/tools/*.test.ts` | Unit tests for each tool, mocking ChatLabClient |

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "chatlab-mcp",
  "version": "0.1.0",
  "description": "MCP server for ChatLab chat history",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.10.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
  },
})
```

- [ ] **Step 4: Install dependencies**

```bash
npm install
```
Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Create directory structure**

```bash
mkdir -p src/tools tests/tools
```

- [ ] **Step 6: Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts
git commit -m "chore: initialize project scaffold"
```

---

### Task 2: ChatLabClient

**Files:**
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/client.test.ts`:

```typescript
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

      await expect(client.get('/api/v1/sessions')).rejects.toThrow(ChatLabError)
      await expect(client.get('/api/v1/sessions')).rejects.toMatchObject({
        status: null,
        message: expect.stringContaining('ChatLab is not running'),
      })
    })

    it('throws ChatLabError(401) on invalid token', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }))

      await expect(client.get('/api/v1/sessions')).rejects.toThrow(ChatLabError)
      await expect(client.get('/api/v1/sessions')).rejects.toMatchObject({
        status: 401,
        message: expect.stringContaining('Invalid API token'),
      })
    })

    it('throws ChatLabError(404) on not found', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Not Found', { status: 404 }))

      await expect(client.get('/api/v1/sessions/99')).rejects.toThrow(ChatLabError)
      await expect(client.get('/api/v1/sessions/99')).rejects.toMatchObject({ status: 404 })
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
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/client.test.ts
```
Expected: FAIL — `../src/client.js` not found.

- [ ] **Step 3: Implement src/client.ts**

```typescript
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
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/client.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat: add ChatLabClient with error handling"
```

---

### Task 3: Session Tools

**Files:**
- Create: `src/tools/sessions.ts`
- Create: `tests/tools/sessions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/sessions.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/tools/sessions.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/tools/sessions.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function listSessions(client: Pick<ChatLabClient, 'get'>): Promise<string> {
  const sessions = await client.get('/api/v1/sessions')
  return JSON.stringify(sessions, null, 2)
}

export async function getSession(
  client: Pick<ChatLabClient, 'get'>,
  id: number
): Promise<string> {
  const session = await client.get(`/api/v1/sessions/${id}`)
  return JSON.stringify(session, null, 2)
}

function toolError(e: unknown, sessionId?: number): { content: [{ type: 'text'; text: string }]; isError: true } {
  let message: string
  if (e instanceof ChatLabError && e.status === 404 && sessionId !== undefined) {
    message = `Session not found: ${sessionId}`
  } else {
    message = e instanceof Error ? e.message : 'Unknown error'
  }
  return { content: [{ type: 'text' as const, text: message }], isError: true as const }
}

export function registerSessionTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'list_sessions',
    'Lists all imported chat sessions with name, platform, message count, and time range.',
    {},
    async () => {
      try {
        return { content: [{ type: 'text' as const, text: await listSessions(client) }] }
      } catch (e) {
        return toolError(e)
      }
    }
  )

  server.tool(
    'get_session',
    'Gets full details of a single session by ID.',
    { id: z.number().describe('Session ID') },
    async ({ id }) => {
      try {
        return { content: [{ type: 'text' as const, text: await getSession(client, id) }] }
      } catch (e) {
        return toolError(e, id)
      }
    }
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/tools/sessions.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/sessions.ts tests/tools/sessions.test.ts
git commit -m "feat: add list_sessions and get_session tools"
```

---

### Task 4: Messages Tool

**Files:**
- Create: `src/tools/messages.ts`
- Create: `tests/tools/messages.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/messages.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getMessages } from '../../src/tools/messages.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

beforeEach(() => mockClient.get.mockReset())

describe('getMessages', () => {
  it('calls messages endpoint with session_id', async () => {
    const page = { messages: [{ id: 1, content: 'Hello' }], total: 1 }
    mockClient.get.mockResolvedValue(page)

    await getMessages(mockClient as any, { session_id: 5 })

    expect(mockClient.get).toHaveBeenCalledWith(
      '/api/v1/sessions/5/messages',
      expect.any(Object)
    )
  })

  it('passes all optional filters as string query params', async () => {
    mockClient.get.mockResolvedValue({ messages: [] })

    await getMessages(mockClient as any, {
      session_id: 5,
      keyword: 'hello',
      start_time: 1700000000,
      end_time: 1700100000,
      sender_id: 'user123',
      type: 1,
      page: 2,
      limit: 50,
    })

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/5/messages', {
      keyword: 'hello',
      start_time: '1700000000',
      end_time: '1700100000',
      sender_id: 'user123',
      type: '1',
      page: '2',
      limit: '50',
    })
  })

  it('omits undefined optional params from query', async () => {
    mockClient.get.mockResolvedValue({ messages: [] })

    await getMessages(mockClient as any, { session_id: 5 })

    const params = mockClient.get.mock.calls[0][1]
    expect(params).not.toHaveProperty('keyword')
    expect(params).not.toHaveProperty('sender_id')
    expect(params).not.toHaveProperty('start_time')
  })

  it('returns JSON string of response', async () => {
    const page = { messages: [{ id: 1 }], total: 1 }
    mockClient.get.mockResolvedValue(page)

    const result = await getMessages(mockClient as any, { session_id: 5 })
    expect(JSON.parse(result)).toEqual(page)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/tools/messages.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/tools/messages.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

interface GetMessagesParams {
  session_id: number
  keyword?: string
  start_time?: number
  end_time?: number
  sender_id?: string
  type?: number
  page?: number
  limit?: number
}

export async function getMessages(
  client: Pick<ChatLabClient, 'get'>,
  params: GetMessagesParams
): Promise<string> {
  const { session_id, ...filters } = params
  const query: Record<string, string> = {}
  if (filters.keyword !== undefined) query.keyword = filters.keyword
  if (filters.start_time !== undefined) query.start_time = String(filters.start_time)
  if (filters.end_time !== undefined) query.end_time = String(filters.end_time)
  if (filters.sender_id !== undefined) query.sender_id = filters.sender_id
  if (filters.type !== undefined) query.type = String(filters.type)
  if (filters.page !== undefined) query.page = String(filters.page)
  if (filters.limit !== undefined) query.limit = String(filters.limit)

  const result = await client.get(`/api/v1/sessions/${session_id}/messages`, query)
  return JSON.stringify(result, null, 2)
}

export function registerMessagesTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_messages',
    'Retrieves messages from a session with optional filters for keyword, date range, sender, and pagination.',
    {
      session_id: z.number().describe('Session ID'),
      keyword: z.string().optional().describe('Substring search'),
      start_time: z.number().optional().describe('Start time as Unix timestamp (seconds)'),
      end_time: z.number().optional().describe('End time as Unix timestamp (seconds)'),
      sender_id: z.string().optional().describe('Filter by member platformId'),
      type: z.number().optional().describe('Filter by message type number'),
      page: z.number().optional().describe('Page number (default: 1)'),
      limit: z.number().optional().describe('Messages per page, max 1000 (default: 20)'),
    },
    async (args) => {
      try {
        const text = await getMessages(client, args as GetMessagesParams)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        const message =
          e instanceof ChatLabError && e.status === 404
            ? `Session not found: ${args.session_id}`
            : e instanceof Error
              ? e.message
              : 'Unknown error'
        return { content: [{ type: 'text' as const, text: message }], isError: true as const }
      }
    }
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/tools/messages.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/messages.ts tests/tools/messages.test.ts
git commit -m "feat: add get_messages tool with filter params"
```

---

### Task 5: Members Tool

**Files:**
- Create: `src/tools/members.ts`
- Create: `tests/tools/members.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/members.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/tools/members.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/tools/members.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function getMembers(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: number
): Promise<string> {
  const members = await client.get(`/api/v1/sessions/${sessionId}/members`)
  return JSON.stringify(members, null, 2)
}

export function registerMembersTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_members',
    'Lists all members in a session with their platformId, name, and role.',
    { session_id: z.number().describe('Session ID') },
    async ({ session_id }) => {
      try {
        return { content: [{ type: 'text' as const, text: await getMembers(client, session_id) }] }
      } catch (e) {
        const message =
          e instanceof ChatLabError && e.status === 404
            ? `Session not found: ${session_id}`
            : e instanceof Error
              ? e.message
              : 'Unknown error'
        return { content: [{ type: 'text' as const, text: message }], isError: true as const }
      }
    }
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/tools/members.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/members.ts tests/tools/members.test.ts
git commit -m "feat: add get_members tool"
```

---

### Task 6: Stats Tool

**Files:**
- Create: `src/tools/stats.ts`
- Create: `tests/tools/stats.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/stats.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { getStatsOverview } from '../../src/tools/stats.js'

const mockClient = { get: vi.fn(), post: vi.fn() }

describe('getStatsOverview', () => {
  it('calls stats/overview endpoint with session id', async () => {
    const stats = { totalMessages: 1500, activeMemberCount: 12 }
    mockClient.get.mockResolvedValue(stats)

    const result = await getStatsOverview(mockClient as any, 7)

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/7/stats/overview')
    expect(JSON.parse(result)).toEqual(stats)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/tools/stats.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/tools/stats.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function getStatsOverview(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: number
): Promise<string> {
  const stats = await client.get(`/api/v1/sessions/${sessionId}/stats/overview`)
  return JSON.stringify(stats, null, 2)
}

export function registerStatsTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_stats_overview',
    'Returns statistical overview of a session: message counts, active members, time distribution.',
    { session_id: z.number().describe('Session ID') },
    async ({ session_id }) => {
      try {
        return {
          content: [{ type: 'text' as const, text: await getStatsOverview(client, session_id) }],
        }
      } catch (e) {
        const message =
          e instanceof ChatLabError && e.status === 404
            ? `Session not found: ${session_id}`
            : e instanceof Error
              ? e.message
              : 'Unknown error'
        return { content: [{ type: 'text' as const, text: message }], isError: true as const }
      }
    }
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/tools/stats.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/stats.ts tests/tools/stats.test.ts
git commit -m "feat: add get_stats_overview tool"
```

---

### Task 7: SQL Tool

**Files:**
- Create: `src/tools/sql.ts`
- Create: `tests/tools/sql.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/sql.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/tools/sql.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/tools/sql.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function executeSQL(
  client: Pick<ChatLabClient, 'post'>,
  sessionId: number,
  query: string
): Promise<string> {
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    throw new Error('Only SELECT queries are allowed.')
  }
  const result = await client.post(`/api/v1/sessions/${sessionId}/sql`, { query })
  return JSON.stringify(result, null, 2)
}

export function registerSQLTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'execute_sql',
    'Executes a read-only SELECT query against the session database. Use for analysis not covered by other tools (word frequency, member interactions, activity breakdown).',
    {
      session_id: z.number().describe('Session ID'),
      query: z.string().describe('SQL SELECT query to execute'),
    },
    async ({ session_id, query }) => {
      try {
        const text = await executeSQL(client, session_id, query)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        const message =
          e instanceof ChatLabError && e.status === 404
            ? `Session not found: ${session_id}`
            : e instanceof Error
              ? e.message
              : 'Unknown error'
        return { content: [{ type: 'text' as const, text: message }], isError: true as const }
      }
    }
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/tools/sql.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/sql.ts tests/tools/sql.test.ts
git commit -m "feat: add execute_sql tool with SELECT-only guard"
```

---

### Task 8: Export Tool

**Files:**
- Create: `src/tools/export.ts`
- Create: `tests/tools/export.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/tools/export.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/tools/export.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/tools/export.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function exportSession(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: number
): Promise<string> {
  const data = await client.get(`/api/v1/sessions/${sessionId}/export`)
  return JSON.stringify(data, null, 2)
}

export function registerExportTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'export_session',
    'Exports the full session as ChatLab Format JSON (up to 100k messages). Use for deep analysis with large context windows.',
    { session_id: z.number().describe('Session ID') },
    async ({ session_id }) => {
      try {
        return {
          content: [{ type: 'text' as const, text: await exportSession(client, session_id) }],
        }
      } catch (e) {
        const message =
          e instanceof ChatLabError && e.status === 404
            ? `Session not found: ${session_id}`
            : e instanceof Error
              ? e.message
              : 'Unknown error'
        return { content: [{ type: 'text' as const, text: message }], isError: true as const }
      }
    }
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/tools/export.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/export.ts tests/tools/export.test.ts
git commit -m "feat: add export_session tool"
```

---

### Task 9: Server Registration

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: Implement src/server.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ChatLabClient } from './client.js'
import { registerSessionTools } from './tools/sessions.js'
import { registerMessagesTools } from './tools/messages.js'
import { registerMembersTools } from './tools/members.js'
import { registerStatsTools } from './tools/stats.js'
import { registerSQLTools } from './tools/sql.js'
import { registerExportTools } from './tools/export.js'

export function createServer(client: ChatLabClient): McpServer {
  const server = new McpServer({
    name: 'chatlab',
    version: '1.0.0',
  })

  registerSessionTools(server, client)
  registerMessagesTools(server, client)
  registerMembersTools(server, client)
  registerStatsTools(server, client)
  registerSQLTools(server, client)
  registerExportTools(server, client)

  return server
}
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: add server wiring all 7 tools"
```

---

### Task 10: Entry Point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement src/index.ts**

```typescript
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ChatLabClient } from './client.js'
import { createServer } from './server.js'

function parseArgs(): { url: string; token: string } {
  const args = process.argv.slice(2)
  let url = process.env.CHATLAB_URL ?? 'http://127.0.0.1:5200'
  let token = process.env.CHATLAB_TOKEN ?? ''

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) url = args[++i]
    else if (args[i] === '--token' && args[i + 1]) token = args[++i]
  }

  if (!token) {
    process.stderr.write(
      'Error: CHATLAB_TOKEN is required. Set it via --token flag or CHATLAB_TOKEN env var.\n'
    )
    process.exit(1)
  }

  return { url, token }
}

async function main(): Promise<void> {
  const { url, token } = parseArgs()
  const client = new ChatLabClient(url, token)
  const server = createServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 3: Build the project**

```bash
npm run build
```
Expected: `dist/` directory created with compiled `.js` files.

- [ ] **Step 4: Run all tests**

```bash
npm test
```
Expected: All tests PASS.

- [ ] **Step 5: Smoke test — verify process starts without crashing**

```bash
CHATLAB_TOKEN=test node dist/index.js &
PID=$!
sleep 1
kill $PID 2>/dev/null
echo "exit: $?"
```
Expected: Process starts silently (waits for stdin), no stderr output.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point with CLI arg and env var parsing"
```

---

### Task 11: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# chatlab-mcp

MCP server for querying ChatLab chat history from AI assistants (Claude Desktop, Cursor, custom agents).

## Setup

```bash
git clone <repo>
cd chatlab-mcp
npm install
npm run build
```

## Configuration

```bash
# via environment variable (recommended)
export CHATLAB_TOKEN=clb_xxxxxxxxxxxx

# via CLI flags (override env vars)
node dist/index.js --token clb_xxxxxxxxxxxx --url http://127.0.0.1:5200
```

`CHATLAB_URL` defaults to `http://127.0.0.1:5200`.

## Claude Desktop Integration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chatlab": {
      "command": "node",
      "args": ["/absolute/path/to/chatlab-mcp/dist/index.js"],
      "env": {
        "CHATLAB_URL": "http://127.0.0.1:5200",
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_sessions` | List all imported chat sessions |
| `get_session` | Get full details of one session by ID |
| `get_messages` | Retrieve messages with keyword/date/sender filters |
| `get_members` | List all members in a session |
| `get_stats_overview` | Statistical overview (message counts, active members) |
| `execute_sql` | Run a read-only SELECT query against the session DB |
| `export_session` | Export full session as ChatLab Format JSON (up to 100k messages) |

## Development

```bash
npm test            # run all tests
npm run test:watch  # watch mode
npm run dev         # run without compiling (requires CHATLAB_TOKEN env var)
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup and Claude Desktop integration"
```
