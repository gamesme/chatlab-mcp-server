import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

export async function executeSQL(
  client: Pick<ChatLabClient, 'post'>,
  sessionId: string,
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
      session_id: z.string().describe('Session ID'),
      query: z.string().describe('SQL SELECT query to execute'),
    },
    async ({ session_id, query }) => {
      try {
        const text = await executeSQL(client, session_id, query)
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return toolError(e, session_id)
      }
    }
  )
}
