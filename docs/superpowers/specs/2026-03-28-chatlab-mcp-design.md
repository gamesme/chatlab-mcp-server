# chatlab-mcp Design Spec

**Date:** 2026-03-28
**Status:** Approved

## Summary

`chatlab-mcp` is a standalone MCP (Model Context Protocol) server that bridges ChatLab's local API with AI assistants (Claude Desktop, Cursor, custom agents, etc.). It enables users to query and analyze their chat history directly within their AI workflows.

## Problem

ChatLab stores rich personal chat history but that data is siloed. Users increasingly want their AI assistants to access and analyze this history — searching conversations, understanding relationships, reviewing what was discussed on a given topic or date. ChatLab exposes a standard local REST API; the MCP layer makes it accessible to any MCP-compatible AI assistant.

## Goals

- Let AI assistants query ChatLab chat history via natural language-driven MCP tools
- Cover the full workflow: discover → retrieve → analyze → export
- Stay strictly in sync with what ChatLab's upstream API actually provides
- Simple setup: clone, install, configure token, add to Claude Desktop config

## Non-Goals

- No Electron integration, no bundling inside ChatLab
- No HTTP/SSE transport (stdio only; HTTP mode is a future addition if needed)
- No direct SQLite access (API only)
- No chat import functionality (write path is out of scope for AI workflows)

---

## Architecture

```
AI Assistant (Claude Desktop / Cursor / Agent)
        │  stdio (MCP protocol)
        ▼
  chatlab-mcp process
  ┌─────────────────────────────┐
  │  server.ts   (McpServer)    │
  │  tools/      (7 tools)      │
  │  client.ts   (HTTP client)  │
  └────────────┬────────────────┘
               │  HTTP + Bearer Token
               ▼
  ChatLab API  http://127.0.0.1:5200/api/v1
               │
               ▼
  ChatLab App  (local SQLite databases)
```

### Project Structure

```
chatlab-mcp/
├── src/
│   ├── index.ts          # Entry: parse CLI args/env, connect stdio transport
│   ├── client.ts         # ChatLab API HTTP client (fetch + auth + error handling)
│   ├── server.ts         # Create McpServer, register all tools
│   └── tools/
│       ├── sessions.ts   # list_sessions, get_session
│       ├── messages.ts   # get_messages
│       ├── members.ts    # get_members
│       ├── stats.ts      # get_stats_overview
│       ├── sql.ts        # execute_sql
│       └── export.ts     # export_session
├── package.json
├── tsconfig.json
└── README.md
```

---

## Tools

All 7 tools map 1:1 to existing ChatLab API endpoints.

### `list_sessions`
Lists all imported chat sessions with name, platform, message count, and time range.
→ `GET /api/v1/sessions`

### `get_session`
Gets full details of a single session by ID.
→ `GET /api/v1/sessions/:id`

### `get_messages`
Retrieves messages with flexible filters. Covers "recent messages", "keyword search", and "date range" use cases in a single tool — the AI picks the right parameters.

Parameters:
- `session_id` (required)
- `keyword` — substring search
- `start_time` / `end_time` — Unix timestamps (seconds)
- `sender_id` — filter by member platformId
- `type` — filter by message type number
- `page` / `limit` — pagination (max 1000 per page)

→ `GET /api/v1/sessions/:id/messages`

### `get_members`
Lists all members in a session with their platformId, name, and role.
→ `GET /api/v1/sessions/:id/members`

### `get_stats_overview`
Returns statistical overview of a session: message counts, active members, time distribution, etc.
→ `GET /api/v1/sessions/:id/stats/overview`

### `execute_sql`
Executes a read-only SELECT query against the session's database. Primary escape hatch for analytical queries not covered by other endpoints.

Example use cases the AI can perform via SQL:
- Word frequency analysis
- Member interaction frequency
- Hourly/daily activity breakdown
- Conversation between two specific members

→ `POST /api/v1/sessions/:id/sql`

### `export_session`
Exports the full session as ChatLab Format JSON (up to 100k messages). Intended for deep analysis by AI with large context windows.
→ `GET /api/v1/sessions/:id/export`

---

## Configuration

### Environment variables (recommended)

```bash
CHATLAB_URL=http://127.0.0.1:5200   # default
CHATLAB_TOKEN=clb_xxxxxxxxxxxx       # required
```

### CLI flags (override env vars)

```bash
node dist/index.js --url http://127.0.0.1:5200 --token clb_xxxxxxxxxxxx
```

### Claude Desktop integration

```json
{
  "mcpServers": {
    "chatlab": {
      "command": "node",
      "args": ["/path/to/chatlab-mcp/dist/index.js"],
      "env": {
        "CHATLAB_URL": "http://127.0.0.1:5200",
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx"
      }
    }
  }
}
```

---

## Error Handling

- If ChatLab API is unreachable: return a clear MCP text error — "ChatLab is not running or API is disabled. Please start ChatLab and enable the API in Settings."
- If token is invalid (401): return "Invalid API token. Please check your CHATLAB_TOKEN."
- If session not found (404): return "Session not found: {id}"
- All other HTTP errors: surface the error code and message from the API response.

---

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server + stdio transport
- `zod` — tool parameter schemas

No database drivers. No Electron. No express. Just fetch + MCP SDK.

---

## TODO — Upstream API PRs Needed

These tools are desirable for AI workflow use cases but require new upstream API endpoints. Planned as PRs to the ChatLab main repo:

| Desired Tool | Endpoint to Add | Notes |
|-------------|-----------------|-------|
| `get_member_stats` | `GET /sessions/:id/stats/members` | Per-member message count, first/last seen, active days |
| `get_time_stats` | `GET /sessions/:id/stats/activity` | Hourly, daily, weekday, monthly activity breakdown |
| `get_word_frequency` | `GET /sessions/:id/stats/words` | Top-N words, configurable min count, stopword filtering |
| `get_interaction_frequency` | `GET /sessions/:id/stats/interactions` | Top member pairs by reply proximity (5-min window) |
| `get_message_context` | `GET /sessions/:id/messages/:msgId/context` | N messages before and after a specific message ID |

Until these endpoints exist, `execute_sql` serves as the workaround for all of the above.

---

## Out of Scope (This Version)

- HTTP/SSE transport mode
- npx-runnable package (future: publish to npm as `chatlab-mcp`)
- Multi-language README (start with English)
- Import/write tools
