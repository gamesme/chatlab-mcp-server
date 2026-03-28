# chatlab-mcp

MCP server for querying ChatLab chat history from AI assistants (Claude Desktop, Cursor, custom agents).

## Setup

```bash
git clone <repo>
cd chatlab-mcp
npm install
npm run build
```

## Configuration

```bash
# via environment variable (recommended)
export CHATLAB_TOKEN=clb_xxxxxxxxxxxx

# via CLI flags (override env vars)
node dist/index.js --token clb_xxxxxxxxxxxx --url http://127.0.0.1:5200
```

`CHATLAB_URL` defaults to `http://127.0.0.1:5200`.

## Claude Desktop Integration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chatlab": {
      "command": "node",
      "args": ["/absolute/path/to/chatlab-mcp/dist/index.js"],
      "env": {
        "CHATLAB_URL": "http://127.0.0.1:5200",
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_sessions` | List all imported chat sessions |
| `get_session` | Get full details of one session by ID |
| `get_messages` | Retrieve messages with keyword/date/sender filters |
| `get_members` | List all members in a session |
| `get_stats_overview` | Statistical overview (message counts, active members) |
| `execute_sql` | Run a read-only SELECT query against the session DB |
| `export_session` | Export full session as ChatLab Format JSON (up to 100k messages) |

## Development

```bash
npm test            # run all tests
npm run test:watch  # watch mode
npm run dev         # run without compiling (requires CHATLAB_TOKEN env var)
```
