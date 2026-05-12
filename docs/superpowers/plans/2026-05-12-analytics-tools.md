# Analytics Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 9 SQL-backed analytics tools to `chatlab-mcp-server` (matching the desktop app's in-app AI primitives) without touching the main project.

**Architecture:** Each new tool composes a read-only SQL query in the MCP layer and dispatches it through the existing `POST /api/v1/sessions/:id/sql` endpoint via a new internal helper `sqlInternal` (no 200-row cap). Outputs follow existing `format=text|json` and `timezone` conventions.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, zod (schemas), vitest (tests). No new runtime deps.

**Working directory for ALL commands:** `/Users/gamesme/Developer/code/chatlab-mcp-server`

---

## Spec

See `docs/superpowers/specs/2026-05-12-analytics-tools-design.md` for the design.

---

## File Structure

```
src/tools/
  analytics.ts         (NEW) — 9 tools, ~700 lines; can be split later if needed
  utils.ts             (MODIFY) — add sqlInternal helper
src/server.ts          (MODIFY) — register analytics tools
src/format.ts          (MODIFY) — add 3 small format helpers (time stats, member activity, summaries)
tests/tools/
  analytics.test.ts    (NEW) — all analytics tool tests (one describe block per tool)
package.json           (MODIFY) — 0.17.2 → 0.18.0
README.md
README.zh-CN.md
README.zh-TW.md
README.ja.md          (MODIFY) — version + new tools list
```

One `analytics.ts` keeps related tools co-located, matching existing pattern (`messages.ts`, `conversation.ts`). One test file mirrors that.

---

## Task 0: Verify clean starting state

**Files:** none

- [ ] **Step 0.1: Confirm tests pass on current main**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npm test
```

Expected: All 26 existing tests pass.

- [ ] **Step 0.2: Verify build works**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npm run build
```

Expected: TypeScript compiles cleanly, `dist/` is generated.

- [ ] **Step 0.3: Verify clean git status**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git status
```

Expected: working tree clean (ignore `.DS_Store` noise; don't stage those).

---

## Task 1: Add sqlInternal helper

**Files:**
- Modify: `src/tools/utils.ts`
- Test: `tests/tools/utils.test.ts` (NEW)

The helper centralizes calling `/api/v1/sessions/:id/sql` for internal callers (no 200-row injection, returns rows directly).

- [ ] **Step 1.1: Write the failing test**

Create `tests/tools/utils.test.ts`:

```typescript
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
})
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/utils.test.ts
```

Expected: FAIL (`sqlInternal` does not exist).

- [ ] **Step 1.3: Implement sqlInternal**

Append to `src/tools/utils.ts`:

```typescript
import type { ChatLabClient } from '../client.js'

export async function sqlInternal(
  client: Pick<ChatLabClient, 'post'>,
  sessionId: string,
  sql: string
): Promise<any[]> {
  const result: any = await client.post(`/api/v1/sessions/${sessionId}/sql`, { sql })
  const data = result?.data
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.rows)) return data.rows
  return []
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/utils.test.ts
```

Expected: PASS (3 passed).

- [ ] **Step 1.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/utils.ts tests/tools/utils.test.ts
git commit -m "$(cat <<'EOF'
feat(utils): add sqlInternal helper for internal SQL calls

Routes through POST /api/v1/sessions/:id/sql but skips the 200-row
LIMIT injection used by the LLM-facing execute_sql. Returns parsed
rows directly so analytics tools can format their own output.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create analytics.ts skeleton and shared SQL fragments

**Files:**
- Create: `src/tools/analytics.ts`
- Modify: `src/server.ts`

We register `analytics` tools incrementally; the skeleton holds the shared helpers (filter clause builder, timezone offset).

- [ ] **Step 2.1: Create analytics.ts with shared helpers**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError, sqlInternal } from './utils.js'
import { formatToolResultAsText } from '../format.js'

/**
 * Build SQL fragment for optional ts range filter.
 * Returns the WHERE-suffix and the param values (positional).
 * Caller composes "WHERE 1=1" then appends the fragment.
 */
export function buildTimeFilter(
  start?: number,
  end?: number,
  tsColumn: string = 'ts'
): string {
  const parts: string[] = []
  if (start !== undefined && Number.isFinite(start)) {
    parts.push(`${tsColumn} >= ${Math.floor(start)}`)
  }
  if (end !== undefined && Number.isFinite(end)) {
    parts.push(`${tsColumn} <= ${Math.floor(end)}`)
  }
  return parts.length ? ' AND ' + parts.join(' AND ') : ''
}

/**
 * Compute the UTC offset (in seconds) of an IANA timezone at "now".
 * Used to bucket SQLite UTC timestamps into the caller's local hours/days.
 * Falls back to 0 if the IANA name is invalid.
 */
export function timezoneOffsetSeconds(timezone: string): number {
  try {
    const now = new Date()
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    })
    const parts = fmt.formatToParts(now)
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0'
    const m = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
    if (!m) return 0
    const sign = m[1] === '-' ? -1 : 1
    const hours = parseInt(m[2], 10)
    const minutes = m[3] ? parseInt(m[3], 10) : 0
    return sign * (hours * 3600 + minutes * 60)
  } catch {
    return 0
  }
}

/**
 * SQL expression that converts the UTC ts column to a local-time epoch
 * for use with strftime(). The offset is embedded as a number, not a param.
 */
export function localTsExpr(timezone: string, tsColumn: string = 'ts'): string {
  const off = timezoneOffsetSeconds(timezone)
  return `(${tsColumn} + ${off})`
}

/**
 * Escape single quotes for safe interpolation into SQL string literals.
 * Caller is responsible for surrounding with quotes.
 */
export function sqlEscape(value: string): string {
  return value.replace(/'/g, "''")
}

export function registerAnalyticsTools(server: McpServer, client: ChatLabClient): void {
  // Tools added one at a time in subsequent tasks.
  void server
  void client
  void toolError
  void sqlInternal
  void formatToolResultAsText
  void z
}
```

- [ ] **Step 2.2: Register in server.ts**

Modify `src/server.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ChatLabClient } from './client.js'
import { registerSessionTools } from './tools/sessions.js'
import { registerMessagesTools } from './tools/messages.js'
import { registerMembersTools } from './tools/members.js'
import { registerStatsTools } from './tools/stats.js'
import { registerSQLTools } from './tools/sql.js'
import { registerConversationTools } from './tools/conversation.js'
import { registerAnalyticsTools } from './tools/analytics.js'

export function createServer(client: ChatLabClient): McpServer {
  const server = new McpServer({
    name: 'chatlab',
    version: '0.1.0',
  })

  registerSessionTools(server, client)
  registerMessagesTools(server, client)
  registerMembersTools(server, client)
  registerStatsTools(server, client)
  registerSQLTools(server, client)
  registerConversationTools(server, client)
  registerAnalyticsTools(server, client)

  return server
}
```

- [ ] **Step 2.3: Verify build works**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npm run build
```

Expected: clean compile.

- [ ] **Step 2.4: Test shared helpers**

Create `tests/tools/analytics.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildTimeFilter,
  timezoneOffsetSeconds,
  localTsExpr,
  sqlEscape,
} from '../../src/tools/analytics.js'

const mockClient = { post: vi.fn(), get: vi.fn() }
beforeEach(() => {
  mockClient.post.mockReset()
  mockClient.get.mockReset()
})

describe('analytics helpers', () => {
  it('buildTimeFilter handles no filters', () => {
    expect(buildTimeFilter(undefined, undefined)).toBe('')
  })

  it('buildTimeFilter handles start only', () => {
    expect(buildTimeFilter(1700000000, undefined)).toBe(' AND ts >= 1700000000')
  })

  it('buildTimeFilter handles end only', () => {
    expect(buildTimeFilter(undefined, 1700100000)).toBe(' AND ts <= 1700100000')
  })

  it('buildTimeFilter handles both', () => {
    expect(buildTimeFilter(1700000000, 1700100000)).toBe(
      ' AND ts >= 1700000000 AND ts <= 1700100000'
    )
  })

  it('buildTimeFilter respects custom tsColumn', () => {
    expect(buildTimeFilter(1700000000, undefined, 'start_ts')).toBe(' AND start_ts >= 1700000000')
  })

  it('timezoneOffsetSeconds returns 0 for UTC', () => {
    expect(timezoneOffsetSeconds('UTC')).toBe(0)
  })

  it('timezoneOffsetSeconds returns positive for Asia/Shanghai', () => {
    expect(timezoneOffsetSeconds('Asia/Shanghai')).toBe(8 * 3600)
  })

  it('timezoneOffsetSeconds returns 0 for invalid name', () => {
    expect(timezoneOffsetSeconds('Not/A/Zone')).toBe(0)
  })

  it('localTsExpr embeds offset', () => {
    expect(localTsExpr('Asia/Shanghai')).toBe('(ts + 28800)')
    expect(localTsExpr('UTC', 'm.ts')).toBe('(m.ts + 0)')
  })

  it('sqlEscape doubles single quotes', () => {
    expect(sqlEscape("O'Brien")).toBe("O''Brien")
  })
})
```

- [ ] **Step 2.5: Run new tests**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts
```

Expected: 10 passed.

- [ ] **Step 2.6: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts src/server.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): scaffold analytics tools module

Adds src/tools/analytics.ts with shared SQL helpers (time filter,
timezone offset, IANA→seconds, SQL string escape) and an empty
registerAnalyticsTools wired into server.ts. Individual tools are
added in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: get_message_context

**Files:**
- Modify: `src/tools/analytics.ts`
- Test: `tests/tools/analytics.test.ts`

Get N messages before and after each target message ID. Single SQL query covers all targets via union of ID ranges.

- [ ] **Step 3.1: Add failing tests**

Append a `describe('get_message_context')` block to `tests/tools/analytics.test.ts`:

```typescript
import { getMessageContext } from '../../src/tools/analytics.js'

describe('get_message_context', () => {
  it('builds SQL with id range for single target', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [100],
      context_size: 5,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.id BETWEEN 95 AND 105/)
    expect(sql).toMatch(/ORDER BY m\.id/)
  })

  it('builds SQL with multiple id ranges joined by OR', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [100, 500],
      context_size: 2,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.id BETWEEN 98 AND 102/)
    expect(sql).toMatch(/m\.id BETWEEN 498 AND 502/)
    expect(sql).toMatch(/ OR /)
  })

  it('defaults context_size to 20 and caps at 100', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMessageContext(mockClient as any, { session_id: 's1', message_ids: [50], format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/BETWEEN 30 AND 70/)

    mockClient.post.mockClear()
    await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [200],
      context_size: 9999,
      format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/BETWEEN 100 AND 300/)
  })

  it('formats text output with sender names and timestamps', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        rows: [
          { id: 99, ts: 1700000000, senderName: 'Alice', content: 'hi' },
          { id: 100, ts: 1700000060, senderName: 'Bob', content: 'hey' },
        ],
      },
    })
    const out = await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [100],
      context_size: 1,
      format: 'text',
    })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/Bob/)
    expect(out).toMatch(/hi/)
  })

  it('returns informative text on empty result', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    const out = await getMessageContext(mockClient as any, {
      session_id: 's1',
      message_ids: [999],
      format: 'text',
    })
    expect(out).toMatch(/no.*messages|No matching/i)
  })
})
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_message_context'
```

Expected: 5 failures (`getMessageContext` not exported).

- [ ] **Step 3.3: Implement getMessageContext**

Append to `src/tools/analytics.ts` (before `registerAnalyticsTools`):

```typescript
const getMessageContextSchema = z.object({
  session_id: z.string().describe('Session ID'),
  message_ids: z.array(z.number()).min(1).describe('Target message IDs (one or many)'),
  context_size: z.number().optional().describe('Messages before AND after each target (default 20, max 100)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetMessageContextParams = z.infer<typeof getMessageContextSchema>

export async function getMessageContext(
  client: Pick<ChatLabClient, 'post'>,
  params: GetMessageContextParams
): Promise<string> {
  const { session_id, message_ids, format = 'text', timezone = 'Asia/Shanghai' } = params
  const ctx = Math.min(Math.max(params.context_size ?? 20, 1), 100)

  const ranges = message_ids.map((id) => `(m.id BETWEEN ${id - ctx} AND ${id + ctx})`).join(' OR ')

  const sql = `
    SELECT m.id, m.ts, m.type, m.content,
           mem.platform_id AS senderPlatformId,
           COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    LEFT JOIN member mem ON m.sender_id = mem.id
    WHERE ${ranges}
    ORDER BY m.id
    LIMIT 2000
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (rows.length === 0) {
    return format === 'json'
      ? JSON.stringify({ total: 0, returned: 0, rawMessages: [] }, null, 2)
      : 'No matching messages found for the given message IDs.'
  }

  if (format === 'json') {
    return JSON.stringify({ total: rows.length, returned: rows.length, rawMessages: rows }, null, 2)
  }

  const lines = rows.map((r) => {
    const time = new Date(r.ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    const content = r.content ?? '[no content]'
    return `${time} ${r.senderName}: ${content}`
  })

  const details: Record<string, unknown> = {
    total: rows.length,
    returned: rows.length,
    requestedMessageIds: message_ids,
    contextSize: ctx,
    messages: lines,
  }
  return formatToolResultAsText(details)
}
```

Then update `registerAnalyticsTools` (replace the placeholder body):

```typescript
export function registerAnalyticsTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_message_context',
    'Get N messages before and after one or more specific message IDs. Use when the user references "what was being said around message X" or wants to see the conversation surrounding a specific message.',
    getMessageContextSchema.shape,
    async (args) => {
      try {
        const text = await getMessageContext(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
}
```

Remove the `void server / void client / ...` block (no longer needed once a tool is registered).

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_message_context'
```

Expected: 5 passed.

- [ ] **Step 3.5: Run full test suite**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npm test
```

Expected: all existing tests still pass + the 5 new ones.

- [ ] **Step 3.6: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add get_message_context tool

Returns N messages before and after one or more target message IDs
via a single SQL query that unions the windowed ranges. Default
context size 20, capped at 100, total rows capped at 2000.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: get_conversation_between

**Files:**
- Modify: `src/tools/analytics.ts`, `tests/tools/analytics.test.ts`

Messages where both senders are two specific members (DB internal IDs), time-filterable.

- [ ] **Step 4.1: Add failing tests**

Append to `tests/tools/analytics.test.ts`:

```typescript
import { getConversationBetween } from '../../src/tools/analytics.js'

describe('get_conversation_between', () => {
  it('filters by sender_id IN (a, b)', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getConversationBetween(mockClient as any, {
      session_id: 's1',
      member_id_1: 5,
      member_id_2: 9,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.sender_id IN \(5, 9\)/)
    expect(sql).toMatch(/ORDER BY m\.ts/)
  })

  it('applies time filters', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getConversationBetween(mockClient as any, {
      session_id: 's1',
      member_id_1: 5,
      member_id_2: 9,
      start_time: 1700000000,
      end_time: 1700100000,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.ts >= 1700000000/)
    expect(sql).toMatch(/m\.ts <= 1700100000/)
  })

  it('defaults limit to 100, caps at 1000', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getConversationBetween(mockClient as any, {
      session_id: 's1', member_id_1: 1, member_id_2: 2, format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 100/)

    mockClient.post.mockClear()
    await getConversationBetween(mockClient as any, {
      session_id: 's1', member_id_1: 1, member_id_2: 2, limit: 99999, format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 1000/)
  })

  it('formats text output', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        rows: [
          { id: 1, ts: 1700000000, senderName: 'Alice', content: 'hi' },
          { id: 2, ts: 1700000060, senderName: 'Bob', content: 'hey' },
        ],
      },
    })
    const out = await getConversationBetween(mockClient as any, {
      session_id: 's1', member_id_1: 1, member_id_2: 2, format: 'text',
    })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/Bob/)
  })
})
```

- [ ] **Step 4.2: Verify failures**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_conversation_between'
```

Expected: 4 failures.

- [ ] **Step 4.3: Implement getConversationBetween**

Append to `src/tools/analytics.ts`:

```typescript
const getConversationBetweenSchema = z.object({
  session_id: z.string().describe('Session ID'),
  member_id_1: z.number().describe('First member numeric ID (from get_members)'),
  member_id_2: z.number().describe('Second member numeric ID (from get_members)'),
  start_time: z.number().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().optional().describe('End time (Unix seconds)'),
  limit: z.number().optional().describe('Max messages (default 100, max 1000)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetConversationBetweenParams = z.infer<typeof getConversationBetweenSchema>

export async function getConversationBetween(
  client: Pick<ChatLabClient, 'post'>,
  params: GetConversationBetweenParams
): Promise<string> {
  const {
    session_id, member_id_1, member_id_2,
    start_time, end_time, format = 'text', timezone = 'Asia/Shanghai',
  } = params
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000)

  const sql = `
    SELECT m.id, m.ts, m.type, m.content,
           mem.platform_id AS senderPlatformId,
           COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    JOIN member mem ON m.sender_id = mem.id
    WHERE m.sender_id IN (${Math.floor(member_id_1)}, ${Math.floor(member_id_2)})
      ${buildTimeFilter(start_time, end_time, 'm.ts')}
    ORDER BY m.ts
    LIMIT ${limit}
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (rows.length === 0) {
    return format === 'json'
      ? JSON.stringify({ total: 0, returned: 0, rawMessages: [] }, null, 2)
      : 'No conversation found between these two members in the given range.'
  }

  if (format === 'json') {
    return JSON.stringify({ total: rows.length, returned: rows.length, rawMessages: rows }, null, 2)
  }

  const lines = rows.map((r) => {
    const time = new Date(r.ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    return `${time} ${r.senderName}: ${r.content ?? '[no content]'}`
  })

  return formatToolResultAsText({
    total: rows.length,
    returned: rows.length,
    member_id_1, member_id_2,
    messages: lines,
  })
}
```

Then add tool registration inside `registerAnalyticsTools` (before the closing brace):

```typescript
  server.tool(
    'get_conversation_between',
    'Get messages between two specific members (interleaved by time). Use when the user asks "what did A and B talk about". Members must be referenced by their numeric DB id; call get_members first to look them up.',
    getConversationBetweenSchema.shape,
    async (args) => {
      try {
        const text = await getConversationBetween(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
```

- [ ] **Step 4.4: Verify tests pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_conversation_between'
```

Expected: 4 passed.

- [ ] **Step 4.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add get_conversation_between tool

Returns interleaved messages from two specific members ordered by
timestamp. Supports time filtering; default 100 rows, capped at 1000.
Members are referenced by numeric DB id (member.id) which the LLM
fetches via get_members.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: get_session_summaries

**Files:**
- Modify: `src/tools/analytics.ts`, `tests/tools/analytics.test.ts`

Reads AI-generated summaries from the per-session `chat_session` table. Keyword filtering is post-query (client-side, since `summary` has no FTS index).

- [ ] **Step 5.1: Add failing tests**

```typescript
import { getSessionSummaries } from '../../src/tools/analytics.js'

describe('get_session_summaries', () => {
  it('queries chat_session table with summary filter', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getSessionSummaries(mockClient as any, { session_id: 's1', format: 'json' })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/FROM chat_session/)
    expect(sql).toMatch(/summary IS NOT NULL/)
    expect(sql).toMatch(/ORDER BY start_ts DESC/)
  })

  it('applies start/end time filter on start_ts column', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getSessionSummaries(mockClient as any, {
      session_id: 's1',
      start_time: 1700000000,
      end_time: 1700100000,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/start_ts >= 1700000000/)
    expect(sql).toMatch(/start_ts <= 1700100000/)
  })

  it('filters by keyword client-side after fetching rows', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        rows: [
          { id: 1, start_ts: 100, end_ts: 200, message_count: 50, summary: 'discussed travel plans' },
          { id: 2, start_ts: 300, end_ts: 400, message_count: 30, summary: 'lunch decision' },
          { id: 3, start_ts: 500, end_ts: 600, message_count: 20, summary: 'travel costs' },
        ],
      },
    })
    const out = await getSessionSummaries(mockClient as any, {
      session_id: 's1',
      keywords: ['travel'],
      format: 'json',
    })
    const data = JSON.parse(out)
    expect(data.returned).toBe(2)
    expect(data.sessions.every((s: any) => /travel/i.test(s.summary))).toBe(true)
  })

  it('returns informative text when no summaries exist', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    const out = await getSessionSummaries(mockClient as any, { session_id: 's1', format: 'text' })
    expect(out).toMatch(/no.*summar|generate|haven't/i)
  })

  it('returns informative text when table missing (older schema)', async () => {
    mockClient.post.mockRejectedValue(new Error('SQL execution error: no such table: chat_session'))
    const out = await getSessionSummaries(mockClient as any, { session_id: 's1', format: 'text' })
    expect(out).toMatch(/newer.*schema|reimport/i)
  })
})
```

- [ ] **Step 5.2: Verify failures**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_session_summaries'
```

Expected: 5 failures.

- [ ] **Step 5.3: Implement getSessionSummaries**

Append to `src/tools/analytics.ts`:

```typescript
const getSessionSummariesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keywords: z.array(z.string()).optional().describe('Filter summaries containing any of these keywords (case-insensitive)'),
  limit: z.number().optional().describe('Max rows to return (default 20, max 100)'),
  start_time: z.number().optional().describe('Earliest start_ts (Unix seconds)'),
  end_time: z.number().optional().describe('Latest start_ts (Unix seconds)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetSessionSummariesParams = z.infer<typeof getSessionSummariesSchema>

function missingTableHint(sql: string, err: Error): string | null {
  const msg = err.message || ''
  if (/no such table/i.test(msg)) {
    return 'This feature requires a newer database schema (chat_session / message_fts). Please reimport the session in the latest ChatLab version.'
  }
  void sql
  return null
}

export async function getSessionSummaries(
  client: Pick<ChatLabClient, 'post'>,
  params: GetSessionSummariesParams
): Promise<string> {
  const { session_id, keywords, start_time, end_time, format = 'text', timezone = 'Asia/Shanghai' } = params
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
  const fetchLimit = keywords && keywords.length > 0 ? Math.max(limit * 5, 100) : limit

  const sql = `
    SELECT id, start_ts, end_ts, message_count, summary
    FROM chat_session
    WHERE summary IS NOT NULL
      ${buildTimeFilter(start_time, end_time, 'start_ts')}
    ORDER BY start_ts DESC
    LIMIT ${fetchLimit}
  `.trim()

  let rows: any[]
  try {
    rows = await sqlInternal(client, session_id, sql)
  } catch (e) {
    const hint = missingTableHint(sql, e as Error)
    if (hint) {
      return format === 'json' ? JSON.stringify({ message: hint }, null, 2) : hint
    }
    throw e
  }

  let filtered = rows
  if (keywords && keywords.length > 0) {
    const lowered = keywords.map((k) => k.toLowerCase())
    filtered = rows.filter((r) =>
      typeof r.summary === 'string' && lowered.some((k) => r.summary.toLowerCase().includes(k))
    )
  }
  filtered = filtered.slice(0, limit)

  if (filtered.length === 0) {
    const msg = "No AI-generated summaries found. Generate them in ChatLab's session timeline first."
    return format === 'json'
      ? JSON.stringify({ total: 0, returned: 0, sessions: [], message: msg }, null, 2)
      : msg
  }

  const sessions = filtered.map((r) => ({
    sessionId: r.id,
    startTs: r.start_ts,
    endTs: r.end_ts,
    messageCount: r.message_count,
    summary: r.summary,
  }))

  if (format === 'json') {
    return JSON.stringify({ total: filtered.length, returned: sessions.length, sessions }, null, 2)
  }

  const fmtTime = (ts: number) =>
    new Date(ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })

  const lines = sessions.map(
    (s) => `[${s.sessionId}] ${fmtTime(s.startTs)} ~ ${fmtTime(s.endTs)} (${s.messageCount} msgs)\n  ${s.summary}`
  )

  return formatToolResultAsText({
    total: filtered.length,
    returned: sessions.length,
    summaries: lines,
  })
}
```

Register the tool inside `registerAnalyticsTools`:

```typescript
  server.tool(
    'get_session_summaries',
    'Get AI-generated summaries of chat sub-sessions from the chat_session table. Use to quickly survey what topics have been discussed. Supports keyword filtering and time range. Returns text by default.',
    getSessionSummariesSchema.shape,
    async (args) => {
      try {
        const text = await getSessionSummaries(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
```

- [ ] **Step 5.4: Verify tests pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_session_summaries'
```

Expected: 5 passed.

- [ ] **Step 5.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add get_session_summaries tool

Reads AI-generated chat session summaries from the chat_session
table, ordered newest first. Supports keyword post-filtering and
time range. Surfaces a friendly hint when the table is missing
on older schema versions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: deep_search_messages

**Files:**
- Modify: `src/tools/analytics.ts`, `tests/tools/analytics.test.ts`

FTS5 full-text search, then a second SQL pass expanding each hit into a context window.

- [ ] **Step 6.1: Add failing tests**

```typescript
import { deepSearchMessages } from '../../src/tools/analytics.js'

describe('deep_search_messages', () => {
  it('joins message_fts and uses MATCH with OR-joined keywords', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { rows: [{ id: 50, ts: 1000 }] } })  // hits
      .mockResolvedValueOnce({ data: { rows: [] } })                       // context
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['hello', 'world'], format: 'json',
    })
    const sql1 = mockClient.post.mock.calls[0][1].sql as string
    expect(sql1).toMatch(/JOIN message_fts/)
    expect(sql1).toMatch(/message_fts MATCH/)
    expect(sql1).toMatch(/"hello" OR "world"/)
  })

  it('escapes double quotes in keywords', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { rows: [] } })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['say "hi"'], format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/"say ""hi"""/)
  })

  it('expands hits into context window via second query', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { rows: [{ id: 100, ts: 1000 }, { id: 200, ts: 2000 }] } })
      .mockResolvedValueOnce({
        data: {
          rows: [
            { id: 98, ts: 990, content: 'before', senderName: 'A' },
            { id: 100, ts: 1000, content: 'hit1', senderName: 'B' },
            { id: 198, ts: 1990, content: 'before2', senderName: 'A' },
            { id: 200, ts: 2000, content: 'hit2', senderName: 'B' },
          ],
        },
      })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['x'], context_before: 2, context_after: 0, format: 'json',
    })
    const sql2 = mockClient.post.mock.calls[1][1].sql as string
    expect(sql2).toMatch(/m\.id BETWEEN 98 AND 100/)
    expect(sql2).toMatch(/m\.id BETWEEN 198 AND 200/)
  })

  it('applies sender_id and time filters in hits query', async () => {
    mockClient.post.mockResolvedValueOnce({ data: { rows: [] } })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['x'],
      sender_id: 7, start_time: 1700000000, end_time: 1700100000,
      format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/m\.sender_id = 7/)
    expect(sql).toMatch(/m\.ts >= 1700000000/)
    expect(sql).toMatch(/m\.ts <= 1700100000/)
  })

  it('returns informative text when no hits', async () => {
    mockClient.post.mockResolvedValueOnce({ data: { rows: [] } })
    const out = await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['nothing'], format: 'text',
    })
    expect(out).toMatch(/no.*match|0 hits/i)
  })

  it('caps limit at 1000', async () => {
    mockClient.post.mockResolvedValueOnce({ data: { rows: [] } })
    await deepSearchMessages(mockClient as any, {
      session_id: 's1', keywords: ['x'], limit: 99999, format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 1000/)
  })
})
```

- [ ] **Step 6.2: Verify failures**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'deep_search_messages'
```

Expected: 6 failures.

- [ ] **Step 6.3: Implement deepSearchMessages**

Append to `src/tools/analytics.ts`:

```typescript
const deepSearchSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keywords: z.array(z.string()).min(1).describe('Keywords to search (FTS5 MATCH, joined by OR)'),
  sender_id: z.number().optional().describe('Restrict to a specific sender (numeric member.id)'),
  start_time: z.number().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().optional().describe('End time (Unix seconds)'),
  limit: z.number().optional().describe('Max hits before context expansion (default 100, max 1000)'),
  context_before: z.number().optional().describe('Context messages before each hit (default 2, max 20)'),
  context_after: z.number().optional().describe('Context messages after each hit (default 2, max 20)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type DeepSearchParams = z.infer<typeof deepSearchSchema>

function ftsEscape(keyword: string): string {
  // FTS5 quoted phrases — embedded double quotes are doubled.
  return `"${keyword.replace(/"/g, '""')}"`
}

export async function deepSearchMessages(
  client: Pick<ChatLabClient, 'post'>,
  params: DeepSearchParams
): Promise<string> {
  const { session_id, keywords, sender_id, start_time, end_time, format = 'text', timezone = 'Asia/Shanghai' } = params
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000)
  const before = Math.min(Math.max(params.context_before ?? 2, 0), 20)
  const after = Math.min(Math.max(params.context_after ?? 2, 0), 20)

  const matchExpr = keywords.map(ftsEscape).join(' OR ')

  let senderClause = ''
  if (sender_id !== undefined && Number.isFinite(sender_id)) {
    senderClause = ` AND m.sender_id = ${Math.floor(sender_id)}`
  }

  const hitsSql = `
    SELECT m.id, m.ts
    FROM message m
    JOIN message_fts ON m.id = message_fts.rowid
    WHERE message_fts MATCH '${sqlEscape(matchExpr)}'
      ${senderClause}
      ${buildTimeFilter(start_time, end_time, 'm.ts')}
    ORDER BY m.ts
    LIMIT ${limit}
  `.trim()

  let hits: any[]
  try {
    hits = await sqlInternal(client, session_id, hitsSql)
  } catch (e) {
    const hint = missingTableHint(hitsSql, e as Error)
    if (hint) return format === 'json' ? JSON.stringify({ message: hint }, null, 2) : hint
    throw e
  }

  if (hits.length === 0) {
    const msg = `No matches for keywords: ${keywords.join(', ')}`
    return format === 'json' ? JSON.stringify({ total: 0, returned: 0, rawMessages: [] }, null, 2) : msg
  }

  if (before === 0 && after === 0) {
    return formatRowsAsConversation(hits, format, timezone, { total: hits.length })
  }

  const ranges = hits
    .map((h) => `(m.id BETWEEN ${h.id - before} AND ${h.id + after})`)
    .join(' OR ')

  const contextSql = `
    SELECT m.id, m.ts, m.type, m.content,
           mem.platform_id AS senderPlatformId,
           COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    LEFT JOIN member mem ON m.sender_id = mem.id
    WHERE ${ranges}
    ORDER BY m.id
    LIMIT 5000
  `.trim()

  const expanded = await sqlInternal(client, session_id, contextSql)

  return formatRowsAsConversation(expanded, format, timezone, {
    hits: hits.length,
    total: expanded.length,
  })
}

function formatRowsAsConversation(
  rows: any[],
  format: 'json' | 'text',
  timezone: string,
  extra: Record<string, unknown>
): string {
  if (format === 'json') {
    return JSON.stringify({ ...extra, returned: rows.length, rawMessages: rows }, null, 2)
  }
  const lines = rows.map((r) => {
    const time = new Date(r.ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    return `${time} ${r.senderName ?? '?'}: ${r.content ?? '[no content]'}`
  })
  return formatToolResultAsText({ ...extra, returned: rows.length, messages: lines })
}
```

Register the tool:

```typescript
  server.tool(
    'deep_search_messages',
    'Full-text search messages via FTS5, then expand each hit with surrounding context messages. Use for "did anyone mention X" style queries where conversation context matters.',
    deepSearchSchema.shape,
    async (args) => {
      try {
        const text = await deepSearchMessages(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
```

- [ ] **Step 6.4: Verify tests pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'deep_search_messages'
```

Expected: 6 passed.

- [ ] **Step 6.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add deep_search_messages tool

FTS5 keyword search joined to message_fts, followed by a second
query that expands each hit into a context window (before/after).
Handles multi-keyword OR, sender + time filters, and falls back
with a clear hint when message_fts is unavailable on older schemas.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: get_time_stats

**Files:**
- Modify: `src/tools/analytics.ts`, `tests/tools/analytics.test.ts`

Hourly / weekday / daily distribution, timezone-aware via `localTsExpr`.

- [ ] **Step 7.1: Add failing tests**

```typescript
import { getTimeStats } from '../../src/tools/analytics.js'

describe('get_time_stats', () => {
  it('hourly groups by strftime %H on localized ts', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'hourly', timezone: 'Asia/Shanghai', format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/strftime\('%H'/)
    expect(sql).toMatch(/\(ts \+ 28800\)/)
    expect(sql).toMatch(/GROUP BY bucket/)
  })

  it('weekday groups by strftime %w', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'weekday', format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/strftime\('%w'/)
  })

  it('daily groups by date()', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'daily', format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/date\(/)
  })

  it('formats hourly text output with peak hour', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [
        { bucket: 9, count: 100 },
        { bucket: 21, count: 500 },
      ] },
    })
    const out = await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'hourly', format: 'text',
    })
    expect(out).toMatch(/peakHour: 21:00/)
    expect(out).toMatch(/500/)
  })

  it('formats weekday text output with weekday names', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [{ bucket: 1, count: 50 }, { bucket: 0, count: 200 }] },
    })
    const out = await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'weekday', format: 'text',
    })
    expect(out).toMatch(/Sunday/i)
    expect(out).toMatch(/200/)
  })

  it('applies time filter', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getTimeStats(mockClient as any, {
      session_id: 's1', type: 'hourly',
      start_time: 1700000000, end_time: 1700100000, format: 'json',
    })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/ts >= 1700000000/)
  })
})
```

- [ ] **Step 7.2: Verify failures**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_time_stats'
```

Expected: 6 failures.

- [ ] **Step 7.3: Implement getTimeStats**

Append to `src/tools/analytics.ts`:

```typescript
const WEEKDAY_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const getTimeStatsSchema = z.object({
  session_id: z.string().describe('Session ID'),
  type: z.enum(['hourly', 'weekday', 'daily']).describe('Bucket granularity'),
  start_time: z.number().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().optional().describe('End time (Unix seconds)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for bucketing (default Asia/Shanghai)'),
})

export type GetTimeStatsParams = z.infer<typeof getTimeStatsSchema>

export async function getTimeStats(
  client: Pick<ChatLabClient, 'post'>,
  params: GetTimeStatsParams
): Promise<string> {
  const { session_id, type, start_time, end_time, format = 'text', timezone = 'Asia/Shanghai' } = params
  const tsExpr = localTsExpr(timezone)
  let bucketExpr: string
  switch (type) {
    case 'hourly':
      bucketExpr = `CAST(strftime('%H', ${tsExpr}, 'unixepoch') AS INTEGER)`
      break
    case 'weekday':
      bucketExpr = `CAST(strftime('%w', ${tsExpr}, 'unixepoch') AS INTEGER)`
      break
    case 'daily':
      bucketExpr = `date(${tsExpr}, 'unixepoch')`
      break
  }

  const sql = `
    SELECT ${bucketExpr} AS bucket, COUNT(*) AS count
    FROM message
    WHERE 1=1 ${buildTimeFilter(start_time, end_time, 'ts')}
    GROUP BY bucket
    ORDER BY bucket
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (format === 'json') {
    return JSON.stringify({ type, timezone, rows }, null, 2)
  }

  if (rows.length === 0) {
    return 'No messages in the given range.'
  }

  const peak = rows.reduce((max, r) => (r.count > max.count ? r : max), rows[0])

  const details: Record<string, unknown> = { type, timezone }
  const distribution: string[] = []

  if (type === 'hourly') {
    const fmt = (n: number) => `${String(n).padStart(2, '0')}:00`
    details.peakHour = `${fmt(peak.bucket)} (${peak.count})`
    for (const r of rows) distribution.push(`${fmt(r.bucket)} ${r.count}`)
  } else if (type === 'weekday') {
    details.peakDay = `${WEEKDAY_NAMES_EN[peak.bucket]} (${peak.count})`
    for (const r of rows) distribution.push(`${WEEKDAY_NAMES_EN[r.bucket]} ${r.count}`)
  } else {
    const total = rows.reduce((s, r) => s + (r.count as number), 0)
    details.days = rows.length
    details.total = total
    details.dailyAvg = Math.round(total / rows.length)
    for (const r of rows) distribution.push(`${r.bucket} ${r.count}`)
  }
  details.distribution = distribution

  return formatToolResultAsText(details)
}
```

Register:

```typescript
  server.tool(
    'get_time_stats',
    'Get message count distribution bucketed by hour, weekday, or day. Use for "when are people most active" type questions. Timezone-aware bucketing.',
    getTimeStatsSchema.shape,
    async (args) => {
      try {
        const text = await getTimeStats(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
```

- [ ] **Step 7.4: Verify tests pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_time_stats'
```

Expected: 6 passed.

- [ ] **Step 7.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add get_time_stats tool

Hourly, weekday, or daily message count distribution. Bucketing
respects the caller's IANA timezone by adding the precomputed
offset to the UTC ts before strftime/date.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: get_member_activity

**Files:**
- Modify: `src/tools/analytics.ts`, `tests/tools/analytics.test.ts`

Top-N members ranked by message count with percentage of total.

- [ ] **Step 8.1: Add failing tests**

```typescript
import { getMemberActivity } from '../../src/tools/analytics.js'

describe('get_member_activity', () => {
  it('uses CTE with percentage', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMemberActivity(mockClient as any, { session_id: 's1', format: 'json' })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/WITH counts AS/)
    expect(sql).toMatch(/JOIN member/)
    expect(sql).toMatch(/percentage/)
    expect(sql).toMatch(/ORDER BY c\.msg_count DESC/)
  })

  it('caps top_n at 50', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMemberActivity(mockClient as any, { session_id: 's1', top_n: 9999, format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 50/)
  })

  it('defaults top_n to 10', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMemberActivity(mockClient as any, { session_id: 's1', format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 10/)
  })

  it('formats text output with rank/name/count/percent', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [
        { id: 1, platform_id: 'a', account_name: 'Alice', group_nickname: null, msg_count: 100, percentage: 50.0 },
        { id: 2, platform_id: 'b', account_name: null, group_nickname: 'Bob', msg_count: 100, percentage: 50.0 },
      ] },
    })
    const out = await getMemberActivity(mockClient as any, { session_id: 's1', format: 'text' })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/Bob/)
    expect(out).toMatch(/50/)
  })
})
```

- [ ] **Step 8.2: Verify failures**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_member_activity'
```

Expected: 4 failures.

- [ ] **Step 8.3: Implement getMemberActivity**

Append to `src/tools/analytics.ts`:

```typescript
const getMemberActivitySchema = z.object({
  session_id: z.string().describe('Session ID'),
  top_n: z.number().optional().describe('Top N members (default 10, max 50)'),
  start_time: z.number().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().optional().describe('End time (Unix seconds)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
})

export type GetMemberActivityParams = z.infer<typeof getMemberActivitySchema>

export async function getMemberActivity(
  client: Pick<ChatLabClient, 'post'>,
  params: GetMemberActivityParams
): Promise<string> {
  const { session_id, start_time, end_time, format = 'text' } = params
  const topN = Math.min(Math.max(params.top_n ?? 10, 1), 50)

  const sql = `
    WITH counts AS (
      SELECT m.sender_id, COUNT(*) AS msg_count
      FROM message m
      WHERE 1=1 ${buildTimeFilter(start_time, end_time, 'm.ts')}
      GROUP BY m.sender_id
    ), total AS (
      SELECT COALESCE(SUM(msg_count), 0) AS t FROM counts
    )
    SELECT mem.id, mem.platform_id, mem.account_name, mem.group_nickname,
           c.msg_count,
           CASE WHEN total.t = 0 THEN 0
                ELSE ROUND(c.msg_count * 100.0 / total.t, 2) END AS percentage
    FROM counts c
    JOIN member mem ON mem.id = c.sender_id
    CROSS JOIN total
    ORDER BY c.msg_count DESC
    LIMIT ${topN}
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (format === 'json') {
    return JSON.stringify({ topN, count: rows.length, members: rows }, null, 2)
  }

  if (rows.length === 0) {
    return 'No members with messages in the given range.'
  }

  const lines = rows.map((r, i) => {
    const name = r.group_nickname || r.account_name || r.platform_id
    return `${i + 1}. ${name} (id=${r.id}) - ${r.msg_count} msgs (${r.percentage}%)`
  })

  return formatToolResultAsText({ topN, returned: rows.length, members: lines })
}
```

Register:

```typescript
  server.tool(
    'get_member_activity',
    'Top members ranked by message count with percentage of total. Use for "who talks the most" or "most active members" type questions. Supports top_n and time filters.',
    getMemberActivitySchema.shape,
    async (args) => {
      try {
        const text = await getMemberActivity(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
```

- [ ] **Step 8.4: Verify tests pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_member_activity'
```

Expected: 4 passed.

- [ ] **Step 8.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add get_member_activity tool

Top-N members by message count with percentage of total, supporting
time range. Handles zero-total edge case to avoid divide-by-zero.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: get_member_name_history

**Files:**
- Modify: `src/tools/analytics.ts`, `tests/tools/analytics.test.ts`

Returns rows from `member_name_history` for a single member.

- [ ] **Step 9.1: Add failing tests**

```typescript
import { getMemberNameHistory } from '../../src/tools/analytics.js'

describe('get_member_name_history', () => {
  it('queries member_name_history filtered by member_id', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getMemberNameHistory(mockClient as any, {
      session_id: 's1', member_id: 7, format: 'json',
    })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/FROM member_name_history/)
    expect(sql).toMatch(/member_id = 7/)
    expect(sql).toMatch(/ORDER BY start_ts/)
  })

  it('formats text output with name_type and time range', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [
        { name_type: 'account', name: 'Alice', start_ts: 1700000000, end_ts: null },
        { name_type: 'nickname', name: 'A', start_ts: 1700000500, end_ts: 1700100000 },
      ] },
    })
    const out = await getMemberNameHistory(mockClient as any, {
      session_id: 's1', member_id: 7, format: 'text',
    })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/account/)
    expect(out).toMatch(/nickname/)
  })

  it('returns informative text when no history rows', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    const out = await getMemberNameHistory(mockClient as any, {
      session_id: 's1', member_id: 99, format: 'text',
    })
    expect(out).toMatch(/no.*history|not found/i)
  })
})
```

- [ ] **Step 9.2: Verify failures**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_member_name_history'
```

Expected: 3 failures.

- [ ] **Step 9.3: Implement getMemberNameHistory**

```typescript
const getMemberNameHistorySchema = z.object({
  session_id: z.string().describe('Session ID'),
  member_id: z.number().describe('Member numeric ID (from get_members)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
  timezone: z.string().optional().describe('Timezone for time display (default Asia/Shanghai)'),
})

export type GetMemberNameHistoryParams = z.infer<typeof getMemberNameHistorySchema>

export async function getMemberNameHistory(
  client: Pick<ChatLabClient, 'post'>,
  params: GetMemberNameHistoryParams
): Promise<string> {
  const { session_id, member_id, format = 'text', timezone = 'Asia/Shanghai' } = params

  const sql = `
    SELECT name_type, name, start_ts, end_ts
    FROM member_name_history
    WHERE member_id = ${Math.floor(member_id)}
    ORDER BY start_ts
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (rows.length === 0) {
    const msg = `No name history found for member id=${member_id}.`
    return format === 'json' ? JSON.stringify({ total: 0, history: [] }, null, 2) : msg
  }

  if (format === 'json') {
    return JSON.stringify({ total: rows.length, history: rows }, null, 2)
  }

  const fmt = (ts: number | null) =>
    ts === null ? '(current)' : new Date(ts * 1000).toLocaleString('zh-CN', {
      timeZone: timezone,
      year: 'numeric', month: 'numeric', day: 'numeric',
    })

  const lines = rows.map((r) => `[${r.name_type}] ${r.name}: ${fmt(r.start_ts)} ~ ${fmt(r.end_ts)}`)

  return formatToolResultAsText({ member_id, total: rows.length, history: lines })
}
```

Register:

```typescript
  server.tool(
    'get_member_name_history',
    'Get the historical name changes (account name, nickname) for a single member. Useful for tracking identity changes over time.',
    getMemberNameHistorySchema.shape,
    async (args) => {
      try {
        const text = await getMemberNameHistory(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
```

- [ ] **Step 9.4: Verify tests pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_member_name_history'
```

Expected: 3 passed.

- [ ] **Step 9.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add get_member_name_history tool

Returns the historical account name and nickname entries for a
single member from member_name_history, ordered chronologically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: get_response_time_analysis

**Files:**
- Modify: `src/tools/analytics.ts`, `tests/tools/analytics.test.ts`

Uses SQLite window function `LAG()` to compute reply intervals between consecutive messages from different senders.

- [ ] **Step 10.1: Add failing tests**

```typescript
import { getResponseTimeAnalysis } from '../../src/tools/analytics.js'

describe('get_response_time_analysis', () => {
  it('uses LAG window function and excludes same-sender pairs', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', format: 'json' })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/LAG\(ts\)/)
    expect(sql).toMatch(/LAG\(sender_id\)/)
    expect(sql).toMatch(/prev_sender <> sender_id/)
    expect(sql).toMatch(/BETWEEN 1 AND 3600/)
  })

  it('joins member table for names', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', format: 'json' })
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/JOIN member/)
  })

  it('defaults top_n to 10, caps at 50', async () => {
    mockClient.post.mockResolvedValue({ data: { rows: [] } })
    await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 10/)

    mockClient.post.mockClear()
    await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', top_n: 9999, format: 'json' })
    expect(mockClient.post.mock.calls[0][1].sql).toMatch(/LIMIT 50/)
  })

  it('formats text output with from→to and timings', async () => {
    mockClient.post.mockResolvedValue({
      data: { rows: [{
        from_id: 1, to_id: 2,
        from_name: 'Alice', to_name: 'Bob',
        reply_count: 100, min_seconds: 5, avg_seconds: 120.5, max_seconds: 3500,
      }] },
    })
    const out = await getResponseTimeAnalysis(mockClient as any, { session_id: 's1', format: 'text' })
    expect(out).toMatch(/Alice/)
    expect(out).toMatch(/Bob/)
    expect(out).toMatch(/100/)
  })
})
```

- [ ] **Step 10.2: Verify failures**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_response_time_analysis'
```

Expected: 4 failures.

- [ ] **Step 10.3: Implement getResponseTimeAnalysis**

```typescript
const getResponseTimeSchema = z.object({
  session_id: z.string().describe('Session ID'),
  top_n: z.number().optional().describe('Top N (from, to) pairs (default 10, max 50)'),
  start_time: z.number().optional().describe('Start time (Unix seconds)'),
  end_time: z.number().optional().describe('End time (Unix seconds)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
})

export type GetResponseTimeParams = z.infer<typeof getResponseTimeSchema>

export async function getResponseTimeAnalysis(
  client: Pick<ChatLabClient, 'post'>,
  params: GetResponseTimeParams
): Promise<string> {
  const { session_id, start_time, end_time, format = 'text' } = params
  const topN = Math.min(Math.max(params.top_n ?? 10, 1), 50)

  const sql = `
    WITH ordered AS (
      SELECT ts, sender_id,
             LAG(ts) OVER (ORDER BY ts) AS prev_ts,
             LAG(sender_id) OVER (ORDER BY ts) AS prev_sender
      FROM message
      WHERE 1=1 ${buildTimeFilter(start_time, end_time, 'ts')}
    )
    SELECT prev_sender AS from_id,
           sender_id   AS to_id,
           COALESCE(m_from.group_nickname, m_from.account_name, m_from.platform_id) AS from_name,
           COALESCE(m_to.group_nickname,   m_to.account_name,   m_to.platform_id)   AS to_name,
           COUNT(*)             AS reply_count,
           MIN(ts - prev_ts)    AS min_seconds,
           ROUND(AVG(ts - prev_ts), 2) AS avg_seconds,
           MAX(ts - prev_ts)    AS max_seconds
    FROM ordered
    LEFT JOIN member m_from ON m_from.id = prev_sender
    LEFT JOIN member m_to   ON m_to.id   = sender_id
    WHERE prev_sender IS NOT NULL
      AND prev_sender <> sender_id
      AND (ts - prev_ts) BETWEEN 1 AND 3600
    GROUP BY from_id, to_id
    ORDER BY reply_count DESC
    LIMIT ${topN}
  `.trim()

  const rows = await sqlInternal(client, session_id, sql)

  if (format === 'json') {
    return JSON.stringify({ topN, count: rows.length, pairs: rows }, null, 2)
  }

  if (rows.length === 0) {
    return 'No reply pairs found in the given range.'
  }

  const lines = rows.map(
    (r, i) =>
      `${i + 1}. ${r.from_name} → ${r.to_name}: ${r.reply_count} replies (min=${r.min_seconds}s, avg=${r.avg_seconds}s, max=${r.max_seconds}s)`
  )

  return formatToolResultAsText({ topN, returned: rows.length, pairs: lines })
}
```

Register:

```typescript
  server.tool(
    'get_response_time_analysis',
    'Reply intervals between consecutive messages from different senders, grouped by (from, to) pair. Excludes same-sender continuations and gaps over 1 hour. Use for "who responds fastest" type questions.',
    getResponseTimeSchema.shape,
    async (args) => {
      try {
        const text = await getResponseTimeAnalysis(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
```

- [ ] **Step 10.4: Verify tests pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'get_response_time_analysis'
```

Expected: 4 passed.

- [ ] **Step 10.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add get_response_time_analysis tool

Computes reply intervals via LAG() over consecutive messages from
different senders, grouping by (from_id, to_id) pair. Excludes
same-sender continuations and gaps over 1 hour.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: keyword_frequency (info-only)

**Files:**
- Modify: `src/tools/analytics.ts`, `tests/tools/analytics.test.ts`

Returns a static informational message; no SQL run.

- [ ] **Step 11.1: Add failing tests**

```typescript
import { keywordFrequency } from '../../src/tools/analytics.js'

describe('keyword_frequency', () => {
  it('does not call the API', async () => {
    await keywordFrequency({ session_id: 's1', format: 'text' })
    expect(mockClient.post).not.toHaveBeenCalled()
  })

  it('returns text describing the limitation and alternatives', async () => {
    const out = await keywordFrequency({ session_id: 's1', format: 'text' })
    expect(out).toMatch(/not implemented|segmentation|jieba/i)
    expect(out).toMatch(/execute_sql|LIKE/i)
  })

  it('returns JSON with message and alternatives when format=json', async () => {
    const out = await keywordFrequency({ session_id: 's1', format: 'json' })
    const data = JSON.parse(out)
    expect(typeof data.message).toBe('string')
    expect(Array.isArray(data.available_alternatives)).toBe(true)
  })
})
```

- [ ] **Step 11.2: Verify failures**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'keyword_frequency'
```

Expected: 3 failures.

- [ ] **Step 11.3: Implement keywordFrequency**

```typescript
const keywordFrequencySchema = z.object({
  session_id: z.string().describe('Session ID (unused; tool returns info only)'),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default) or json'),
})

export type KeywordFrequencyParams = z.infer<typeof keywordFrequencySchema>

const KEYWORD_FREQUENCY_MESSAGE = `keyword_frequency is not implemented in chatlab-mcp-server.

This feature requires CJK word segmentation (jieba / kuromoji), which the MCP
server does not bundle to keep the package lightweight.

Alternatives:
1. Run keyword_frequency in the ChatLab desktop app (Insights > Word Cloud).
2. Use execute_sql with LIKE patterns for known phrases:
     SELECT content, COUNT(*) AS c FROM message
     WHERE content LIKE '%<phrase>%'
     GROUP BY content ORDER BY c DESC LIMIT 20
3. Use get_messages with a keyword filter and count occurrences in your reply.`

const KEYWORD_FREQUENCY_ALTERNATIVES = [
  "Run keyword_frequency in the ChatLab desktop app (Insights > Word Cloud).",
  "Use execute_sql with LIKE patterns to count occurrences of known phrases.",
  "Use get_messages with a keyword filter and count in the LLM response.",
]

export async function keywordFrequency(params: KeywordFrequencyParams): Promise<string> {
  void params.session_id
  if (params.format === 'json') {
    return JSON.stringify(
      { message: KEYWORD_FREQUENCY_MESSAGE, available_alternatives: KEYWORD_FREQUENCY_ALTERNATIVES },
      null,
      2
    )
  }
  return KEYWORD_FREQUENCY_MESSAGE
}
```

Register:

```typescript
  server.tool(
    'keyword_frequency',
    'Word/keyword frequency analysis. Currently not implemented in the MCP server due to NLP dependency size; returns a stub message with alternative approaches.',
    keywordFrequencySchema.shape,
    async (args) => {
      try {
        const text = await keywordFrequency(args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
```

- [ ] **Step 11.4: Verify tests pass**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npx vitest run tests/tools/analytics.test.ts -t 'keyword_frequency'
```

Expected: 3 passed.

- [ ] **Step 11.5: Commit**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add keyword_frequency stub tool

Returns an informational message describing why the tool is
unavailable in the MCP server (no bundled CJK segmenter) plus
concrete alternatives the LLM can take instead.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: End-to-end test integration check

**Files:** none (test run only)

- [ ] **Step 12.1: Run the full test suite**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npm test
```

Expected: every test passes. Original 26 + new tests (utils.test.ts 3, analytics helpers 10, get_message_context 5, get_conversation_between 4, get_session_summaries 5, deep_search_messages 6, get_time_stats 6, get_member_activity 4, get_member_name_history 3, get_response_time_analysis 4, keyword_frequency 3 = 26 original + ~53 new ≈ 79 total). If any fail, fix and stay on this task — do NOT skip.

- [ ] **Step 12.2: Build the project**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npm run build
```

Expected: clean compile.

- [ ] **Step 12.3: Smoke-test the binary against a running ChatLab**

If a real ChatLab instance is running with API enabled and a valid token:

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
CHATLAB_URL=http://127.0.0.1:5200 CHATLAB_TOKEN=<token> node dist/index.js < /dev/null
```

Expected: process starts and listens on stdio (no immediate error). Press Ctrl+C to stop. If you have an MCP client (Claude Desktop), connect and verify the new tools appear in the tool list. (Optional manual check — skip if no ChatLab instance handy.)

---

## Task 13: Update README and bump version

**Files:**
- Modify: `package.json`
- Modify: `README.md`, `README.zh-CN.md`, `README.zh-TW.md`, `README.ja.md`

- [ ] **Step 13.1: Bump version in package.json**

In `package.json`, change `"version": "0.17.2"` to `"version": "0.18.0"`. Use Edit, not sed.

- [ ] **Step 13.2: Update tool list in README.md**

In `README.md`, find the section listing tools (search for `list_sessions` or `get_messages`). Add entries for each new tool. Example block to append after the existing tool list:

```markdown
### Analytics tools (v0.18.0+)

- `get_message_context` — N messages before/after a target message ID
- `get_conversation_between` — messages between two specific members
- `get_session_summaries` — AI-generated chat sub-session summaries
- `deep_search_messages` — FTS5 keyword search with context window
- `get_time_stats` — hourly/weekday/daily distribution (timezone-aware)
- `get_member_activity` — top-N members by message count with percentage
- `get_member_name_history` — name change history for a member
- `get_response_time_analysis` — reply intervals between sender pairs
- `keyword_frequency` — stub (returns hint; CJK segmentation not bundled)
```

Also update any compatibility notice (e.g. "Compatible with ChatLab v0.17.2") to mention the new version range.

- [ ] **Step 13.3: Apply the same updates to README.zh-CN.md, README.zh-TW.md, README.ja.md**

Translate the section headings into the target language; keep tool names and behavior descriptions in English (consistent with existing translations). If unsure of translation, mirror the existing pattern of those README files.

For brevity, the translated section headings should be:
- zh-CN: `### 分析工具 (v0.18.0+)`
- zh-TW: `### 分析工具 (v0.18.0+)`
- ja: `### 分析ツール (v0.18.0+)`

Tool descriptions in each translation can mirror the existing translation style (some keep English, some translate). Read the existing file before editing to match its convention.

- [ ] **Step 13.4: Run tests + build one more time**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npm test && npm run build
```

Expected: all green.

- [ ] **Step 13.5: Commit version + docs**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git add package.json README.md README.zh-CN.md README.zh-TW.md README.ja.md
git commit -m "$(cat <<'EOF'
release: v0.18.0 — analytics tools parity

Adds 9 SQL-backed analytics tools matching the desktop app's in-app
AI primitives (get_message_context, get_conversation_between,
get_session_summaries, deep_search_messages, get_time_stats,
get_member_activity, get_member_name_history,
get_response_time_analysis, keyword_frequency stub).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Tag, push, optional publish

**Files:** none

- [ ] **Step 14.1: Create the release tag**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git tag v0.18.0
```

- [ ] **Step 14.2: Push commits AND tag**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
git push origin main
git push origin v0.18.0
```

If a CI/CD pipeline auto-publishes on tag, monitor the GitHub Actions run.

- [ ] **Step 14.3 (optional, only if user requests): npm publish manually**

```bash
cd /Users/gamesme/Developer/code/chatlab-mcp-server
npm publish --access public
```

Skip this step unless the user explicitly asks — the tag push usually triggers the release workflow.

---

## Done

All 9 new tools registered, ~53 new tests passing, version bumped to 0.18.0, tag pushed.

If any task surfaces an unexpected SQL error during real-world testing (e.g. `chat_session` schema differs slightly across ChatLab versions), file a follow-up: do NOT silently catch it in production code. Surface the upstream error.
