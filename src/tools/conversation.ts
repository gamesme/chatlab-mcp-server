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

export function registerConversationTools(server: McpServer, client: ChatLabClient): void {
  // 批量获取完整对话（处理分页）
  server.tool(
    'get_full_conversation',
    'Get full conversation across multiple pages, returns compact text format. Use for small to medium sessions only.',
    {
      session_id: z.string().describe('Session ID'),
      max_total_messages: z.number().finite().optional().describe('Maximum total messages to retrieve (default: 500)'),
      merge_consecutive: z.boolean().optional().describe('Merge consecutive messages from same sender (default: true)'),
      filter_invalid: z.boolean().optional().describe('Filter meaningless messages (default: true)'),
    },
    async ({ session_id, max_total_messages = 500, merge_consecutive = true, filter_invalid = true }) => {
      try {
        const allMessages: Array<{ senderName: string; content: string | null; timestamp: number }> = []
        let page = 1
        const limit = Math.min(MAX_MESSAGES_PER_CALL, 100)
        const maxTotal = Math.min(Number.isFinite(max_total_messages) ? max_total_messages : 500, 1000)
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
