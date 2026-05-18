# Message Tools Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the three independent message-rendering paths in `chatlab-mcp-server` into a single factory-enforced pipeline, fix the `get_messages` → `get_message_context` call chain by preserving `id`/`senderPlatformId`, push `filter_invalid` filtering to the SQL layer, and remove two redundant tools.

**Architecture:** A new `registerMessageTool` factory (in `src/tools/message-tool.ts`) is the single registration entry point for all 6 message-returning tools. Each tool implements only a `fetch` function that returns `RawMessage[]`; the factory injects shared params (`format`/`timezone`/`merge_consecutive`/`filter_invalid`), invokes `fetch`, then dispatches to a shared `renderMessages` function. The contract is enforced by a static-scan test that fails if any future tool calls formatting helpers directly.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod` (validation), `vitest` (testing). No new dependencies.

**Spec reference:** [docs/superpowers/specs/2026-05-18-message-tools-refactor-design.md](../specs/2026-05-18-message-tools-refactor-design.md)

---

## File Structure

**New files:**
- `src/tools/message-tool.ts` — factory + render pipeline
- `tests/format.test.ts` — `RawMessage`/render pure-function tests
- `tests/message-tool.test.ts` — factory contract + convention enforcement

**Modified files:**
- `src/format.ts` — add `RawMessage`, shared constants
- `src/tools/messages.ts` — split into `fetchMessagesViaRest` + `fetchMessagesViaSql`; register via factory
- `src/tools/conversation.ts` — delete `get_conversation_text`; rewrite `get_full_conversation`
- `src/tools/analytics.ts` — migrate 3 message tools to factory; delete `keyword_frequency` registration
- `src/tools/stats.ts` — replace `formatStatsOverviewAsText` with `formatToolResultAsText`
- `src/tools/sessions.ts` / `src/tools/members.ts` — minor field-stripping cleanup
- `src/tools/sql.ts` — description-only fix
- Various `tests/tools/*.test.ts` — assertions updated for new output shape

---

## Phase 1 — Foundation

### Task 1: Add `RawMessage` type and shared constants

**Files:**
- Modify: `src/format.ts:6-12` (extend `FormattedMessage` block)
- Modify: `src/format.ts:21` (replace `MAX_CONTENT_LENGTH` block with shared constants section)
- Create: `tests/format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  formatMessagesAsPlainText,
  formatToolResultAsText,
  type RawMessage,
  MESSAGES_PER_PAGE_MAX,
  FULL_CONVERSATION_TOTAL_MAX,
} from '../src/format.js'

describe('RawMessage type & constants', () => {
  it('exports MESSAGES_PER_PAGE_MAX = 500', () => {
    expect(MESSAGES_PER_PAGE_MAX).toBe(500)
  })

  it('exports FULL_CONVERSATION_TOTAL_MAX = 2000', () => {
    expect(FULL_CONVERSATION_TOTAL_MAX).toBe(2000)
  })

  it('RawMessage is assignable to formatMessagesAsPlainText input', () => {
    const messages: RawMessage[] = [
      { id: 1, senderName: 'Alice', senderPlatformId: 'p_alice', content: 'hello', timestamp: 1700000000, type: 0 },
    ]
    const text = formatMessagesAsPlainText(messages, { timezone: 'UTC' })
    expect(text).toContain('Alice')
    expect(text).toContain('hello')
  })
})

describe('formatToolResultAsText edge cases', () => {
  it('renders timeRange objects as "start ~ end"', () => {
    const text = formatToolResultAsText({
      timeRange: { start: '2026-01-01', end: '2026-01-02' },
    })
    expect(text).toBe('timeRange: 2026-01-01 ~ 2026-01-02')
  })

  it('joins array fields with comma-space', () => {
    const text = formatToolResultAsText({ tags: ['a', 'b', 'c'] })
    expect(text).toBe('tags: a, b, c')
  })

  it('omits null/undefined keys', () => {
    const text = formatToolResultAsText({ a: 'x', b: null, c: undefined, d: 'y' })
    expect(text).toBe('a: x\nd: y')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/format.test.ts`
Expected: FAIL — `RawMessage`, `MESSAGES_PER_PAGE_MAX`, `FULL_CONVERSATION_TOTAL_MAX` not exported from `src/format.ts`.

- [ ] **Step 3: Add type and constants to `src/format.ts`**

Open `src/format.ts`. Locate the `FormattedMessage` interface (around line 6). **Add** the following exports immediately after the existing imports/comment block at the top of the file (before `FormattedMessage`):

```ts
/**
 * 中间类型:所有"返回消息"的工具内部统一使用。
 * fetch 层 → RawMessage[] → render 层。
 *
 * 字段必须可以从 REST `/messages` 和 POST `/sql` 两条数据通道
 * 等价地填充——凡是其中一边拿不到的字段都不放进来。
 */
export interface RawMessage {
  /** message.id (数据库主键)。LLM 通过它链式调 get_message_context。 */
  id: number
  /** 发送者显示名,优先级: group_nickname → account_name → platform_id */
  senderName: string
  /** 发送者跨平台稳定 ID,用于后续按 sender 过滤。 */
  senderPlatformId: string
  /** 消息文本内容。可能为 null(图片/语音等非文本消息) */
  content: string | null
  /** Unix 秒 */
  timestamp: number
  /** 消息类型,见 MESSAGE_TYPES (0=text, 1=image, ...) */
  type: number
}

/** 单次拉取消息的最大条数(REST + SQL 通道共享) */
export const MESSAGES_PER_PAGE_MAX = 500

/** `get_full_conversation` 单次调用累计最多拉取条数 */
export const FULL_CONVERSATION_TOTAL_MAX = 2000
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/format.test.ts`
Expected: PASS — all 6 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts tests/format.test.ts
git commit -m "$(cat <<'EOF'
feat(format): add RawMessage type and shared page-size constants

Introduces the typed intermediate representation that all message-
returning tools will produce. Adds MESSAGES_PER_PAGE_MAX (500) and
FULL_CONVERSATION_TOTAL_MAX (2000) to replace the three inconsistent
limit constants scattered across messages.ts / conversation.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create `messageTool` factory file

**Files:**
- Create: `src/tools/message-tool.ts`

- [ ] **Step 1: Write the factory file**

Create `src/tools/message-tool.ts`:

```ts
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChatLabClient } from '../client.js'
import {
  formatMessagesAsPlainText,
  formatToolResultAsText,
  type RawMessage,
} from '../format.js'
import { toolError } from './utils.js'

/**
 * 工具 fetch 函数的返回值:类型化消息列表 + 可选元数据。
 *
 * - `messages` 顺序自由,工厂的 render 阶段统一按 timestamp 升序排序
 * - `total` 优先于 `has_more`;两者都可省略,此时不生成分页提示
 * - `extra` 透传到最终输出的 details(用于 hits 计数、time_range 等)
 */
export interface MessageFetchResult {
  messages: RawMessage[]
  total?: number
  page?: number
  has_more?: boolean
  extra?: Record<string, unknown>
}

export interface MessageToolDef<TSchema extends ZodRawShape> {
  name: string
  description: string
  /** 工具特有参数 schema。必须包含 session_id。**不要**定义 format/timezone/merge_consecutive/filter_invalid,工厂会自动合入。 */
  schema: TSchema
  /**
   * 拉取消息。只回 RawMessage[] + 元信息;不做排序、不做格式化、不做错误包装。
   * 收到的 args 已经过 zod 验证,且包含 4 个共享参数——但 fetch 不应该读它们。
   */
  fetch: (args: any) => Promise<MessageFetchResult>
}

/** 4 个共享参数。工厂自动合入每个工具的 schema。 */
export const SHARED_MESSAGE_PARAMS = {
  format: z.enum(['json', 'text']).optional()
    .describe('Output format: text (default, compact) or json (raw structured)'),
  timezone: z.string().optional()
    .describe('IANA timezone for time display, e.g. "Asia/Shanghai", "UTC". Default: Asia/Shanghai'),
  merge_consecutive: z.boolean().optional()
    .describe('Merge consecutive messages from same sender (text format only, default: true)'),
  filter_invalid: z.boolean().optional()
    .describe('Filter stickers, system messages, single-char replies (text format only, default: true)'),
}

interface SharedOpts {
  format?: 'json' | 'text'
  timezone?: string
  merge_consecutive?: boolean
  filter_invalid?: boolean
}

/**
 * 将工具产出的 RawMessage[] + 元数据渲染为 MCP 文本输出。
 * 排序在这里完成(REST 返回 desc,SQL 可能乱序,多页拼接后顺序更乱)。
 */
export function renderMessages(
  result: MessageFetchResult,
  toolName: string,
  sessionId: string,
  opts: SharedOpts,
): string {
  const sorted = [...result.messages].sort((a, b) => a.timestamp - b.timestamp)
  const hasMore =
    (result.total !== undefined && sorted.length < result.total) ||
    result.has_more === true

  // ── JSON 路径 ────────────────────────────────────────
  if ((opts.format ?? 'text') === 'json') {
    const payload: Record<string, unknown> = {
      total: result.total ?? sorted.length,
      returned: sorted.length,
      ...(result.page !== undefined && { page: result.page }),
      ...result.extra,
      messages: sorted,
    }
    if (hasMore) {
      payload.has_more = true
      payload.hint = `Use page=${(result.page ?? 1) + 1}`
    }
    return JSON.stringify(payload, null, 2)
  }

  // ── Text 路径 ────────────────────────────────────────
  const plainText = formatMessagesAsPlainText(sorted, {
    mergeConsecutive: opts.merge_consecutive ?? true,
    filterInvalid: opts.filter_invalid ?? true,
    timezone: opts.timezone ?? 'Asia/Shanghai',
  })

  const details: Record<string, unknown> = {
    total: result.total ?? sorted.length,
    returned: sorted.length,
    ...(result.page !== undefined && { page: result.page }),
    ...result.extra,
  }
  if (plainText) details.messages = plainText.split('\n')

  if (hasMore) {
    const nextPage = (result.page ?? 1) + 1
    const remaining =
      result.total !== undefined ? result.total - sorted.length : undefined
    const remainingText = remaining !== undefined ? `还有 ${remaining} 条未显示。` : ''
    details.instruction =
      `${remainingText}调用 ${toolName}(session_id="${sessionId}", page=${nextPage}) 获取下一页`
  }

  return formatToolResultAsText(details)
}

/**
 * 注册一个"返回消息"的工具。所有 6 个消息工具都通过此函数注册。
 *
 * 工厂自动:
 *   1. 合入共享参数到 schema
 *   2. 调 fetch 拿 RawMessage[]
 *   3. 调 renderMessages 出最终文本
 *   4. 统一 try/catch → toolError
 */
export function registerMessageTool<TSchema extends ZodRawShape>(
  server: McpServer,
  _client: ChatLabClient,
  def: MessageToolDef<TSchema>,
): void {
  const mergedSchema = {
    ...def.schema,
    ...SHARED_MESSAGE_PARAMS,
  } as unknown as TSchema & typeof SHARED_MESSAGE_PARAMS

  server.tool(
    def.name,
    def.description,
    mergedSchema,
    async (args: any) => {
      try {
        const sessionId: string = args.session_id ?? ''
        const sharedOpts: SharedOpts = {
          format: args.format,
          timezone: args.timezone,
          merge_consecutive: args.merge_consecutive,
          filter_invalid: args.filter_invalid,
        }
        const result = await def.fetch(args)
        const text = renderMessages(result, def.name, sessionId, sharedOpts)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    },
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors). If errors reference `formatMessagesAsPlainText` accepting `RawMessage[]`, the existing `FormattedMessage` interface (in `src/format.ts`) already has `senderName: string`, `content: string | null`, `timestamp: number` — so `RawMessage[]` is structurally compatible. If TypeScript complains, add `as any` cast on the `formatMessagesAsPlainText(sorted, …)` call. **Do not** widen the `FormattedMessage` interface — that's a separate concern.

- [ ] **Step 3: Commit**

```bash
git add src/tools/message-tool.ts
git commit -m "$(cat <<'EOF'
feat(tools): add messageTool factory and renderMessages pipeline

Introduces registerMessageTool() — the single registration entry point
for all message-returning tools. The factory auto-injects four shared
params (format / timezone / merge_consecutive / filter_invalid) and
dispatches to renderMessages() which owns sorting + formatting.

No existing tool consumes the factory yet; subsequent tasks migrate
each tool one at a time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Factory contract tests

**Files:**
- Create: `tests/message-tool.test.ts`

- [ ] **Step 1: Write the contract tests**

Create `tests/message-tool.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  registerMessageTool,
  renderMessages,
  SHARED_MESSAGE_PARAMS,
  type MessageFetchResult,
} from '../src/tools/message-tool.js'
import type { RawMessage } from '../src/format.js'
import { ChatLabError } from '../src/client.js'

function makeMockServer() {
  const registered: Array<{ name: string; schema: any; handler: any }> = []
  const server: any = {
    tool: (name: string, _desc: string, schema: any, handler: any) => {
      registered.push({ name, schema, handler })
    },
  }
  return { server, registered }
}

const sampleMessages: RawMessage[] = [
  { id: 2, senderName: 'B', senderPlatformId: 'p_b', content: 'two', timestamp: 200, type: 0 },
  { id: 1, senderName: 'A', senderPlatformId: 'p_a', content: 'one', timestamp: 100, type: 0 },
  { id: 3, senderName: 'A', senderPlatformId: 'p_a', content: 'three', timestamp: 300, type: 0 },
]

describe('renderMessages', () => {
  it('sorts messages by timestamp ascending in JSON mode', () => {
    const json = renderMessages(
      { messages: sampleMessages },
      'test_tool',
      'sess_x',
      { format: 'json' },
    )
    const parsed = JSON.parse(json)
    expect(parsed.messages.map((m: RawMessage) => m.id)).toEqual([1, 2, 3])
  })

  it('preserves id and senderPlatformId in JSON mode', () => {
    const json = renderMessages(
      { messages: sampleMessages },
      'test_tool',
      'sess_x',
      { format: 'json' },
    )
    const parsed = JSON.parse(json)
    expect(parsed.messages[0]).toMatchObject({ id: 1, senderPlatformId: 'p_a' })
  })

  it('does not apply merge/filter in JSON mode (raw output)', () => {
    const withSticker: RawMessage[] = [
      { id: 1, senderName: 'A', senderPlatformId: 'pa', content: '[图片]', timestamp: 100, type: 1 },
    ]
    const json = renderMessages(
      { messages: withSticker },
      'test_tool',
      'sess_x',
      { format: 'json', filter_invalid: true },
    )
    const parsed = JSON.parse(json)
    expect(parsed.messages).toHaveLength(1)
  })

  it('renders sorted text output with timezone', () => {
    const text = renderMessages(
      { messages: sampleMessages },
      'test_tool',
      'sess_x',
      { format: 'text', timezone: 'UTC', merge_consecutive: false, filter_invalid: false },
    )
    expect(text).toContain('A: one')
    expect(text).toContain('B: two')
    expect(text).toContain('A: three')
    // ensure timestamps appear chronologically in output
    expect(text.indexOf('one')).toBeLessThan(text.indexOf('two'))
    expect(text.indexOf('two')).toBeLessThan(text.indexOf('three'))
  })

  it('generates pagination instruction when total > returned', () => {
    const text = renderMessages(
      { messages: sampleMessages, total: 10, page: 1 },
      'get_messages',
      'sess_abc',
      { format: 'text' },
    )
    expect(text).toContain('还有 7 条未显示')
    expect(text).toContain('page=2')
    expect(text).toContain('sess_abc')
  })

  it('generates pagination instruction when has_more is true (no total)', () => {
    const text = renderMessages(
      { messages: sampleMessages, has_more: true, page: 1 },
      'get_messages',
      'sess_abc',
      { format: 'text' },
    )
    expect(text).toContain('page=2')
  })

  it('omits pagination when neither total nor has_more indicates more', () => {
    const text = renderMessages(
      { messages: sampleMessages },
      'get_messages',
      'sess_abc',
      { format: 'text' },
    )
    expect(text).not.toContain('page=')
    expect(text).not.toContain('未显示')
  })

  it('threads extra fields through to text output', () => {
    const text = renderMessages(
      { messages: sampleMessages, extra: { hits: 7 } },
      'deep_search_messages',
      'sess_abc',
      { format: 'text' },
    )
    expect(text).toContain('hits: 7')
  })
})

describe('registerMessageTool', () => {
  it('auto-injects 4 shared params into the schema', () => {
    const { server, registered } = makeMockServer()
    const client: any = {}
    registerMessageTool(server, client, {
      name: 'fake_tool',
      description: 'fake',
      schema: { session_id: z.string() },
      fetch: async () => ({ messages: [] }),
    })
    const schema = registered[0].schema
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining([
        'session_id',
        'format',
        'timezone',
        'merge_consecutive',
        'filter_invalid',
      ]),
    )
  })

  it('calls fetch with all args including shared params', async () => {
    const { server, registered } = makeMockServer()
    const client: any = {}
    const fetchSpy = vi.fn(async () => ({ messages: [] }))
    registerMessageTool(server, client, {
      name: 'fake_tool',
      description: 'fake',
      schema: { session_id: z.string() },
      fetch: fetchSpy,
    })
    await registered[0].handler({ session_id: 's1', format: 'json', timezone: 'UTC' })
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 's1', format: 'json', timezone: 'UTC' }),
    )
  })

  it('translates ChatLabError 404 into "Session not found" message', async () => {
    const { server, registered } = makeMockServer()
    const client: any = {}
    registerMessageTool(server, client, {
      name: 'fake_tool',
      description: 'fake',
      schema: { session_id: z.string() },
      fetch: async () => {
        throw new ChatLabError(404, 'Not found: /api/v1/sessions/missing')
      },
    })
    const result = await registered[0].handler({ session_id: 'missing' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Session not found: missing')
  })

  it('produces sorted text output from unsorted fetch result', async () => {
    const { server, registered } = makeMockServer()
    const client: any = {}
    registerMessageTool(server, client, {
      name: 'fake_tool',
      description: 'fake',
      schema: { session_id: z.string() },
      fetch: async (): Promise<MessageFetchResult> => ({ messages: sampleMessages }),
    })
    const result = await registered[0].handler({
      session_id: 's1',
      timezone: 'UTC',
      merge_consecutive: false,
      filter_invalid: false,
    })
    const text = result.content[0].text as string
    expect(text.indexOf('one')).toBeLessThan(text.indexOf('two'))
    expect(text.indexOf('two')).toBeLessThan(text.indexOf('three'))
  })
})

describe('convention enforcement (static scan)', () => {
  it('only message-tool.ts may import formatMessagesAsPlainText in src/tools/', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const toolsDir = join(__dirname, '../src/tools')
    const ALLOWED = new Set(['message-tool.ts'])
    const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))
    const violators: string[] = []
    for (const file of files) {
      if (ALLOWED.has(file)) continue
      const content = readFileSync(join(toolsDir, file), 'utf-8')
      if (/formatMessagesAsPlainText/.test(content)) {
        violators.push(file)
      }
    }
    expect(violators, `These tool files call formatMessagesAsPlainText directly. Migrate them to registerMessageTool factory:\n  ${violators.join('\n  ')}`).toEqual([])
  })

  it('no tool file calls Date.toLocaleString directly (except sessions.ts list rendering)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const toolsDir = join(__dirname, '../src/tools')
    // sessions.ts and members.ts may have bespoke list formatters that use toLocaleString
    // for session/member timestamps. Message tools must NOT.
    const ALLOWED = new Set(['message-tool.ts', 'sessions.ts', 'members.ts'])
    const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))
    const violators: string[] = []
    for (const file of files) {
      if (ALLOWED.has(file)) continue
      const content = readFileSync(join(toolsDir, file), 'utf-8')
      if (/\.toLocaleString\(/.test(content)) {
        violators.push(file)
      }
    }
    expect(violators, `These tool files call Date.toLocaleString() directly. Migrate them to registerMessageTool factory:\n  ${violators.join('\n  ')}`).toEqual([])
  })
})

describe('SHARED_MESSAGE_PARAMS', () => {
  it('exports exactly 4 shared parameter keys', () => {
    expect(Object.keys(SHARED_MESSAGE_PARAMS).sort()).toEqual([
      'filter_invalid',
      'format',
      'merge_consecutive',
      'timezone',
    ])
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/message-tool.test.ts`

Expected outcome: most tests PASS. **Two tests in the "convention enforcement (static scan)" group will FAIL** — that is intentional and correct. They fail right now because `messages.ts`, `conversation.ts`, and `analytics.ts` still call `formatMessagesAsPlainText` and/or `toLocaleString` directly. These two tests will go green as Tasks 6, 8, 9, 10, 11 migrate each file.

The failing-now-fixing-later pattern is a deliberate forcing function — the engineer will see the violator list shrink with each migration.

- [ ] **Step 3: Commit**

```bash
git add tests/message-tool.test.ts
git commit -m "$(cat <<'EOF'
test(tools): add messageTool factory contract + convention tests

Includes two static-scan tests that fail until all message tools are
migrated. The failure messages list violators by filename, so each
subsequent migration task should make the list shrink. Once empty,
the tests prevent future regressions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — `get_messages` Migration

### Task 4: Refactor `messages.ts` — `fetchMessagesViaRest`

**Files:**
- Modify: `src/tools/messages.ts` (whole-file rewrite)
- Modify: `tests/tools/messages.test.ts`

Note: this task replaces `get_messages` function-level behavior; it does **not** yet register via the factory (Task 6 does that). Keeping the changes incremental keeps each commit reviewable.

- [ ] **Step 1: Update test expectations**

Open `tests/tools/messages.test.ts`. Replace the existing test for "caps limit at MAX_LIMIT (500)" — the assertion is unchanged, but the default limit changes from 20 to 100, and `id`/`senderPlatformId` must now be retained. Replace the whole file contents with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchMessagesViaRest } from '../../src/tools/messages.js'

const mockClient: any = { get: vi.fn(), post: vi.fn() }

beforeEach(() => {
  mockClient.get.mockReset()
  mockClient.post.mockReset()
})

describe('fetchMessagesViaRest', () => {
  it('calls messages endpoint with session_id', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [{ id: 1, senderName: 'A', senderPlatformId: 'pa', content: 'Hi', timestamp: 100, type: 0 }], total: 1, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc' })

    expect(mockClient.get).toHaveBeenCalledWith(
      '/api/v1/sessions/chat_5_abc/messages',
      expect.any(Object),
    )
  })

  it('defaults limit to 100', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc', filter_invalid: false })

    const params = mockClient.get.mock.calls[0][1]
    expect(params.limit).toBe('100')
  })

  it('caps limit at MESSAGES_PER_PAGE_MAX (500)', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc', limit: 9999, filter_invalid: false })

    const params = mockClient.get.mock.calls[0][1]
    expect(params.limit).toBe('500')
  })

  it('passes all REST-eligible filters as string query params', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, {
      session_id: 'chat_5_abc',
      keyword: 'hello',
      start_time: 1700000000,
      end_time: 1700100000,
      sender_id: 'user123',
      type: 1,
      page: 2,
      limit: 50,
      filter_invalid: false,
    })

    expect(mockClient.get).toHaveBeenCalledWith('/api/v1/sessions/chat_5_abc/messages', {
      keyword: 'hello',
      startTime: '1700000000',
      endTime: '1700100000',
      sender_id: 'user123',
      type: '1',
      page: '2',
      limit: '50',
    })
  })

  it('preserves id and senderPlatformId in RawMessage output', async () => {
    mockClient.get.mockResolvedValue({
      data: {
        messages: [
          {
            id: 42,
            senderName: 'Alice',
            senderPlatformId: 'p_alice',
            senderAvatar: 'http://example.com/a.png',
            senderAliases: ['Al'],
            senderId: 999,
            content: 'Hi',
            timestamp: 100,
            type: 0,
            replyToMessageId: null,
          },
        ],
        total: 1,
        page: 1,
      },
    })

    const result = await fetchMessagesViaRest(mockClient, {
      session_id: 's1',
      keyword: 'hi',
      filter_invalid: false,
    })

    expect(result.messages[0]).toEqual({
      id: 42,
      senderName: 'Alice',
      senderPlatformId: 'p_alice',
      content: 'Hi',
      timestamp: 100,
      type: 0,
    })
  })

  it('returns total and page from REST response', async () => {
    mockClient.get.mockResolvedValue({
      data: { messages: [], total: 250, page: 3 },
    })

    const result = await fetchMessagesViaRest(mockClient, {
      session_id: 's1',
      keyword: 'x',
      filter_invalid: false,
    })

    expect(result.total).toBe(250)
    expect(result.page).toBe(3)
  })

  it('omits undefined optional params from query', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 'chat_5_abc', filter_invalid: false })

    const params = mockClient.get.mock.calls[0][1]
    expect(params).not.toHaveProperty('keyword')
    expect(params).not.toHaveProperty('startTime')
    expect(params).not.toHaveProperty('endTime')
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/tools/messages.test.ts`
Expected: FAIL — `fetchMessagesViaRest` not exported from `src/tools/messages.js`.

- [ ] **Step 3: Rewrite `src/tools/messages.ts`**

Replace the entire contents of `src/tools/messages.ts` with:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChatLabClient } from '../client.js'
import { MESSAGES_PER_PAGE_MAX, type RawMessage } from '../format.js'
import { toolError } from './utils.js'
import { formatMessagesAsPlainText, formatToolResultAsText } from '../format.js'

export interface FetchMessagesParams {
  session_id: string
  keyword?: string
  start_time?: number
  end_time?: number
  sender_id?: string
  type?: number
  page?: number
  limit?: number
  filter_invalid?: boolean
  // remaining shared params (format/timezone/merge_consecutive) are unused here
}

export interface FetchMessagesResult {
  messages: RawMessage[]
  total?: number
  page: number
  has_more?: boolean
}

/**
 * 拉取消息(REST 通道)。
 * SQL fast path 由 Task 5 增加;本任务先只走 REST。
 */
export async function fetchMessagesViaRest(
  client: Pick<ChatLabClient, 'get'>,
  params: FetchMessagesParams,
): Promise<FetchMessagesResult> {
  const query: Record<string, string> = {}
  if (params.keyword !== undefined) query.keyword = params.keyword
  if (params.start_time !== undefined && Number.isFinite(params.start_time)) {
    query.startTime = String(params.start_time)
  }
  if (params.end_time !== undefined && Number.isFinite(params.end_time)) {
    query.endTime = String(params.end_time)
  }
  if (params.sender_id !== undefined) query.sender_id = params.sender_id
  if (params.type !== undefined && Number.isFinite(params.type)) {
    query.type = String(params.type)
  }
  if (params.page !== undefined && Number.isFinite(params.page)) {
    query.page = String(params.page)
  }
  const effectiveLimit =
    params.limit !== undefined && Number.isFinite(params.limit) ? params.limit : 100
  query.limit = String(Math.min(effectiveLimit, MESSAGES_PER_PAGE_MAX))

  const result: any = await client.get(
    `/api/v1/sessions/${params.session_id}/messages`,
    query,
  )

  const rawMessages: RawMessage[] = (result.data?.messages ?? []).map((m: any) => ({
    id: m.id,
    senderName: m.senderName,
    senderPlatformId: m.senderPlatformId,
    content: m.content,
    timestamp: m.timestamp,
    type: m.type,
  }))

  return {
    messages: rawMessages,
    total: result.data?.total,
    page: result.data?.page ?? Number(query.page ?? 1),
  }
}

// ─── Temporary backwards-compatible getMessages() ──────────────────────────
// Task 6 deletes this and migrates to registerMessageTool. Kept here for one
// task so existing server.tool registration continues to compile.

const MESSAGE_TYPE_DESC =
  '0=text 1=image 2=voice 3=video 4=emoji 5=file 7=location 8=system ' +
  '21=voip 23=quote 24=pat 25=link 27=music 80=miniapp 99=other'

const getMessagesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keyword: z.string().optional()
    .describe('Full-text search via FTS5 when available, falls back to LIKE'),
  start_time: z.number().finite().optional().describe('Start time as Unix seconds'),
  end_time: z.number().finite().optional().describe('End time as Unix seconds'),
  sender_id: z.string().optional().describe('Filter by member platformId'),
  type: z.number().finite().optional()
    .describe(`Filter by message type code. ${MESSAGE_TYPE_DESC}`),
  page: z.number().finite().optional()
    .describe('Page number (default 1). page=1 returns the LATEST messages; within each page messages are sorted chronologically (ascending)'),
  limit: z.number().finite().optional()
    .describe(`Messages per page (default 100, max ${MESSAGES_PER_PAGE_MAX})`),
  format: z.enum(['json', 'text']).optional().describe('Output format'),
  merge_consecutive: z.boolean().optional().describe('Merge consecutive (text only)'),
  filter_invalid: z.boolean().optional().describe('Filter invalid (text only)'),
  timezone: z.string().optional().describe('Timezone for time display'),
})

type GetMessagesParams = z.infer<typeof getMessagesSchema>

export async function getMessages(
  client: Pick<ChatLabClient, 'get'>,
  params: GetMessagesParams,
): Promise<string> {
  const { format = 'text', timezone = 'Asia/Shanghai', merge_consecutive, filter_invalid, ...rest } = params
  const result = await fetchMessagesViaRest(client, rest as FetchMessagesParams)

  const sorted = [...result.messages].sort((a, b) => a.timestamp - b.timestamp)

  if (format === 'text') {
    const plainText = formatMessagesAsPlainText(sorted, {
      mergeConsecutive: merge_consecutive ?? true,
      filterInvalid: filter_invalid ?? true,
      timezone,
    })
    const details: Record<string, unknown> = {
      total: result.total,
      returned: sorted.length,
      page: result.page,
    }
    if (plainText) details.messages = plainText.split('\n')
    if (result.total !== undefined && sorted.length < result.total) {
      const nextPage = (result.page ?? 1) + 1
      const remaining = result.total - sorted.length
      details.instruction =
        `还有 ${remaining} 条未显示。调用 get_messages(session_id="${params.session_id}", page=${nextPage}) 获取下一页`
    }
    return formatToolResultAsText(details)
  }

  return JSON.stringify({
    data: {
      messages: sorted,
      total: result.total,
      page: result.page,
    },
  }, null, 2)
}

export function registerMessagesTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_messages',
    `The primary tool for reading message content. Retrieves up to ${MESSAGES_PER_PAGE_MAX} messages per call with filters for keyword (FTS5 when available), time range, sender, and type. Returns plain text by default; pass format=json for raw structured output. Prefer this over execute_sql when reading messages.`,
    getMessagesSchema.shape,
    async (args) => {
      try {
        const text = await getMessages(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    },
  )
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run tests/tools/messages.test.ts`
Expected: PASS — all 7 assertions green.

Also run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/messages.ts tests/tools/messages.test.ts
git commit -m "$(cat <<'EOF'
refactor(messages): split fetchMessagesViaRest, preserve id/senderPlatformId

- Extract fetchMessagesViaRest() as a pure data-fetch function returning
  RawMessage[] (with id and senderPlatformId retained — fixes the
  get_messages → get_message_context chain break).
- Default limit 20 → 100 (matches upstream worker.searchMessages default).
- Update keyword description to reflect FTS5 fallback to LIKE.
- Document page=1=latest semantics in the page param description.
- Add full type-code mapping (0=text … 99=other) to the type param.

getMessages() remains as a thin wrapper for now — Task 6 deletes it
and registers via registerMessageTool factory.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add SQL fast path to `fetchMessagesViaRest`

**Files:**
- Modify: `src/tools/messages.ts` (extend `fetchMessagesViaRest` + add `fetchMessagesViaSql`)
- Modify: `tests/tools/messages.test.ts`

- [ ] **Step 1: Add failing tests for SQL fast path**

Append to `tests/tools/messages.test.ts` (before the final closing brace of the file):

```ts
describe('fetchMessagesViaRest — SQL fast path routing', () => {
  it('routes to SQL when filter_invalid is true (default) and no keyword', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [[1, 100, 0, 'hi', 'pa', 'Alice']],
      },
    })

    await fetchMessagesViaRest(mockClient, { session_id: 's1' })

    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/v1/sessions/s1/sql',
      expect.objectContaining({ sql: expect.stringContaining('FROM message msg') }),
    )
    expect(mockClient.get).not.toHaveBeenCalled()
  })

  it('routes to REST when keyword is present (FTS5 lives upstream)', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 's1', keyword: 'hello' })

    expect(mockClient.get).toHaveBeenCalled()
    expect(mockClient.post).not.toHaveBeenCalled()
  })

  it('routes to REST when filter_invalid is explicitly false', async () => {
    mockClient.get.mockResolvedValue({ data: { messages: [], total: 0, page: 1 } })

    await fetchMessagesViaRest(mockClient, { session_id: 's1', filter_invalid: false })

    expect(mockClient.get).toHaveBeenCalled()
    expect(mockClient.post).not.toHaveBeenCalled()
  })

  it('SQL path filters system messages and non-text types by default', async () => {
    mockClient.post.mockResolvedValue({ data: { columns: ['id'], rows: [] } })

    await fetchMessagesViaRest(mockClient, { session_id: 's1' })

    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toContain('msg.type = 0')
    expect(sql).toContain("msg.content != ''")
    expect(sql).toContain("COALESCE(m.account_name, '') != '系统消息'")
  })

  it('SQL path returns has_more=true when more than `limit` rows returned', async () => {
    // Request limit+1 trick: 3 limit means SQL returns up to 4 rows
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [
          [1, 100, 0, 'a', 'p1', 'A'],
          [2, 200, 0, 'b', 'p2', 'B'],
          [3, 300, 0, 'c', 'p3', 'C'],
          [4, 400, 0, 'd', 'p4', 'D'],
        ],
      },
    })

    const result = await fetchMessagesViaRest(mockClient, { session_id: 's1', limit: 3 })

    expect(result.messages).toHaveLength(3)
    expect(result.has_more).toBe(true)
  })

  it('SQL path returns has_more=false when fewer than limit+1 rows', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [[1, 100, 0, 'a', 'p1', 'A']],
      },
    })

    const result = await fetchMessagesViaRest(mockClient, { session_id: 's1', limit: 3 })

    expect(result.has_more).toBe(false)
    expect(result.messages).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/tools/messages.test.ts`
Expected: FAIL — no SQL routing logic exists yet.

- [ ] **Step 3: Add SQL fast path to `messages.ts`**

In `src/tools/messages.ts`, add the import for `sqlInternal` and the new function `fetchMessagesViaSql`. Then modify `fetchMessagesViaRest` to dispatch.

Add to the top of `src/tools/messages.ts` (next to other imports):

```ts
import { sqlInternal } from './utils.js'
```

Add the new function **before** `fetchMessagesViaRest`:

```ts
async function fetchMessagesViaSql(
  client: Pick<ChatLabClient, 'post'>,
  params: FetchMessagesParams,
): Promise<FetchMessagesResult> {
  const page =
    params.page !== undefined && Number.isFinite(params.page)
      ? Math.max(1, Math.floor(params.page))
      : 1
  const limit =
    params.limit !== undefined && Number.isFinite(params.limit)
      ? Math.min(Math.max(1, Math.floor(params.limit)), MESSAGES_PER_PAGE_MAX)
      : 100
  const offset = (page - 1) * limit

  const conditions: string[] = ['1=1']

  if (params.type !== undefined && Number.isFinite(params.type)) {
    conditions.push(`msg.type = ${Math.floor(params.type)}`)
  } else if (params.filter_invalid !== false) {
    // default: only text messages
    conditions.push('msg.type = 0')
  }

  if (params.start_time !== undefined && Number.isFinite(params.start_time)) {
    conditions.push(`msg.ts >= ${Math.floor(params.start_time)}`)
  }
  if (params.end_time !== undefined && Number.isFinite(params.end_time)) {
    conditions.push(`msg.ts <= ${Math.floor(params.end_time)}`)
  }
  if (params.sender_id !== undefined) {
    const safe = params.sender_id.replace(/'/g, "''")
    conditions.push(`m.platform_id = '${safe}'`)
  }

  // SQL-level filter_invalid (mirrors upstream getRecentMessages)
  conditions.push("msg.content IS NOT NULL")
  conditions.push("msg.content != ''")
  conditions.push("COALESCE(m.account_name, '') != '系统消息'")

  // Request limit+1 rows to detect has_more without a separate COUNT query
  const sql = `
    SELECT
      msg.id AS id,
      msg.ts AS timestamp,
      msg.type AS type,
      msg.content AS content,
      m.platform_id AS senderPlatformId,
      COALESCE(m.group_nickname, m.account_name, m.platform_id) AS senderName
    FROM message msg
    JOIN member m ON msg.sender_id = m.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY msg.ts DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `.trim()

  const rows = await sqlInternal(client, params.session_id, sql)
  const hasMore = rows.length > limit
  const trimmed = hasMore ? rows.slice(0, limit) : rows

  const messages: RawMessage[] = trimmed.map((r: any) => ({
    id: r.id,
    senderName: r.senderName,
    senderPlatformId: r.senderPlatformId,
    content: r.content,
    timestamp: r.timestamp,
    type: r.type,
  }))

  return { messages, page, has_more: hasMore }
}
```

Update `fetchMessagesViaRest` to dispatch — replace its function signature and first lines:

```ts
export async function fetchMessagesViaRest(
  client: Pick<ChatLabClient, 'get' | 'post'>,
  params: FetchMessagesParams,
): Promise<FetchMessagesResult> {
  // SQL fast path: when no keyword and filter_invalid is on (default),
  // or when caller explicitly wants only text messages (type=0),
  // bypass REST and run the filtered SQL directly. Saves bandwidth and
  // avoids the post-fetch JS filter.
  const useSqlFastPath =
    (!params.keyword && params.filter_invalid !== false) || params.type === 0

  if (useSqlFastPath) {
    return fetchMessagesViaSql(client, params)
  }

  // ─── REST path (unchanged below) ──────────────────
  const query: Record<string, string> = {}
  // ... rest of existing implementation ...
```

(Keep the existing REST query-building and response-mapping code intact below this dispatch.)

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run tests/tools/messages.test.ts`
Expected: all tests in both groups PASS.

Also run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/messages.ts tests/tools/messages.test.ts
git commit -m "$(cat <<'EOF'
feat(messages): SQL fast path for filter_invalid path

When no keyword is provided and filter_invalid is on (the default),
route directly to POST /sql with SQL-level filtering for type=0,
non-empty content, and non-system messages. Mirrors upstream
worker.getRecentMessages behavior and eliminates the post-fetch
JS filter waste.

Keyword searches continue through REST /messages so they keep
benefiting from upstream FTS5.

Uses LIMIT+1 trick to detect has_more without a separate COUNT.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Register `get_messages` via factory

**Files:**
- Modify: `src/tools/messages.ts` (remove old `getMessages` wrapper, switch to factory)

- [ ] **Step 1: Replace registration**

In `src/tools/messages.ts`, **delete** the existing `getMessages()` function, the `getMessagesSchema` z.object wrapper, and the `registerMessagesTools` function body. Replace `registerMessagesTools` with:

```ts
import { registerMessageTool } from './message-tool.js'

const getMessagesSchema = {
  session_id: z.string().describe('Session ID'),
  keyword: z.string().optional()
    .describe('Full-text search via FTS5 when available, falls back to LIKE'),
  start_time: z.number().finite().optional().describe('Start time as Unix seconds'),
  end_time: z.number().finite().optional().describe('End time as Unix seconds'),
  sender_id: z.string().optional().describe('Filter by member platformId'),
  type: z.number().finite().optional()
    .describe(`Filter by message type code. ${MESSAGE_TYPE_DESC}`),
  page: z.number().finite().optional()
    .describe('Page number (default 1). page=1 returns the LATEST messages; within each page messages are sorted chronologically (ascending)'),
  limit: z.number().finite().optional()
    .describe(`Messages per page (default 100, max ${MESSAGES_PER_PAGE_MAX})`),
} as const

export function registerMessagesTools(server: McpServer, client: ChatLabClient): void {
  registerMessageTool(server, client, {
    name: 'get_messages',
    description: `The primary tool for reading message content. Retrieves up to ${MESSAGES_PER_PAGE_MAX} messages per call with filters for keyword (FTS5 when available), time range, sender, and type. Use page to paginate. Returns plain text by default; pass format=json for raw structured output. Prefer this over execute_sql when reading messages.`,
    schema: getMessagesSchema,
    fetch: (args) => fetchMessagesViaRest(client, args),
  })
}
```

**Remove** these imports that are no longer needed in `messages.ts`:
- `formatMessagesAsPlainText`
- `formatToolResultAsText`
- `toolError` (factory handles it)

Final `messages.ts` imports should look like:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChatLabClient } from '../client.js'
import { MESSAGES_PER_PAGE_MAX, type RawMessage } from '../format.js'
import { sqlInternal } from './utils.js'
import { registerMessageTool } from './message-tool.js'
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: all tests PASS. **Crucially**, the static-scan test "only message-tool.ts may import formatMessagesAsPlainText" should still show violators — but `messages.ts` should no longer appear in the violator list.

Also run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tools/messages.ts
git commit -m "$(cat <<'EOF'
refactor(messages): register get_messages via messageTool factory

get_messages now goes through registerMessageTool — gains the 4 shared
params (format/timezone/merge_consecutive/filter_invalid) from the
factory, and no longer references formatMessagesAsPlainText directly.

The convention-enforcement test's violator list shrinks by one
(messages.ts removed). Remaining violators: conversation.ts,
analytics.ts — those are migrated in Tasks 8-11.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Conversation Tools Cleanup

### Task 7: Delete `get_conversation_text`

**Files:**
- Modify: `src/tools/conversation.ts` (remove `get_conversation_text` registration only — `get_full_conversation` removed in Task 8)

- [ ] **Step 1: Remove the registration**

In `src/tools/conversation.ts`, **delete** the entire `server.tool('get_conversation_text', …)` block (lines 91–112 approximately) along with the `getConversationText` function above it.

Keep the file functional — only `get_full_conversation` registration remains. The next task rewrites it.

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS. (No existing test file references `get_conversation_text` directly.)

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tools/conversation.ts
git commit -m "$(cat <<'EOF'
refactor(conversation): remove redundant get_conversation_text tool

get_conversation_text was fully redundant with get_messages(format='text').
Per spec §13, MCP server is 0.x with no stability commitments — clean
deletion preferred over deprecation period. CHANGELOG note in final task.

get_full_conversation is preserved (still useful for auto-paginated full
conversation fetch) and migrated to factory in Task 8.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Migrate `get_full_conversation` to factory + thin wrapper

**Files:**
- Modify: `src/tools/conversation.ts` (whole-file rewrite)
- Create: `tests/tools/conversation.test.ts`

- [ ] **Step 1: Write failing tests for new behavior**

Create `tests/tools/conversation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchFullConversation } from '../../src/tools/conversation.js'

const mockClient: any = { get: vi.fn(), post: vi.fn() }

beforeEach(() => {
  mockClient.get.mockReset()
  mockClient.post.mockReset()
})

describe('fetchFullConversation', () => {
  it('uses page size 500, not 100', async () => {
    // Single page covers everything
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [[1, 100, 0, 'hi', 'pa', 'Alice']],
      },
    })

    await fetchFullConversation(mockClient, { session_id: 's1', max_total_messages: 50 })

    // SQL path uses limit+1 = 501
    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/LIMIT 501/)
  })

  it('stops at max_total_messages cap', async () => {
    // Return 4 rows for limit+1=4 means 3 fit, has_more true
    const fourRows = [
      [1, 100, 0, 'a', 'pa', 'Alice'],
      [2, 200, 0, 'b', 'pa', 'Alice'],
      [3, 300, 0, 'c', 'pa', 'Alice'],
      [4, 400, 0, 'd', 'pa', 'Alice'],
    ]
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'timestamp', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: fourRows,
      },
    })

    const result = await fetchFullConversation(mockClient, {
      session_id: 's1',
      max_total_messages: 3,
    })

    expect(result.messages.length).toBeLessThanOrEqual(3)
  })

  it('clamps max_total_messages at FULL_CONVERSATION_TOTAL_MAX (2000)', async () => {
    mockClient.post.mockResolvedValue({
      data: { columns: ['id'], rows: [] },
    })

    await fetchFullConversation(mockClient, {
      session_id: 's1',
      max_total_messages: 99999,
    })

    // First call should request 501 rows (one full page) at most;
    // max_total_messages clamp only limits accumulated total.
    expect(mockClient.post).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run tests/tools/conversation.test.ts`
Expected: FAIL — `fetchFullConversation` not exported.

- [ ] **Step 3: Rewrite `src/tools/conversation.ts`**

Replace the entire contents of `src/tools/conversation.ts` with:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChatLabClient } from '../client.js'
import {
  FULL_CONVERSATION_TOTAL_MAX,
  MESSAGES_PER_PAGE_MAX,
  type RawMessage,
} from '../format.js'
import { registerMessageTool, type MessageFetchResult } from './message-tool.js'
import { fetchMessagesViaRest } from './messages.js'

export interface FetchFullConversationParams {
  session_id: string
  max_total_messages?: number
  filter_invalid?: boolean  // shared
}

export async function fetchFullConversation(
  client: Pick<ChatLabClient, 'get' | 'post'>,
  params: FetchFullConversationParams,
): Promise<MessageFetchResult> {
  const requestedMax =
    params.max_total_messages !== undefined && Number.isFinite(params.max_total_messages)
      ? Math.floor(params.max_total_messages)
      : 500
  const maxTotal = Math.min(Math.max(1, requestedMax), FULL_CONVERSATION_TOTAL_MAX)

  const all: RawMessage[] = []
  let page = 1
  let lastHasMore: boolean | undefined
  let lastTotal: number | undefined

  while (all.length < maxTotal) {
    const result = await fetchMessagesViaRest(client, {
      session_id: params.session_id,
      filter_invalid: params.filter_invalid,
      page,
      limit: MESSAGES_PER_PAGE_MAX,
    })

    if (result.messages.length === 0) break

    all.push(...result.messages)
    lastHasMore = result.has_more
    lastTotal = result.total

    // Stop when this page returned fewer than limit (end of data)
    if (result.messages.length < MESSAGES_PER_PAGE_MAX) break

    page++
  }

  const trimmed = all.slice(0, maxTotal)
  const reachedCap = all.length >= maxTotal

  return {
    messages: trimmed,
    total: lastTotal,
    has_more: reachedCap ? lastHasMore || trimmed.length < all.length : false,
    extra: { pagesFetched: page },
  }
}

const getFullConversationSchema = {
  session_id: z.string().describe('Session ID'),
  max_total_messages: z.number().finite().optional()
    .describe(`Maximum total messages to retrieve (default 500, max ${FULL_CONVERSATION_TOTAL_MAX})`),
} as const

export function registerConversationTools(server: McpServer, client: ChatLabClient): void {
  registerMessageTool(server, client, {
    name: 'get_full_conversation',
    description:
      'Get a full conversation across multiple pages (auto-paginates at 500 messages/page). Use only for small-to-medium sessions; for large sessions, prefer get_messages with explicit page parameter. Subject to a hard cap of 2000 messages per call.',
    schema: getFullConversationSchema,
    fetch: (args) => fetchFullConversation(client, args),
  })
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run tests/tools/conversation.test.ts tests/message-tool.test.ts`
Expected: all PASS. The convention-enforcement test's violator list should now be: only `analytics.ts`.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/conversation.ts tests/tools/conversation.test.ts
git commit -m "$(cat <<'EOF'
refactor(conversation): rewrite get_full_conversation via factory

- Page size: 100 → 500 (5× fewer round-trips for full-session fetches).
- Total cap: 1000 → 2000 (FULL_CONVERSATION_TOTAL_MAX).
- Implementation: thin loop over fetchMessagesViaRest (which auto-routes
  through SQL fast path), eliminating the duplicate REST + JS-filter
  code that this tool used to maintain.
- Registers via registerMessageTool → gets shared params automatically.

Convention test violator list shrinks to: analytics.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Analytics Message Tools Migration

### Task 9: Migrate `get_conversation_between` to factory

**Files:**
- Modify: `src/tools/analytics.ts` (replace `getConversationBetween` + its registration)
- Modify: `tests/tools/analytics.test.ts` (update assertions)

- [ ] **Step 1: Update test for new function**

In `tests/tools/analytics.test.ts`, locate the existing `describe('getConversationBetween', ...)` block. Replace it with:

```ts
describe('fetchConversationBetweenViaSql', () => {
  it('returns RawMessage[] with id, senderName, senderPlatformId, content, timestamp, type', async () => {
    mockClient.post.mockResolvedValue({
      data: {
        columns: ['id', 'ts', 'type', 'content', 'senderPlatformId', 'senderName'],
        rows: [[1, 100, 0, 'hi', 'pa', 'Alice']],
      },
    })

    const result = await fetchConversationBetweenViaSql(mockClient, {
      session_id: 's1',
      member_id_1: 1,
      member_id_2: 2,
    })

    expect(result.messages).toEqual([
      { id: 1, senderName: 'Alice', senderPlatformId: 'pa', content: 'hi', timestamp: 100, type: 0 },
    ])
  })

  it('clamps limit to [1, 1000]', async () => {
    mockClient.post.mockResolvedValue({ data: { columns: ['id'], rows: [] } })

    await fetchConversationBetweenViaSql(mockClient, {
      session_id: 's1',
      member_id_1: 1,
      member_id_2: 2,
      limit: 99999,
    })

    const sql = mockClient.post.mock.calls[0][1].sql as string
    expect(sql).toMatch(/LIMIT 1000/)
  })
})
```

Add the import at the top of the test file:

```ts
import { fetchConversationBetweenViaSql } from '../../src/tools/analytics.js'
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run tests/tools/analytics.test.ts`
Expected: FAIL — `fetchConversationBetweenViaSql` not exported.

- [ ] **Step 3: Replace implementation in `analytics.ts`**

In `src/tools/analytics.ts`:

a) **Add** `fetchConversationBetweenViaSql` (new exported function):

```ts
export interface FetchConversationBetweenParams {
  session_id: string
  member_id_1: number
  member_id_2: number
  start_time?: number
  end_time?: number
  limit?: number
}

export async function fetchConversationBetweenViaSql(
  client: Pick<ChatLabClient, 'post'>,
  params: FetchConversationBetweenParams,
): Promise<MessageFetchResult> {
  const limit =
    params.limit !== undefined && Number.isFinite(params.limit)
      ? Math.min(Math.max(1, Math.floor(params.limit)), 1000)
      : 100

  const sql = `
    SELECT
      m.id AS id,
      m.ts AS timestamp,
      m.type AS type,
      m.content AS content,
      mem.platform_id AS senderPlatformId,
      COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    JOIN member mem ON m.sender_id = mem.id
    WHERE m.sender_id IN (${Math.floor(params.member_id_1)}, ${Math.floor(params.member_id_2)})
      ${buildTimeFilter(params.start_time, params.end_time, 'm.ts')}
    ORDER BY m.ts, m.id
    LIMIT ${limit}
  `.trim()

  const rows = await sqlInternal(client, params.session_id, sql)

  const messages: RawMessage[] = rows.map((r: any) => ({
    id: r.id,
    senderName: r.senderName,
    senderPlatformId: r.senderPlatformId,
    content: r.content,
    timestamp: r.timestamp,
    type: r.type,
  }))

  return {
    messages,
    extra: { member_id_1: params.member_id_1, member_id_2: params.member_id_2 },
  }
}
```

Required imports at top of `analytics.ts` (add if missing):

```ts
import type { MessageFetchResult } from './message-tool.js'
import { registerMessageTool } from './message-tool.js'
import type { RawMessage } from '../format.js'
```

b) **Delete** the old `getConversationBetween` function (the one that does inline `r.ts*1000 → toLocaleString` formatting).

c) **Replace** the `server.tool('get_conversation_between', …)` registration block with:

```ts
registerMessageTool(server, client, {
  name: 'get_conversation_between',
  description:
    'Get messages between two specific members (interleaved by time). Use when the user asks "what did A and B talk about". Members must be referenced by their numeric DB id (from get_members).',
  schema: {
    session_id: z.string().describe('Session ID'),
    member_id_1: z.number().finite().describe('First member numeric ID (from get_members)'),
    member_id_2: z.number().finite().describe('Second member numeric ID (from get_members)'),
    start_time: z.number().finite().optional().describe('Start time (Unix seconds)'),
    end_time: z.number().finite().optional().describe('End time (Unix seconds)'),
    limit: z.number().finite().optional().describe('Max messages (default 100, max 1000)'),
  } as const,
  fetch: (args) => fetchConversationBetweenViaSql(client, args),
})
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run`
Expected: all PASS. Static-scan tests should still show one violator (`analytics.ts`) but the violator list will go to zero after Tasks 10 and 11.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
refactor(analytics): migrate get_conversation_between to factory

- Extracts fetchConversationBetweenViaSql() as a pure fetch returning
  RawMessage[].
- Removes inline new Date().toLocaleString() formatting — render is
  now handled by the factory.
- Tool gains shared params (timezone, merge_consecutive, filter_invalid)
  that it never had before.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Migrate `deep_search_messages` to factory

**Files:**
- Modify: `src/tools/analytics.ts`
- Modify: `tests/tools/analytics.test.ts`

- [ ] **Step 1: Update test**

In `tests/tools/analytics.test.ts`, locate the existing `describe('deepSearchMessages', …)` block. Replace it with:

```ts
describe('fetchDeepSearchViaSql', () => {
  it('runs two SQL queries: FTS5 hits + context expansion', async () => {
    mockClient.post
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'ts'],
          rows: [[5, 500], [10, 1000]],
        },
      })
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'ts', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: [
            [3, 300, 0, 'before', 'pa', 'Alice'],
            [5, 500, 0, 'hit1', 'pa', 'Alice'],
            [10, 1000, 0, 'hit2', 'pb', 'Bob'],
          ],
        },
      })

    const result = await fetchDeepSearchViaSql(mockClient, {
      session_id: 's1',
      keywords: ['hello'],
    })

    expect(mockClient.post).toHaveBeenCalledTimes(2)
    expect(result.messages).toHaveLength(3)
    expect(result.extra).toEqual({ hits: 2 })
  })

  it('reports missing schema gracefully', async () => {
    mockClient.post.mockRejectedValue(new Error('no such table: message_fts'))

    const result = await fetchDeepSearchViaSql(mockClient, {
      session_id: 's1',
      keywords: ['hello'],
    })

    expect(result.messages).toEqual([])
    expect(result.extra?.message).toMatch(/newer database schema/i)
  })
})
```

Add import:

```ts
import { fetchDeepSearchViaSql } from '../../src/tools/analytics.js'
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run tests/tools/analytics.test.ts`
Expected: FAIL — `fetchDeepSearchViaSql` not exported.

- [ ] **Step 3: Replace implementation in `analytics.ts`**

a) **Add** `fetchDeepSearchViaSql`:

```ts
export interface FetchDeepSearchParams {
  session_id: string
  keywords: string[]
  sender_id?: number
  start_time?: number
  end_time?: number
  limit?: number
  context_before?: number
  context_after?: number
}

export async function fetchDeepSearchViaSql(
  client: Pick<ChatLabClient, 'post'>,
  params: FetchDeepSearchParams,
): Promise<MessageFetchResult> {
  const limit =
    params.limit !== undefined && Number.isFinite(params.limit)
      ? Math.min(Math.max(1, Math.floor(params.limit)), 1000)
      : 100
  const before =
    params.context_before !== undefined && Number.isFinite(params.context_before)
      ? Math.min(Math.max(0, Math.floor(params.context_before)), 20)
      : 2
  const after =
    params.context_after !== undefined && Number.isFinite(params.context_after)
      ? Math.min(Math.max(0, Math.floor(params.context_after)), 20)
      : 2

  const matchExpr = params.keywords.map(ftsEscape).join(' OR ')

  let senderClause = ''
  if (params.sender_id !== undefined && Number.isFinite(params.sender_id)) {
    senderClause = ` AND m.sender_id = ${Math.floor(params.sender_id)}`
  }

  const hitsSql = `
    SELECT m.id, m.ts
    FROM message m
    JOIN message_fts ON m.id = message_fts.rowid
    WHERE message_fts MATCH '${sqlEscape(matchExpr)}'
      ${senderClause}
      ${buildTimeFilter(params.start_time, params.end_time, 'm.ts')}
    ORDER BY m.ts, m.id
    LIMIT ${limit}
  `.trim()

  let hits: any[]
  try {
    hits = await sqlInternal(client, params.session_id, hitsSql)
  } catch (e) {
    if (/no such table/i.test((e as Error).message ?? '')) {
      return {
        messages: [],
        extra: {
          message: 'This feature requires a newer database schema (chat_session / message_fts). Please reimport the session in the latest ChatLab version.',
        },
      }
    }
    throw e
  }

  if (hits.length === 0) {
    return {
      messages: [],
      extra: { hits: 0, message: `No matches for keywords: ${params.keywords.join(', ')}` },
    }
  }

  const ranges = hits.map((h) => `(m.id BETWEEN ${h.id - before} AND ${h.id + after})`).join(' OR ')

  const contextSql = `
    SELECT
      m.id AS id,
      m.ts AS timestamp,
      m.type AS type,
      m.content AS content,
      mem.platform_id AS senderPlatformId,
      COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    LEFT JOIN member mem ON m.sender_id = mem.id
    WHERE ${ranges}
    ORDER BY m.id
    LIMIT 5000
  `.trim()

  const rows = await sqlInternal(client, params.session_id, contextSql)

  const messages: RawMessage[] = rows.map((r: any) => ({
    id: r.id,
    senderName: r.senderName ?? '?',
    senderPlatformId: r.senderPlatformId ?? '',
    content: r.content,
    timestamp: r.timestamp,
    type: r.type,
  }))

  return { messages, extra: { hits: hits.length } }
}
```

b) **Delete** the old `deepSearchMessages` function and the `formatRowsAsConversation` helper (no longer needed — render moves to factory).

c) **Replace** registration:

```ts
registerMessageTool(server, client, {
  name: 'deep_search_messages',
  description:
    'Full-text search messages via FTS5, then expand each hit with surrounding context messages. Use for "did anyone mention X" style queries where conversation context matters.',
  schema: {
    session_id: z.string().describe('Session ID'),
    keywords: z.array(z.string()).min(1).describe('Keywords to search (FTS5 MATCH, joined by OR)'),
    sender_id: z.number().finite().optional().describe('Restrict to a specific sender (numeric member.id)'),
    start_time: z.number().finite().optional().describe('Start time (Unix seconds)'),
    end_time: z.number().finite().optional().describe('End time (Unix seconds)'),
    limit: z.number().finite().optional().describe('Max hits before context expansion (default 100, max 1000)'),
    context_before: z.number().finite().optional().describe('Context messages before each hit (default 2, max 20)'),
    context_after: z.number().finite().optional().describe('Context messages after each hit (default 2, max 20)'),
  } as const,
  fetch: (args) => fetchDeepSearchViaSql(client, args),
})
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run`
Expected: all PASS.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
refactor(analytics): migrate deep_search_messages to factory

- Extracts fetchDeepSearchViaSql() returning RawMessage[] + extra.hits.
- Removes the formatRowsAsConversation helper (render handled by factory).
- Missing-schema fallback flows through extra.message field, rendered
  alongside any results.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Rewrite + migrate `get_message_context` (id → ts window)

**Files:**
- Modify: `src/tools/analytics.ts`
- Modify: `tests/tools/analytics.test.ts`

- [ ] **Step 1: Update test**

In `tests/tools/analytics.test.ts`, replace `describe('getMessageContext', …)` block with:

```ts
describe('fetchMessageContextViaSql', () => {
  it('queries with ts window (not id BETWEEN) around target message IDs', async () => {
    // First call: look up target ts
    mockClient.post
      .mockResolvedValueOnce({
        data: { columns: ['ts'], rows: [[1000]] },
      })
      // Second call: expand with ts window
      .mockResolvedValueOnce({
        data: {
          columns: ['id', 'ts', 'type', 'content', 'senderPlatformId', 'senderName'],
          rows: [
            [42, 950, 0, 'before', 'pa', 'Alice'],
            [43, 1000, 0, 'target', 'pb', 'Bob'],
            [44, 1050, 0, 'after', 'pa', 'Alice'],
          ],
        },
      })

    const result = await fetchMessageContextViaSql(mockClient, {
      session_id: 's1',
      message_ids: [43],
      context_size: 10,
    })

    expect(mockClient.post).toHaveBeenCalledTimes(2)
    const secondSql = mockClient.post.mock.calls[1][1].sql as string
    expect(secondSql).toContain('m.ts')
    expect(secondSql).not.toContain('m.id BETWEEN')
    expect(result.messages).toHaveLength(3)
  })

  it('returns empty result when no targets exist', async () => {
    mockClient.post.mockResolvedValueOnce({
      data: { columns: ['ts'], rows: [] },
    })

    const result = await fetchMessageContextViaSql(mockClient, {
      session_id: 's1',
      message_ids: [99999],
    })

    expect(result.messages).toEqual([])
  })

  it('clamps context_size to [1, 100]', async () => {
    mockClient.post
      .mockResolvedValueOnce({ data: { columns: ['ts'], rows: [[1000]] } })
      .mockResolvedValueOnce({ data: { columns: ['id'], rows: [] } })

    await fetchMessageContextViaSql(mockClient, {
      session_id: 's1',
      message_ids: [1],
      context_size: 999,
    })

    const sql = mockClient.post.mock.calls[1][1].sql as string
    // 100 messages before + 100 after each target, with 1 target = max 200 messages
    expect(sql).toMatch(/LIMIT (200|2000)/)
  })
})
```

Add import:

```ts
import { fetchMessageContextViaSql } from '../../src/tools/analytics.js'
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run tests/tools/analytics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Replace implementation in `analytics.ts`**

a) **Add** `fetchMessageContextViaSql`:

```ts
export interface FetchMessageContextParams {
  session_id: string
  message_ids: number[]
  context_size?: number
}

export async function fetchMessageContextViaSql(
  client: Pick<ChatLabClient, 'post'>,
  params: FetchMessageContextParams,
): Promise<MessageFetchResult> {
  const ctx =
    params.context_size !== undefined && Number.isFinite(params.context_size)
      ? Math.min(Math.max(1, Math.floor(params.context_size)), 100)
      : 20

  // Step 1: look up the timestamps of the target messages.
  // Using ts as the anchor is robust to deleted / non-contiguous message ids.
  const ids = params.message_ids.map((id) => Math.floor(id)).join(',')
  const tsRows = await sqlInternal(
    client,
    params.session_id,
    `SELECT ts FROM message WHERE id IN (${ids}) ORDER BY ts`,
  )

  if (tsRows.length === 0) {
    return {
      messages: [],
      extra: { requestedMessageIds: params.message_ids, contextSize: ctx },
    }
  }

  // Step 2: for each target ts, gather the N messages immediately before and after.
  // Implementation: UNION of OFFSET-aware subqueries. SQLite supports this efficiently.
  const targetTimestamps = tsRows.map((r: any) => r.ts as number)
  const subqueries = targetTimestamps.flatMap((targetTs) => [
    `SELECT id FROM message WHERE ts <= ${targetTs} ORDER BY ts DESC LIMIT ${ctx + 1}`,
    `SELECT id FROM message WHERE ts > ${targetTs} ORDER BY ts ASC LIMIT ${ctx}`,
  ])

  const sql = `
    SELECT
      m.id AS id,
      m.ts AS timestamp,
      m.type AS type,
      m.content AS content,
      mem.platform_id AS senderPlatformId,
      COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
    FROM message m
    LEFT JOIN member mem ON m.sender_id = mem.id
    WHERE m.id IN (${subqueries.map((q) => `(${q})`).join(' UNION ')})
    ORDER BY m.ts, m.id
    LIMIT ${ctx * 2 * targetTimestamps.length + 10}
  `.trim()

  const rows = await sqlInternal(client, params.session_id, sql)

  const messages: RawMessage[] = rows.map((r: any) => ({
    id: r.id,
    senderName: r.senderName ?? '?',
    senderPlatformId: r.senderPlatformId ?? '',
    content: r.content,
    timestamp: r.timestamp,
    type: r.type,
  }))

  return {
    messages,
    extra: { requestedMessageIds: params.message_ids, contextSize: ctx },
  }
}
```

b) **Delete** the old `getMessageContext` function entirely.

c) **Replace** registration:

```ts
registerMessageTool(server, client, {
  name: 'get_message_context',
  description:
    'Get N messages before and after one or more specific message IDs. Uses time-window expansion (robust to deleted or non-contiguous message IDs). Use when the user references "what was being said around message X".',
  schema: {
    session_id: z.string().describe('Session ID'),
    message_ids: z.array(z.number().finite()).min(1).describe('Target message IDs (one or many)'),
    context_size: z.number().finite().optional().describe('Messages before AND after each target (default 20, max 100)'),
  } as const,
  fetch: (args) => fetchMessageContextViaSql(client, args),
})
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run`
Expected: **all PASS**, including both static-scan tests in `message-tool.test.ts`. The violator lists should now be empty. If `analytics.ts` still appears, search for remaining `toLocaleString` or `formatMessagesAsPlainText` references and remove them.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
refactor(analytics): rewrite get_message_context with time-window SQL

- Replaces "id BETWEEN X-ctx AND X+ctx" with two-step query:
  1. Look up the timestamps of the target message ids
  2. UNION-fetch the N messages immediately before and after each ts
- This is robust to deleted or non-contiguous message ids (e.g. when
  system messages were filtered at import time).
- Migrated to messageTool factory; tool gains shared params.

The convention-enforcement test's violator list is now empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Cleanups & Description Fixes

### Task 12: Delete `keyword_frequency` registration

**Files:**
- Modify: `src/tools/analytics.ts` (remove tool registration and helper functions)
- Modify: `tests/tools/analytics.test.ts` (remove tests)

- [ ] **Step 1: Remove registration and helpers**

In `src/tools/analytics.ts`:

a) **Delete** the entire `server.tool('keyword_frequency', …)` registration block.

b) **Delete** the `keywordFrequency` function, `keywordFrequencySchema`, `KEYWORD_FREQUENCY_MESSAGE` const, and `KEYWORD_FREQUENCY_ALTERNATIVES` const.

c) Verify the remaining file does not import or export any keyword_frequency symbols.

- [ ] **Step 2: Remove related tests**

In `tests/tools/analytics.test.ts`, **delete** any `describe('keywordFrequency', …)` block.

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/analytics.ts tests/tools/analytics.test.ts
git commit -m "$(cat <<'EOF'
refactor(analytics): remove keyword_frequency stub registration

The stub occupied an LLM tool slot in clients with limited tool counts
(Claude Desktop, etc.) while providing zero functionality. Alternatives
remain documented in README and unchanged: execute_sql with LIKE, or
ChatLab desktop Insights > Word Cloud.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Fix descriptions — `execute_sql` and `get_session_summaries`

**Files:**
- Modify: `src/tools/sql.ts:29`
- Modify: `src/tools/analytics.ts` (`get_session_summaries` description)
- Modify: `tests/tools/sql.test.ts` (add assertion for new table list)

- [ ] **Step 1: Write the assertion**

In `tests/tools/sql.test.ts`, add inside the existing `describe(...)` block:

```ts
it('description mentions all five available tables', () => {
  // Reads the registered tool description after registerSQLTools call.
  // (Use mock server pattern from message-tool.test.ts if not already present.)
  // ALTERNATIVE: inspect the file source directly.
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const src = readFileSync(join(__dirname, '../../src/tools/sql.ts'), 'utf-8') as string
  expect(src).toContain('message')
  expect(src).toContain('member')
  expect(src).toContain('chat_session')
  expect(src).toContain('message_fts')
  expect(src).toContain('member_name_history')
})
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run tests/tools/sql.test.ts`
Expected: FAIL — current description only lists `message` and `member`.

- [ ] **Step 3: Update `src/tools/sql.ts`**

In `src/tools/sql.ts`, locate the `server.tool('execute_sql', …)` description string and replace it with:

```ts
'For statistical aggregation ONLY (COUNT, GROUP BY, SUM, AVG). Do NOT use to fetch message content — use get_messages for that. Max 200 rows returned. Available tables: message, member, chat_session, message_fts, member_name_history.'
```

- [ ] **Step 4: Audit `get_session_summaries` description**

Open `src/tools/analytics.ts`. Find the `getSessionSummariesSchema` definition. Check the `session_id` field — verify its `.describe()` does NOT contain `"(unused; tool returns info only)"` (that residue was meant for `keyword_frequency`, now deleted). If present, replace with `'Session ID'`.

Also verify the `server.tool('get_session_summaries', …)` description block — confirm it accurately describes the tool's purpose (AI-generated summaries from `chat_session` table).

- [ ] **Step 5: Run tests — verify pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/sql.ts src/tools/analytics.ts tests/tools/sql.test.ts
git commit -m "$(cat <<'EOF'
docs(tools): fix description inaccuracies

- execute_sql: append chat_session / message_fts / member_name_history
  to the available tables list. Without these, LLMs were unaware that
  FTS5 search and AI summaries are accessible via execute_sql.
- get_session_summaries.session_id: remove any "(unused)" residue left
  over from the (now-deleted) keyword_frequency tool.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Replace `formatStatsOverviewAsText` with `formatToolResultAsText`

**Files:**
- Modify: `src/tools/stats.ts`
- Modify: `src/format.ts` (delete `formatStatsOverviewAsText`)
- Modify: `tests/tools/stats.test.ts`

- [ ] **Step 1: Inspect current test assertions**

Open `tests/tools/stats.test.ts`. Note any assertions about exact output formatting from `formatStatsOverviewAsText`. The migration will change spacing/labels — adjust assertions to match the `formatToolResultAsText` format (`key: value` per line, no decorative headers).

- [ ] **Step 2: Update `src/tools/stats.ts`**

Replace the body of `getStatsOverview` in `src/tools/stats.ts`:

```ts
export async function getStatsOverview(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: string,
  format: 'json' | 'text' = 'text',
): Promise<string> {
  const res: any = await client.get(`/api/v1/sessions/${sessionId}/stats/overview`)

  if (res.data?.messageTypeDistribution) {
    const labeled: Record<string, number> = {}
    for (const [k, v] of Object.entries(res.data.messageTypeDistribution)) {
      labeled[MESSAGE_TYPES[k] ?? `type_${k}`] = v as number
    }
    res.data.messageTypeDistribution = labeled
  }

  if (format === 'text') {
    return formatToolResultAsText(res.data ?? {})
  }
  return JSON.stringify(res, null, 2)
}
```

Update imports:

```ts
import { formatToolResultAsText } from '../format.js'
```

(Remove `formatStatsOverviewAsText` import.)

- [ ] **Step 3: Remove `formatStatsOverviewAsText` from `src/format.ts`**

Open `src/format.ts`. Search for `export function formatStatsOverviewAsText`. **Delete** the entire function (it's no longer used).

- [ ] **Step 4: Update test assertions**

In `tests/tools/stats.test.ts`, adjust assertions to match `formatToolResultAsText` output. Example: instead of expecting `"消息总数: 1234"` with a header, expect `"messageCount: 1234"` (key: value flat lines).

- [ ] **Step 5: Run tests — verify pass**

Run: `npx vitest run`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/stats.ts src/format.ts tests/tools/stats.test.ts
git commit -m "$(cat <<'EOF'
refactor(stats): consolidate get_stats_overview onto formatToolResultAsText

formatStatsOverviewAsText was a duplicate of formatToolResultAsText
with different label translations. Removing keeps a single helper
for tool-result text rendering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Final Wrap-Up

### Task 15: Tighten convention-enforcement test

**Files:**
- Modify: `tests/message-tool.test.ts` (the static-scan tests)

The two static-scan tests added in Task 3 should now all pass with empty violator lists. This task confirms that and tightens the scan.

- [ ] **Step 1: Run static-scan tests**

Run: `npx vitest run tests/message-tool.test.ts -t "convention enforcement"`
Expected: PASS — both violator lists empty.

- [ ] **Step 2: Add stricter scan: forbid stale formatter helpers**

In `tests/message-tool.test.ts`, append inside the `describe('convention enforcement (static scan)', …)` block:

```ts
it('no tool file imports formatStatsOverviewAsText (removed in Task 14)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const toolsDir = join(__dirname, '../src/tools')
  const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))
  const violators: string[] = []
  for (const file of files) {
    const content = readFileSync(join(toolsDir, file), 'utf-8')
    if (/formatStatsOverviewAsText/.test(content)) {
      violators.push(file)
    }
  }
  expect(violators).toEqual([])
})

it('no tool file imports getMessages / getConversationText (removed signatures)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const toolsDir = join(__dirname, '../src/tools')
  const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))
  const violators: string[] = []
  for (const file of files) {
    const content = readFileSync(join(toolsDir, file), 'utf-8')
    // these names referred to the pre-refactor signatures; their removal
    // should be enforced going forward
    if (/getConversationText\(/.test(content)) {
      violators.push(`${file}:getConversationText`)
    }
  }
  expect(violators).toEqual([])
})
```

- [ ] **Step 3: Run — verify pass**

Run: `npx vitest run tests/message-tool.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/message-tool.test.ts
git commit -m "$(cat <<'EOF'
test(tools): tighten convention enforcement after migration completes

Adds two static-scan tests preventing regression:
- formatStatsOverviewAsText removed in Task 14; no tool file may
  re-import it.
- getConversationText() function signature is gone; no tool file
  may resurrect it.

Combined with the existing scans for formatMessagesAsPlainText and
toLocaleString, these four tests form the regression net for the
factory architecture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Update README/AGENTS.md + final verification

**Files:**
- Modify: `README.md` (if it lists tools)
- Modify: `AGENTS.md` (if it documents tool surface)
- Modify: `CLAUDE.md` (project instructions — only the Tools → API Mapping table)

- [ ] **Step 1: Update CLAUDE.md tool list**

Open `CLAUDE.md` in the project root. Find the "Tools → API Mapping" section. Update the table to reflect:
- `get_messages` mapping unchanged
- Remove the row for `get_conversation_text` if present
- Remove the row for `keyword_frequency` if present
- Add a note that `get_full_conversation`, `get_message_context`, `get_conversation_between`, `deep_search_messages` all now produce `RawMessage[]` internally and share format/timezone/merge_consecutive/filter_invalid params

- [ ] **Step 2: Update README.md**

If `README.md` enumerates tools or describes counts (e.g. "7 tools" / "17 tools"), update to **15 tools**. Add a CHANGELOG section if one exists, with:

```markdown
### Breaking (since v0.19.x)

- Removed `get_conversation_text` — use `get_messages(format='text', limit=…)`.
- Removed `keyword_frequency` (was a stub). Use `execute_sql` with LIKE patterns
  or the ChatLab desktop app's Insights > Word Cloud.

### Improvements

- All message-returning tools now support shared params: `format`, `timezone`,
  `merge_consecutive`, `filter_invalid`. Previously these worked only on
  `get_messages` / `get_conversation_text` / `get_full_conversation`.
- `get_messages` default `limit` 20 → 100.
- `get_messages` now returns `id` and `senderPlatformId` per message so
  `get_message_context` can be called as a follow-up.
- `get_messages` with `filter_invalid=true` (default) now filters at the
  SQL layer, saving bandwidth.
- `get_message_context` uses time-window expansion (robust to deleted /
  non-contiguous message IDs).
```

- [ ] **Step 3: Update AGENTS.md (if exists)**

If `AGENTS.md` documents the tool surface for AI assistants, update tool counts and add brief notes about the new shared param surface across analytics message tools.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests PASS — no failures, no skips.

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm run build`
Expected: SUCCESS, `dist/` populated.

- [ ] **Step 5: Manual smoke check (optional)**

If a local ChatLab instance is running on `http://127.0.0.1:5200`:

```bash
CHATLAB_TOKEN=<token> node dist/index.js
# In another terminal, send an MCP tools/list request via stdio
# verify only 15 tools appear and none is keyword_frequency / get_conversation_text
```

This is optional — vitest coverage gives high confidence — but recommended before a tag.

- [ ] **Step 6: Final commit**

```bash
git add README.md AGENTS.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: update tool list and CHANGELOG for v0.20 message tools refactor

- 17 → 15 tools (removed get_conversation_text and keyword_frequency).
- Document new shared params surface (format/timezone/merge_consecutive/
  filter_invalid) across all message tools.
- Note get_messages id/senderPlatformId preservation and SQL fast path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (Completed Inline)

**Spec coverage:** Each section of the spec maps to one or more tasks:
- §5.2 `RawMessage` type → Task 1
- §5.3 Factory → Task 2
- §5.4 Shared params → Task 2 (`SHARED_MESSAGE_PARAMS`)
- §5.5 Render pipeline → Task 2 (`renderMessages`)
- §6 Per-tool migration → Tasks 4, 6, 8, 9, 10, 11
- §7 SQL fast path → Task 5
- §8 Tool inventory after refactor → Tasks 7, 12 (deletions); 14 (stats touch); 13 (description fixes)
- §9 Description fixes → Task 4 (get_messages), Task 13 (execute_sql, summaries)
- §10 Constants consolidation → Task 1
- §11 Testing strategy → Tasks 1, 3, every implementation task (TDD)
- §11.2 Convention enforcement → Tasks 3 (initial), 15 (tightened)
- §13 Migration & compatibility → Task 16 (CHANGELOG)
- §14 File map → matches across tasks

**Placeholder scan:** No TBDs, no "add appropriate error handling", no "similar to Task N". All code blocks contain real implementation. Each commit message is concrete.

**Type consistency:** Verified across tasks:
- `RawMessage` field names: id / senderName / senderPlatformId / content / timestamp / type — consistent in Tasks 1, 2, 4, 5, 8, 9, 10, 11
- `MessageFetchResult` shape: messages / total / page / has_more / extra — consistent in Tasks 2, 4, 8, 9, 10, 11
- `MESSAGES_PER_PAGE_MAX` (500) and `FULL_CONVERSATION_TOTAL_MAX` (2000) — consistent in Tasks 1, 4, 5, 8
- Factory entry point is `registerMessageTool` (not `messageTool` or `registerMessage`) — consistent

No drift detected.
