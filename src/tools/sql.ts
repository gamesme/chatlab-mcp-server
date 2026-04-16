import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatLabClient } from '../client.js'
import { toolError } from './utils.js'

const SQL_ROW_LIMIT = 200

function injectLimit(query: string): string {
  const upper = query.trim().toUpperCase()
  if (/\bLIMIT\b/.test(upper)) return query
  return `${query.trimEnd()} LIMIT ${SQL_ROW_LIMIT}`
}

export async function executeSQL(
  client: Pick<ChatLabClient, 'post'>,
  sessionId: string,
  query: string
): Promise<string> {
  if (!query.trim().toUpperCase().startsWith('SELECT')) {
    throw new Error('Only SELECT queries are allowed.')
  }
  const result = await client.post(`/api/v1/sessions/${sessionId}/sql`, { sql: injectLimit(query) })
  return JSON.stringify(result, null, 2)
}

export function registerSQLTools(server: McpServer, client: ChatLabClient): void {
  server.tool(
    'execute_sql',
    'For statistical aggregation ONLY (COUNT, GROUP BY, SUM, AVG). Do NOT use to fetch message content — use get_messages for that. Max 200 rows returned. Available tables: message, member.',
    {
      session_id: z.string().describe('Session ID'),
      query: z.string().describe('SQL SELECT query — aggregations only, e.g. COUNT/GROUP BY'),
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
