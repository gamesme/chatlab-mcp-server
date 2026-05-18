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
