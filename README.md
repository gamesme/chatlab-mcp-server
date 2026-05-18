# chatlab-mcp

**[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)**

MCP server that connects [ChatLab](https://github.com/hellodigua/ChatLab) to AI assistants (Claude Desktop, Cursor, custom agents). Query your local chat history with natural language.

> Tracks ChatLab v0.19.0 — **v0.20** refactored message tools (see [Breaking Changes](#breaking-changes))

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

15 tools total (v0.20).

### Core (7)
| Tool | Description |
|------|-------------|
| `list_sessions` | List all imported chat sessions with name, platform, and message count |
| `get_session` | Get details of a single session by ID |
| `get_messages` | Retrieve messages with filters: keyword, time range, sender, pagination (default 100/call) |
| `get_full_conversation` | Full chronological message history for a session |
| `get_members` | List all members in a session with their platformId and message count |
| `get_stats_overview` | Statistical overview: message counts, member activity, type distribution, time range |
| `execute_sql` | Run aggregation queries (COUNT/GROUP BY) against the session database |

### Analytics (v0.19.0+, 8)
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

### Shared message-tool params

All message-returning tools (`get_messages`, `get_full_conversation`, `get_message_context`, `get_conversation_between`, `deep_search_messages`) accept:

| Param | Default | Description |
|-------|---------|-------------|
| `format` | `text` | `text` or `json` |
| `timezone` | `UTC` | IANA timezone for timestamps (e.g. `America/New_York`) |
| `merge_consecutive` | `false` | Merge back-to-back messages from the same sender |
| `filter_invalid` | `true` | Skip system/empty messages at the SQL layer |

### Notes

- `get_messages` default limit is 100. Use the `page` parameter to paginate. Responses include `has_more` and a `hint` when more results exist.
- `get_messages` returns `id` and `senderPlatformId` per message so `get_message_context` can be called as a follow-up.
- `execute_sql` is for statistical aggregation only. Use `get_messages` or `get_message_context` to read message content. Available tables: `message`, `member`, `chat_session`, `message_fts`, `member_name_history`.
- Analytics tools issue their own SQL through the same `/sql` endpoint (no 200-row LIMIT injection).
- All avatar/binary fields are stripped from responses to minimize context usage.

## Breaking Changes

### v0.20 (message tools refactor)

- **Removed `get_conversation_text`** — use `get_messages(format='text', limit=…)` instead.
- **Removed `keyword_frequency`** (was a stub) — use `execute_sql` with `LIKE` patterns or the ChatLab desktop app's Insights > Word Cloud.

### Improvements

- All 6 message-returning tools now support shared params: `format`, `timezone`, `merge_consecutive`, `filter_invalid`. Previously these worked only on `get_messages` and the two conversation tools.
- `get_messages` default `limit` increased from 20 → 100.
- `get_messages` now returns `id` and `senderPlatformId` per message so `get_message_context` can be called as a follow-up.
- `get_messages` with `filter_invalid=true` (default) now filters at the SQL layer, saving bandwidth.
- `get_message_context` uses time-window expansion (robust to deleted / non-contiguous message IDs).
- `execute_sql` description now lists all available tables.

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
