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
  filter_invalid?: boolean
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
