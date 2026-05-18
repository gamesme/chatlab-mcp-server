# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`chatlab-mcp` is a TypeScript MCP (Model Context Protocol) server that bridges ChatLab's local REST API with AI assistants (Claude Desktop, Cursor, custom agents). It runs as a stdio process and exposes 15 tools for querying chat history.

**ChatLab API base:** `http://127.0.0.1:5200/api/v1`
**Auth:** Bearer token via `CHATLAB_TOKEN` env var or `--token` CLI flag

## Commands

```bash
npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm run dev          # run with ts-node (no compile step)
npm start            # node dist/index.js
```

## Architecture

```
AI Assistant (Claude Desktop / Cursor / Agent)
        │  stdio (MCP protocol)
        ▼
  chatlab-mcp process
  ┌─────────────────────────────┐
  │  src/index.ts  (entry)      │
  │  src/server.ts (McpServer)  │
  │  src/tools/    (15 tools)   │
  │  src/client.ts (HTTP)       │
  └────────────┬────────────────┘
               │  HTTP + Bearer Token
               ▼
  ChatLab API  http://127.0.0.1:5200/api/v1
```

### Key files

- `src/index.ts` — parse CLI args (`--url`, `--token`) / env vars, connect stdio transport
- `src/client.ts` — fetch wrapper with Bearer auth and structured error handling
- `src/server.ts` — create `McpServer`, register all tools
- `src/tools/` — one file per tool group (`sessions.ts`, `messages.ts`, `conversation.ts`, `members.ts`, `stats.ts`, `sql.ts`, `analytics.ts`)
- `src/tools/message-tool.ts` — `registerMessageTool` factory shared by the 5 message-returning tools (`get_messages`, `get_full_conversation`, `get_message_context`, `get_conversation_between`, `deep_search_messages`). Provides unified `format`, `timezone`, `merge_consecutive`, and `filter_invalid` params.

## Tools → API Mapping

| Tool | HTTP endpoint |
|------|--------------|
| `list_sessions` | `GET /sessions` |
| `get_session` | `GET /sessions/:id` |
| `get_messages` | `POST /sessions/:id/sql` (filtered messages query) |
| `get_full_conversation` | `POST /sessions/:id/sql` (or `GET /sessions/:id/messages` when `filter_invalid=false`) |
| `get_members` | `GET /sessions/:id/members` |
| `get_stats_overview` | `GET /sessions/:id/stats/overview` |
| `execute_sql` | `POST /sessions/:id/sql` (SELECT only) |
| `get_message_context` | `POST /sessions/:id/sql` (time-window expansion) |
| `get_conversation_between` | `POST /sessions/:id/sql` |
| `get_session_summaries` | `POST /sessions/:id/sql` |
| `deep_search_messages` | `POST /sessions/:id/sql` (FTS5) |
| `get_time_stats` | `POST /sessions/:id/sql` |
| `get_member_activity` | `POST /sessions/:id/sql` |
| `get_member_name_history` | `POST /sessions/:id/sql` |
| `get_response_time_analysis` | `POST /sessions/:id/sql` |

The 5 message-returning tools (`get_messages`, `get_full_conversation`, `get_message_context`, `get_conversation_between`, `deep_search_messages`) all share the `registerMessageTool` factory which adds `format`, `timezone`, `merge_consecutive`, and `filter_invalid` params. `get_session_summaries` returns summary entities, not messages, and uses raw `server.tool` directly.

`execute_sql` is the analytical escape hatch — use it for arbitrary aggregation queries. Available tables: `message`, `member`, `chat_session`, `message_fts`, `member_name_history`.

## Error Handling Contract

- API unreachable → "ChatLab is not running or API is disabled. Please start ChatLab and enable the API in Settings."
- 401 → "Invalid API token. Please check your CHATLAB_TOKEN."
- 404 → "Session not found: {id}"
- Other HTTP errors → surface error code + message from API response body

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server + stdio transport
- `zod` — tool parameter schemas

No database drivers, no express, no Electron. Just `fetch` + the MCP SDK.

## Transport

stdio only. HTTP/SSE transport is explicitly out of scope for this version.

## Spec

Full design spec: `docs/superpowers/specs/2026-03-28-chatlab-mcp-design.md`
