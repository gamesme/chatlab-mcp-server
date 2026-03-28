# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`chatlab-mcp` is a TypeScript MCP (Model Context Protocol) server that bridges ChatLab's local REST API with AI assistants (Claude Desktop, Cursor, custom agents). It runs as a stdio process and exposes 7 tools for querying chat history.

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
  │  src/tools/    (7 tools)    │
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
- `src/tools/` — one file per tool group (`sessions.ts`, `messages.ts`, `members.ts`, `stats.ts`, `sql.ts`, `export.ts`)

## Tools → API Mapping

| Tool | HTTP endpoint |
|------|--------------|
| `list_sessions` | `GET /sessions` |
| `get_session` | `GET /sessions/:id` |
| `get_messages` | `GET /sessions/:id/messages` |
| `get_members` | `GET /sessions/:id/members` |
| `get_stats_overview` | `GET /sessions/:id/stats/overview` |
| `execute_sql` | `POST /sessions/:id/sql` (SELECT only) |
| `export_session` | `GET /sessions/:id/export` |

`execute_sql` is the analytical escape hatch — use it for word frequency, member interaction, activity breakdown until dedicated stat endpoints exist upstream.

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
