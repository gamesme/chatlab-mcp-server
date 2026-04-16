import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'
import {
  formatMessagesAsPlainText,
  formatToolResultAsText,
} from '../format.js'

const MAX_LIMIT = 100

const getMessagesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  keyword: z.string().optional().describe('Substring search'),
  start_time: z.number().optional().describe('Start time as Unix timestamp (seconds)'),
  end_time: z.number().optional().describe('End time as Unix timestamp (seconds)'),
  sender_id: z.string().optional().describe('Filter by member platformId'),
  type: z.number().optional().describe('Filter by message type number'),
  page: z.number().optional().describe('Page number (default: 1)'),
  limit: z.number().optional().describe(`Messages per page, max ${MAX_LIMIT} (default: 20). Use pagination to retrieve more.`),
  format: z.enum(['json', 'text']).optional().describe('Output format: text (default, compact to save tokens) or json'),
  merge_consecutive: z.boolean().optional().describe('Merge consecutive messages from same sender (text format only, default: true)'),
  filter_invalid: z.boolean().optional().describe('Filter meaningless messages like stickers, system messages (text format only, default: true)'),
})

type GetMessagesParams = z.infer<typeof getMessagesSchema>

export async function getMessages(
  client: Pick<ChatLabClient, 'get'>,
  params: GetMessagesParams
): Promise<string> {
  const { session_id, format = 'text', merge_consecutive, filter_invalid, ...filters } = params
  const query: Record<string, string> = {}
  if (filters.keyword !== undefined) query.keyword = filters.keyword
  if (filters.start_time !== undefined) query.startTime = String(filters.start_time)
  if (filters.end_time !== undefined) query.endTime = String(filters.end_time)
  if (filters.sender_id !== undefined) query.sender_id = filters.sender_id
  if (filters.type !== undefined) query.type = String(filters.type)
  if (filters.page !== undefined) query.page = String(filters.page)
  query.limit = String(Math.min(filters.limit ?? 20, MAX_LIMIT))

  const result: any = await client.get(`/api/v1/sessions/${session_id}/messages`, query)

  if (result.data?.messages) {
    const { total, page: p = 1, messages } = result.data

    // 处理消息数据并按时间升序排序（API 返回降序）
    const processedMessages = messages
      .map(({ senderAvatar, senderAliases, senderId, senderPlatformId, id, replyToMessageId, ...msg }: any) => msg)
      .sort((a: any, b: any) => a.timestamp - b.timestamp)

    // text 格式：返回纯文本对话
    if (format === 'text') {
      const formattedMessages = processedMessages.map((m: any) => ({
        senderName: m.senderName,
        content: m.content,
        timestamp: m.timestamp,
      }))

      const plainText = formatMessagesAsPlainText(formattedMessages, {
        mergeConsecutive: merge_consecutive ?? true,
        filterInvalid: filter_invalid ?? true,
      })

      // 构造和主项目类似的 details 结构
      const timeRange = filters.start_time && filters.end_time
        ? { start: new Date(filters.start_time * 1000).toLocaleString('zh-CN'), end: new Date(filters.end_time * 1000).toLocaleString('zh-CN') }
        : undefined

      const details: Record<string, unknown> = {
        total,
        returned: processedMessages.length,
        page: p,
      }

      if (timeRange) {
        details.timeRange = timeRange
      }

      if (plainText) {
        details.messages = plainText.split('\n')
      }

      // 如果有更多页，添加 AI 友好的提示
      if (total !== undefined && processedMessages.length < total) {
        const nextPage = Number(p) + 1
        const remaining = total - processedMessages.length
        details.instruction = `还有 ${remaining} 条消息未显示。调用 get_messages(session_id="${session_id}", page=${nextPage}) 获取下一页`
      }

      return formatToolResultAsText(details)
    }

    // json 格式：返回原始 JSON
    result.data.messages = processedMessages
    if (total !== undefined && messages.length < total) {
      result.data.has_more = true
      result.data.hint = `Showing ${messages.length} of ${total} messages. Use page=${Number(p) + 1} to get the next batch.`
    }
  }

  return JSON.stringify(result, null, 2)
}

export function registerMessagesTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_messages',
    `The primary tool for reading message content. Retrieves up to ${MAX_LIMIT} messages per call with filters for keyword, time range, and sender. Use page to paginate. Returns plain text by default (set format=json for JSON, format=text for compact format). Always prefer this over execute_sql when reading messages.`,
    getMessagesSchema.shape,
    async (args) => {
      try {
        const text = await getMessages(client, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )
}
