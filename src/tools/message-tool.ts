import { z, type ZodTypeAny } from 'zod'
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
  const mergedSchema: Record<string, ZodTypeAny> = {
    ...def.schema,
    ...SHARED_MESSAGE_PARAMS,
  }

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
