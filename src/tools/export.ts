import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function exportSession(
  client: Pick<ChatLabClient, 'get'>,
  sessionId: number
): Promise<string> {
  const data = await client.get(`/api/v1/sessions/${sessionId}/export`)
  return JSON.stringify(data, null, 2)
}

export function registerExportTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'export_session',
    'Exports the full session as ChatLab Format JSON (up to 100k messages). Use for deep analysis with large context windows.',
    { session_id: z.number().describe('Session ID') },
    async ({ session_id }) => {
      try {
        return {
          content: [{ type: 'text' as const, text: await exportSession(client, session_id) }],
        }
      } catch (e) {
        const message =
          e instanceof ChatLabError && e.status === 404
            ? `Session not found: ${session_id}`
            : e instanceof Error
              ? e.message
              : 'Unknown error'
        return { content: [{ type: 'text' as const, text: message }], isError: true as const }
      }
    }
  )
}
