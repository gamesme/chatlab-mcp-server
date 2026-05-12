# chatlab-mcp

**[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)**

MCP server that connects [ChatLab](https://github.com/hellodigua/ChatLab) to AI assistants (Claude Desktop, Cursor, custom agents). Query your local chat history with natural language.

> Tracks ChatLab v0.19.0

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

### Core (6)
| Tool | Description |
|------|-------------|
| `list_sessions` | List all imported chat sessions with name, platform, and message count |
| `get_session` | Get details of a single session by ID |
| `get_messages` | Retrieve messages with filters: keyword, time range, sender, pagination (max 100/call) |
| `get_members` | List all members in a session with their platformId and message count |
| `get_stats_overview` | Statistical overview: message counts, member activity, type distribution, time range |
| `execute_sql` | Run aggregation queries (COUNT/GROUP BY) against the session database |

### Analytics (v0.19.0+, 9)
| Tool | Description |
|------|-------------|
| `get_message_context` | N messages before/after one or more target message IDs |
| `get_conversation_between` | Interleaved messages between two specific members (numeric IDs) |
| `get_session_summaries` | AI-generated chat sub-session summaries (from the chat_session table) |
| `deep_search_messages` | FTS5 keyword search with surrounding context window |
| `get_time_stats` | Hourly / weekday / daily distribution, timezone-aware |
| `get_member_activity` | Top-N members by message count with percentage of total |
| `get_member_name_history` | Historical account name / nickname entries for a member |
| `get_response_time_analysis` | Reply intervals between sender pairs (LAG window function) |
| `keyword_frequency` | Stub — returns guidance (NLP segmentation not bundled in MCP) |

### Notes

- `get_messages` returns at most 100 messages per call. Use the `page` parameter to paginate. Responses include `has_more` and a `hint` when more results exist.
- `execute_sql` is for statistical aggregation only. Use `get_messages` or `get_message_context` to read message content.
- Analytics tools issue their own SQL through the same `/sql` endpoint (no 200-row LIMIT injection).
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
