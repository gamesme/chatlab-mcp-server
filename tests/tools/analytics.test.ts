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
