import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient, ChatLabError } from '../client.js'

export async function executeSQL(
  client: Pick<ChatLabClient, 'post'>,
  sessionId: number,
  query: string
): Promise<string> {
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    throw new Error('Only SELECT queries are allowed.')
  }
  const result = await client.post(`/api/v1/sessions/${sessionId}/sql`, { query })
  return JSON.stringify(result, null, 2)
}

export function registerSQLTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'execute_sql',
    'Executes a read-only SELECT query against the session database. Use for analysis not covered by other tools (word frequency, member interactions, activity breakdown).',
    {
      session_id: z.number().describe('Session ID'),
      query: z.string().describe('SQL SELECT query to execute'),
    },
    async ({ session_id, query }) => {
      try {
        const text = await executeSQL(client, session_id, query)
        return { content: [{ type: 'text' as const, text }] }
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
