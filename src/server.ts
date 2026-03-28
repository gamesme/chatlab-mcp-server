import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ChatLabClient } from './client.js'
import { registerSessionTools } from './tools/sessions.js'
import { registerMessagesTools } from './tools/messages.js'
import { registerMembersTools } from './tools/members.js'
import { registerStatsTools } from './tools/stats.js'
import { registerSQLTools } from './tools/sql.js'
import { registerExportTools } from './tools/export.js'

export function createServer(client: ChatLabClient): McpServer {
  const server = new McpServer({
    name: 'chatlab',
    version: '0.1.0',
  })

  registerSessionTools(server, client)
  registerMessagesTools(server, client)
  registerMembersTools(server, client)
  registerStatsTools(server, client)
  registerSQLTools(server, client)
  registerExportTools(server, client)

  return server
}
