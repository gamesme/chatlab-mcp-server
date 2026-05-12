# Analytics Tools Parity Design Spec

**Date:** 2026-05-12
**Status:** Draft

## Summary

Add a batch of SQL-backed analytics tools to `chatlab-mcp-server` so AI assistants can reach feature parity with the chat analysis primitives that the ChatLab desktop app already exposes to its in-app LLM (the 16+ `AgentTool` definitions in `electron/main/ai/tools/`). The MCP server cannot call those tools directly because they live behind in-process `workerManager` calls, not REST. Instead, every new tool will compose a read-only SQL query and dispatch it through the existing `POST /api/v1/sessions/:id/sql` endpoint.

## Problem

The MCP server today exposes 8 tools (`list_sessions`, `get_session`, `get_messages`, `get_conversation_text`, `get_full_conversation`, `get_members`, `get_stats_overview`, `execute_sql`). The desktop app has many more analysis primitives (`get_message_context`, `get_conversation_between`, `get_session_summaries`, `deep_search_messages`, `get_time_stats`, `get_member_stats`, `get_member_name_history`, `response_time_analysis`, `keyword_frequency`, etc.). MCP users currently have to hand-craft SQL via `execute_sql` to get the same answers.

Two non-negotiable constraints:
1. **Do not modify the main project** (chatlab-org). No new REST endpoints, no new internal helpers.
2. Use existing endpoints only — primarily `POST /api/v1/sessions/:id/sql`.

## Goals

- Match the most useful chat analysis tools from the main project as MCP tools (~9 new tools).
- Each new tool composes a precise SQL query internally — the LLM does not have to know SQL schema.
- All tools follow existing MCP conventions: `format=text|json`, `timezone` parameter, `start_time`/`end_time` filters, ascending timestamp order.
- For functionality SQL cannot achieve (Chinese word segmentation), return a clear informational message describing the limitation.

## Non-Goals

- No upstream API changes.
- No new Electron/desktop features.
- No bundled NLP libraries (`jieba`, `kuromoji`, etc.) — keeps the package small and pure JS.
- No cross-session content search (would require iterating every session DB; out of scope).
- No write operations (import / member edit) — MCP server stays read-only.

---

## Architecture

```
LLM (Claude / Cursor / etc.)
        │  MCP stdio
        ▼
chatlab-mcp-server
  src/tools/
    analytics.ts   ← NEW: 9 SQL-backed analysis tools
    sql.ts         (unchanged — still the LLM-facing escape hatch)
    ...
        │  HTTP POST /api/v1/sessions/:id/sql  (Bearer token)
        ▼
ChatLab desktop app (Fastify API, read-only SQL on per-session SQLite)
```

### Why a new file

Each new tool follows the same shape (compose SQL → POST → format result). Co-locating them in `analytics.ts` keeps related code together and avoids inflating `messages.ts` or `stats.ts`.

### Internal SQL helper

Add a small helper in `src/tools/utils.ts`:

```ts
export async function sqlInternal(
  client: Pick<ChatLabClient, 'post'>,
  sessionId: string,
  sql: string
): Promise<any[]> {
  const result: any = await client.post(`/api/v1/sessions/${sessionId}/sql`, { sql })
  return result.data?.rows ?? result.data ?? []
}
```

Differences from the LLM-facing `executeSQL`:
- Does NOT inject a `LIMIT 200` cap (callers include their own LIMIT, default 500, capped at 5000 per tool).
- Does NOT enforce `SELECT`-only check at the MCP boundary; the upstream endpoint already rejects non-readonly statements.
- Returns the parsed rows array rather than a JSON string.

---

## Tools (9 new)

All new tools accept these shared parameters where relevant:
- `session_id` (required)
- `start_time` / `end_time` — Unix seconds, optional
- `format` — `'text'` (default) or `'json'`
- `timezone` — IANA name, default `Asia/Shanghai` (matches `get_messages`)

### 1. `get_message_context`

Get N messages before and after a specific message (or list of messages).

Parameters: `message_ids: number[]`, `context_size?: number` (default 20, max 100)

SQL pattern:
```sql
SELECT m.id, m.ts, m.type, m.content,
       mem.platform_id AS senderPlatformId,
       COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
FROM message m
LEFT JOIN member mem ON m.sender_id = mem.id
WHERE m.id BETWEEN (target_id - ctx) AND (target_id + ctx)
ORDER BY m.id
```

Multi-target: union the windows around each target ID.

### 2. `get_conversation_between`

Messages where the senders are two specific members, ordered by time.

Parameters: `member_id_1: number`, `member_id_2: number`, plus shared filters, `limit?: number`.

SQL:
```sql
SELECT m.id, m.ts, m.type, m.content,
       mem.platform_id AS senderPlatformId,
       COALESCE(mem.group_nickname, mem.account_name, mem.platform_id) AS senderName
FROM message m
JOIN member mem ON m.sender_id = mem.id
WHERE m.sender_id IN (?, ?)
  AND (? IS NULL OR m.ts >= ?)
  AND (? IS NULL OR m.ts <= ?)
ORDER BY m.ts
LIMIT ?
```

Note: `member_id_*` here are the DB internal numeric `member.id` values, not platformId. The tool description tells the LLM to first call `get_members` (which already exposes `id`).

### 3. `get_session_summaries`

Read AI-generated chat-segment summaries from the `chat_session` table.

Parameters: `keywords?: string[]`, `limit?: number` (default 20), shared time filters.

SQL:
```sql
SELECT id, start_ts, end_ts, message_count, summary
FROM chat_session
WHERE summary IS NOT NULL
  AND (? IS NULL OR start_ts >= ?)
  AND (? IS NULL OR end_ts <= ?)
ORDER BY start_ts DESC
LIMIT ?
```

`ORDER BY start_ts DESC` returns the most recent topics first (matches the "what have we been talking about?" mental model). Within each row, time fields are still rendered in caller-specified timezone.

Keyword filter applied client-side (SQLite has no full-text on `summary`; `LIKE` is acceptable for small N).

When no rows: return text "No AI-generated summaries yet. The user can generate them in ChatLab's session timeline." (i18n-friendly Chinese + English).

### 4. `deep_search_messages`

FTS5 full-text search with surrounding context messages.

Parameters: `keywords: string[]`, `sender_id?: number`, `limit?: number` (default 100), `context_before?: number` (default 2), `context_after?: number` (default 2), shared time filters.

SQL (two-step):

Step 1 — find hits:
```sql
SELECT m.id, m.ts
FROM message m
JOIN message_fts ON m.id = message_fts.rowid
WHERE message_fts MATCH ?
  AND (? IS NULL OR m.sender_id = ?)
  AND (? IS NULL OR m.ts >= ?)
  AND (? IS NULL OR m.ts <= ?)
ORDER BY m.ts
LIMIT ?
```

Step 2 — for each hit ID, expand to `[id - before, id + after]` via a single second query using `IN` ranges or `BETWEEN` on the union of windows.

Multiple keywords are joined with FTS5's `OR` operator (e.g. `"key1" OR "key2"`). For phrase-exact match, the caller can wrap a keyword in quotes manually.

### 5. `get_time_stats`

Hourly / weekday / daily message-count distributions.

Parameters: `type: 'hourly' | 'weekday' | 'daily'`, shared time filters.

SQL (varies by type):
```sql
-- hourly
SELECT CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) AS bucket, COUNT(*) AS count
FROM message WHERE (filter) GROUP BY bucket ORDER BY bucket

-- weekday  (0=Sunday)
SELECT CAST(strftime('%w', ts, 'unixepoch') AS INTEGER) AS bucket, COUNT(*) AS count
FROM message WHERE (filter) GROUP BY bucket ORDER BY bucket

-- daily (last 30 days; for full history, callers can add start_time)
SELECT date(ts, 'unixepoch') AS bucket, COUNT(*) AS count
FROM message WHERE (filter) GROUP BY bucket ORDER BY bucket
```

Note: `strftime` operates in UTC. For users in `Asia/Shanghai`, applying `'+8 hours'` arithmetic to `ts` matters for hourly accuracy. The tool applies a timezone offset if `timezone` is set (computed in JS from the IANA name; SQLite has no IANA support).

### 6. `get_member_activity`

Top members ranked by message count, with percentage of total.

Parameters: `top_n?: number` (default 10, max 50), shared time filters.

SQL:
```sql
WITH counts AS (
  SELECT m.sender_id, COUNT(*) AS msg_count
  FROM message m
  WHERE (filter) GROUP BY m.sender_id
), total AS (
  SELECT SUM(msg_count) AS t FROM counts
)
SELECT mem.id, mem.platform_id, mem.account_name, mem.group_nickname,
       c.msg_count,
       ROUND(c.msg_count * 100.0 / total.t, 2) AS percentage
FROM counts c
JOIN member mem ON mem.id = c.sender_id
CROSS JOIN total
ORDER BY c.msg_count DESC
LIMIT ?
```

### 7. `get_member_name_history`

Name change history for a single member.

Parameters: `member_id: number`.

SQL:
```sql
SELECT name_type, name, start_ts, end_ts
FROM member_name_history
WHERE member_id = ?
ORDER BY start_ts
```

### 8. `get_response_time_analysis`

Distribution of reply intervals (time between consecutive messages from different senders).

Parameters: `top_n?: number` (default 10 pairs), shared time filters.

SQL (uses `LAG()` window function — SQLite 3.25+ supports this):
```sql
WITH ordered AS (
  SELECT ts, sender_id,
         LAG(ts)       OVER (ORDER BY ts) AS prev_ts,
         LAG(sender_id) OVER (ORDER BY ts) AS prev_sender
  FROM message
  WHERE (filter)
)
SELECT prev_sender AS from_id, sender_id AS to_id,
       COUNT(*) AS reply_count,
       MIN(ts - prev_ts) AS min_seconds,
       AVG(ts - prev_ts) AS avg_seconds,
       MAX(ts - prev_ts) AS max_seconds
FROM ordered
WHERE prev_sender IS NOT NULL
  AND prev_sender <> sender_id
  AND (ts - prev_ts) BETWEEN 1 AND 3600       -- 1s..1h window, exclude gaps
GROUP BY from_id, to_id
ORDER BY reply_count DESC
LIMIT ?
```

Then join with `member` table for names.

### 9. `keyword_frequency`

Returns informational text only — no SQL run.

Output (text format):
```
keyword_frequency is not implemented in chatlab-mcp-server.

This feature requires CJK word segmentation (jieba / kuromoji), which the MCP
server does not bundle to keep the package lightweight.

Alternatives:
1. Run keyword_frequency in the ChatLab desktop app (Insights > Word Cloud).
2. Use execute_sql with LIKE patterns for known phrases:
     SELECT content, COUNT(*) FROM message
     WHERE content LIKE '%<phrase>%' GROUP BY content
3. Use get_messages with a keyword filter and let the LLM count occurrences.
```

JSON format returns the same text under a `message` field plus `available_alternatives: string[]`.

---

## Data Flow

```
LLM calls tool (e.g. get_time_stats)
       │
       ▼
analytics.ts → composeSQL(params, timezone)
       │
       ▼
utils.sqlInternal(client, session_id, sql)
       │
       ▼
client.post('/api/v1/sessions/:id/sql', { sql })
       │
       ▼
parse result.data → format as text via existing format.ts helpers (or JSON)
       │
       ▼
return MCP content block
```

For SQL text output, reuse `formatToolResultAsText(details)` from `format.ts` so headers/messages render consistently with other tools.

---

## Error Handling

- SQL errors: catch and surface the message from the API ("`SQL execution error: near 'X': syntax error`"). Use the existing `toolError` helper.
- Missing tables (older session DBs without `chat_session` / `message_fts`): catch `no such table` and return a clear text "This feature requires a newer database schema. Please reimport the session in the latest ChatLab version."
- Empty result sets: return a short message ("No matching messages." / "No summaries found.") rather than an empty list.
- `member_id` not found: SQL returns 0 rows; emit "Member id=N not found in this session." (text) so the LLM can adjust.

---

## Output Format

### Text (default)

Use the existing `formatToolResultAsText` pattern:
```
total: 42
returned: 10
timeRange: 2025-04-01 ~ 2025-04-30

--- 2025-04-01 ---
07:25 Alice: hello
07:26 Bob: hi
...
```

For non-message results (time_stats, member_activity), emit key:value lines plus a short table or list. Examples:

```
type: hourly
peakHour: 21:00 (1234 messages)

00:00 12
01:00 5
...
```

### JSON

Return the raw API JSON response wrapped:
```json
{
  "data": [ { ...row }, ... ],
  "meta": { "rowCount": 42 }
}
```

---

## Testing

Each new tool gets a unit test file under `tests/tools/analytics/*.test.ts`. Pattern (vitest):

```ts
const mockClient = { post: vi.fn(), get: vi.fn() }

it('get_time_stats composes hourly SQL', async () => {
  mockClient.post.mockResolvedValue({ data: { rows: [{ bucket: 9, count: 100 }] } })
  await getTimeStats(mockClient, { session_id: 's1', type: 'hourly' })
  const sql = mockClient.post.mock.calls[0][1].sql
  expect(sql).toMatch(/strftime\('%H'/)
  expect(sql).toMatch(/GROUP BY bucket/)
})

it('get_time_stats formats text output', async () => {
  mockClient.post.mockResolvedValue({ data: { rows: [{ bucket: 9, count: 100 }] } })
  const out = await getTimeStats(mockClient, { session_id: 's1', type: 'hourly', format: 'text' })
  expect(out).toMatch(/09:00/)
  expect(out).toMatch(/100/)
})
```

At minimum two tests per tool: (a) SQL composition, (b) text formatting. JSON formatting only when it differs meaningfully from text.

---

## Dependencies

No new runtime dependencies. Existing:
- `@modelcontextprotocol/sdk` (already)
- `zod` (already)
- `vitest` (dev)

---

## Configuration

No new env vars. Tools inherit `CHATLAB_URL` / `CHATLAB_TOKEN` from existing client setup.

---

## Versioning

This is a feature addition with no breaking changes. Bump to **v0.18.0** to align with the main project's next version range and signal new capabilities. Update README version reference, package.json, all README translations.

---

## Implementation Order

1. Add `sqlInternal` helper in `src/tools/utils.ts`.
2. Add `src/tools/analytics.ts` with **8 SQL tools** (skipping `keyword_frequency` initially).
3. Wire registration in `src/server.ts`.
4. Add tests for each tool.
5. Add `keyword_frequency` info-only tool (no SQL).
6. Update README files (EN, zh-CN, zh-TW, ja) with new tool list.
7. Bump version, commit, tag, push, npm publish.

---

## Out of Scope (Follow-up)

- Cross-session keyword search (`search_sessions` content-level).
- NLP keyword frequency (requires bundled segmentation).
- Mention graph / cluster graph / relationship stats (would require complex SQL + post-processing; defer until requested).
