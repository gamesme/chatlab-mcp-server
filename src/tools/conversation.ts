/**
 * 格式化对话工具
 * 提供获取纯文本格式对话的功能，用于节省 token
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'
import { formatMessagesAsPlainText, formatToolResultAsText } from '../format.js'

const MAX_MESSAGES_PER_CALL = 200

export async function getConversationText(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: string,
  options: {
    start_time?: number
    end_time?: number
    sender_id?: string
    max_messages?: number
    merge_consecutive?: boolean
    filter_invalid?: boolean
  }
): Promise<string> {
  const {
    start_time,
    end_time,
    sender_id,
    max_messages = 100,
    merge_consecutive = true,
    filter_invalid = true,
  } = options

  const query: Record<string, string> = {
    limit: String(Math.min(max_messages, MAX_MESSAGES_PER_CALL)),
    page: '1',
  }

  if (start_time !== undefined) query.startTime = String(start_time)
  if (end_time !== undefined) query.endTime = String(end_time)
  if (sender_id !== undefined) query.sender_id = sender_id

  const result: any = await client.get(`/api/v1/sessions/${sessionId}/messages`, query)

  if (!result.data?.messages) {
    return 'No messages found.'
  }

  const messages = result.data.messages
    .map((m: any) => ({
      senderName: m.senderName,
      content: m.content,
      timestamp: m.timestamp,
    }))
    .sort((a: any, b: any) => a.timestamp - b.timestamp)

  const plainText = formatMessagesAsPlainText(messages, {
    mergeConsecutive: merge_consecutive,
    filterInvalid: filter_invalid,
  })

  const time_range = start_time && end_time
    ? { start: new Date(start_time * 1000).toLocaleString('zh-CN'), end: new Date(end_time * 1000).toLocaleString('zh-CN') }
    : undefined

  const details: Record<string, unknown> = {
    total: result.data.total ?? messages.length,
    returned: messages.length,
  }

  if (time_range) {
    details.time_range = time_range
  }

  if (plainText) {
    details.messages = plainText.split('\n')
  }

  // 如果还有更多消息，给 AI 明确的提示
  if (result.data.total && result.data.total > messages.length) {
    const remaining = result.data.total - messages.length
    details.instruction = `还有 ${remaining} 条消息未显示。如需完整对话，请调用 get_full_conversation(session_id="${sessionId}", max_total_messages=${Math.min(remaining, 1000)})`
  }

  return formatToolResultAsText(details)
}

export function registerConversationTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'get_conversation_text',
    'Get conversation in plain text format with filtering and compression. Returns compact text optimized for LLM context (saves tokens vs JSON).',
    {
      session_id: z.string().describe('Session ID'),
      start_time: z.number().optional().describe('Start time as Unix timestamp (seconds)'),
      end_time: z.number().optional().describe('End time as Unix timestamp (seconds)'),
      sender_id: z.string().optional().describe('Filter by member platformId'),
      max_messages: z.number().optional().describe(`Maximum messages to retrieve, max ${MAX_MESSAGES_PER_CALL} (default: 100)`),
      merge_consecutive: z.boolean().optional().describe('Merge consecutive messages from same sender (default: true)'),
      filter_invalid: z.boolean().optional().describe('Filter meaningless messages like stickers, system messages (default: true)'),
    },
    async (args) => {
      try {
        const text = await getConversationText(client, args.session_id, args)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, args.session_id)
      }
    }
  )

  // 批量获取完整对话（处理分页）
  server.tool(
    'get_full_conversation',
    'Get full conversation across multiple pages, returns compact text format. Use for small to medium sessions only.',
    {
      session_id: z.string().describe('Session ID'),
      max_total_messages: z.number().optional().describe('Maximum total messages to retrieve (default: 500)'),
      merge_consecutive: z.boolean().optional().describe('Merge consecutive messages from same sender (default: true)'),
      filter_invalid: z.boolean().optional().describe('Filter meaningless messages (default: true)'),
    },
    async ({ session_id, max_total_messages = 500, merge_consecutive = true, filter_invalid = true }) => {
      try {
        const allMessages: Array<{ senderName: string; content: string | null; timestamp: number }> = []
        let page = 1
        const limit = Math.min(MAX_MESSAGES_PER_CALL, 100)
        const maxTotal = Math.min(max_total_messages, 1000)
        let totalAvailable = 0

        while (allMessages.length < maxTotal) {
          const result: any = await client.get(`/api/v1/sessions/${session_id}/messages`, {
            limit: String(limit),
            page: String(page),
          })

          if (!result.data?.messages || result.data.messages.length === 0) {
            totalAvailable = result.data?.total ?? allMessages.length
            break
          }

          totalAvailable = result.data.total ?? allMessages.length + result.data.messages.length

          allMessages.push(
            ...result.data.messages.map((m: any) => ({
              senderName: m.senderName,
              content: m.content,
              timestamp: m.timestamp,
            }))
          )

          if (result.data.messages.length < limit) {
            break
          }

          page++
        }

        // 按时间戳升序排序（API 返回降序）
        allMessages.sort((a, b) => a.timestamp - b.timestamp)

        const plainText = formatMessagesAsPlainText(allMessages, {
          mergeConsecutive: merge_consecutive,
          filterInvalid: filter_invalid,
        })

        const details: Record<string, unknown> = {
          total: allMessages.length,
          returned: allMessages.length,
          pages_fetched: page,
        }

        if (plainText) {
          details.messages = plainText.split('\n')
        }

        // 如果因为达到限制而停止，给 AI 提示
        if (totalAvailable > allMessages.length) {
          const remaining = totalAvailable - allMessages.length
          details.note = `仅显示了前 ${allMessages.length} 条消息，还有 ${remaining} 条未加载。如需更多，请增大 max_total_messages 参数重新调用`
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: formatToolResultAsText(details),
            },
          ],
        }
      } catch (e) {
        return toolError(e, session_id)
      }
    }
  )
}
