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
  it('merges 4 shared params with the tool-specific schema', () => {
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

  it('calls fetch with all args including shared params and tool-specific params', async () => {
    const { server, registered } = makeMockServer()
    const client: any = {}
    const fetchSpy = vi.fn(async () => ({ messages: [] }))
    registerMessageTool(server, client, {
      name: 'fake_tool',
      description: 'fake',
      schema: { session_id: z.string(), keyword: z.string().optional() },
      fetch: fetchSpy,
    })
    await registered[0].handler({
      session_id: 's1',
      keyword: 'hello',
      format: 'json',
      timezone: 'UTC',
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 's1',
        keyword: 'hello',
        format: 'json',
        timezone: 'UTC',
      }),
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

  it('passes through generic Error message verbatim', async () => {
    const { server, registered } = makeMockServer()
    const client: any = {}
    registerMessageTool(server, client, {
      name: 'fake_tool',
      description: 'fake',
      schema: { session_id: z.string() },
      fetch: async () => {
        throw new Error('Network failure')
      },
    })
    const result = await registered[0].handler({ session_id: 's1' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Network failure')
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
      // Match import declarations (named imports + default + namespace) but skip comments and string literals
      if (/import\s*\{[^}]*\bformatMessagesAsPlainText\b[^}]*\}\s*from/.test(content)) {
        violators.push(file)
      }
    }
    expect(violators, `These tool files call formatMessagesAsPlainText directly. Migrate them to registerMessageTool factory:\n  ${violators.join('\n  ')}`).toEqual([])
  })

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

  it('no tool file imports getConversationText (function removed in Task 7)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const toolsDir = join(__dirname, '../src/tools')
    const files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))
    const violators: string[] = []
    for (const file of files) {
      const content = readFileSync(join(toolsDir, file), 'utf-8')
      if (/getConversationText\(/.test(content)) {
        violators.push(`${file}:getConversationText`)
      }
    }
    expect(violators).toEqual([])
  })

  it('no tool file calls Date.toLocaleString directly outside the allow-list', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const toolsDir = join(__dirname, '../src/tools')
    // ALLOWED files are exempt from this scan because they contain non-message
    // tools (entity-list, name-history, summary tools) that legitimately format
    // their own date strings. Message-returning tools MUST NOT appear here —
    // they go through the messageTool factory which centralizes time formatting.
    //
    // analytics.ts contains getSessionSummaries and getMemberNameHistory which
    // are entity-list tools, not message tools. The message tools formerly in
    // analytics.ts (getMessageContext, getConversationBetween, deepSearchMessages)
    // are migrated to the factory in Tasks 9/10/11 and their inline toLocaleString
    // calls are removed there.
    const ALLOWED = new Set([
      'message-tool.ts',
      'sessions.ts',
      'members.ts',
      'analytics.ts',
    ])
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
