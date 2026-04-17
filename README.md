# chatlab-mcp

**[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)**

MCP server that connects [ChatLab](https://github.com/hellodigua/ChatLab) to AI assistants (Claude Desktop, Cursor, custom agents). Query your local chat history with natural language.

> Tracks ChatLab v0.17.2

## Requirements

- [ChatLab](https://github.com/hellodigua/ChatLab) installed and running
- API enabled in ChatLab Settings → API, with a token generated
- Node.js 18+

## Installation

### npx (recommended)

No installation needed. Configure your AI client directly:

```json
{
  "mcpServers": {
    "chatlab": {
      "command": "npx",
      "args": ["-y", "chatlab-mcp"],
      "env": {
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx",
        "CHATLAB_URL": "http://127.0.0.1:5200"
      }
    }
  }
}
```

### From source

```bash
git clone https://github.com/gamesme/chatlab-mcp
cd chatlab-mcp
npm install && npm run build
```

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

**With npx:**
```json
{
  "mcpServers": {
    "chatlab": {
      "command": "npx",
      "args": ["-y", "chatlab-mcp"],
      "env": {
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx",
        "CHATLAB_URL": "http://127.0.0.1:5200"
      }
    }
  }
}
```

**From source (use your Homebrew node to avoid version issues):**
```json
{
  "mcpServers": {
    "chatlab": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/chatlab-mcp/dist/index.js"],
      "env": {
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx",
        "CHATLAB_URL": "http://127.0.0.1:5200"
      }
    }
  }
}
```

Restart Claude Desktop after saving. The `chatlab` tools will appear in the tools list.

## Tools

| Tool | Description |
|------|-------------|
| `list_sessions` | List all imported chat sessions with name, platform, and message count |
| `get_session` | Get details of a single session by ID |
| `get_messages` | Retrieve messages with filters: keyword, time range, sender, pagination (max 100/call) |
| `get_members` | List all members in a session with their platformId and message count |
| `get_stats_overview` | Statistical overview: message counts, member activity, type distribution, time range |
| `execute_sql` | Run aggregation queries (COUNT/GROUP BY) against the session database |

### Notes

- `get_messages` returns at most 100 messages per call. Use the `page` parameter to paginate. Responses include `has_more` and a `hint` when more results exist.
- `execute_sql` is for statistical aggregation only (word frequency, activity breakdown, member interactions). Use `get_messages` to read message content.
- All avatar/binary fields are stripped from responses to minimize context usage.

## CLI Options

```bash
node dist/index.js --token <token> --url <url>
# or via env vars
CHATLAB_TOKEN=clb_xxx CHATLAB_URL=http://127.0.0.1:5200 node dist/index.js
```

`CHATLAB_URL` defaults to `http://127.0.0.1:5200`.

## Development

```bash
npm test             # run all tests
npm run test:watch   # watch mode
npm run dev          # run with ts-node (no build step)
npm run build        # compile TypeScript → dist/
```
