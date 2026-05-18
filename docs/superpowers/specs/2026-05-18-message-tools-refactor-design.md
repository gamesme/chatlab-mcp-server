# Message Tools Refactor — Design Spec

**Date:** 2026-05-18
**Author:** gamesme (with Claude assistance)
**Status:** Draft for review

## 1. Background

`chatlab-mcp-server` is a stdio MCP server that bridges upstream ChatLab's REST API (`http://127.0.0.1:5200/api/v1`) with AI assistants. It currently exposes 17 tools, of which **6 return chat messages** as their primary output:

- `get_messages` — REST `/messages` paginated
- `get_conversation_text` — REST `/messages` single page, text-only
- `get_full_conversation` — REST `/messages` multi-page loop
- `get_message_context` — SQL-based, N messages around target IDs
- `get_conversation_between` — SQL-based, two-sender interleave
- `deep_search_messages` — SQL-based, FTS5 + context expansion

These 6 tools accumulated overlapping responsibilities and divergent implementations over time. Analysis (see Section 2) identified the root cause: the message-formatting logic was ported from upstream `chatlab-org`'s centralized wrapper architecture in a piecemeal fashion, without introducing the wrapper itself. The result is three independent rendering paths, three inconsistent limit constants, and several latent bugs.

This refactor introduces a single shared factory (`registerMessageTool`) for all message-returning tools and consolidates the rendering pipeline. It also takes the opportunity to fix a handful of description bugs and unify formatting in other tool categories.

### Constraints

- **Scope is strictly the MCP server**. Upstream `chatlab-org` REST API surface (types, endpoints, parameters) must not change. `POST /api/v1/sessions/:id/sql` is a legitimate part of the API and may be used freely.
- **No new dependencies**. Stay on the existing `@modelcontextprotocol/sdk` + `zod` footprint.
- **Existing test infrastructure (vitest) is reused**. No new test framework or runner.

## 2. Root Cause Analysis

Upstream `chatlab-org` has a centralized wrapper `wrapWithPreprocessing()` (electron/main/ai/tools/index.ts:117) that intercepts every tool returning `rawMessages` and applies the full preprocess pipeline: `preprocessMessages` (mergeConsecutive / filterInvalid / anonymizeNames), token-aware truncation, and `formatMessageCompact`. Three separate message-reading tools (`get_recent_messages`, `get_session_messages`, `search_messages`) live underneath this wrapper without ever knowing about formatting.

When the MCP server was first written (commit `66e4f15`), it had only one `get_messages` tool — sensible, since the upstream REST API collapsed the three semantic variants into a single `/messages` endpoint backed by `worker.searchMessages`.

Later (commit `dac85f0` "feat: 实现消息格式化与压缩功能"), the formatting + compression logic was ported from upstream. But the porter:

1. Did **not** introduce a wrapper or factory abstraction
2. Added `format`/`merge_consecutive`/`filter_invalid` parameters directly inside `get_messages`
3. Added two **new tools** (`get_conversation_text`, `get_full_conversation`) wrapping the same REST endpoint with different defaults — implicitly resurrecting the three-tool semantics on the MCP side

Subsequent analytics tools (`get_message_context`, `get_conversation_between`, `deep_search_messages`) bypassed the existing helper and wrote their own inline `new Date().toLocaleString()` time formatting, because they fetch via SQL rather than REST and the helper signature was REST-shaped.

The result: **3 independent rendering paths, 3 inconsistent limit constants** (`MAX_LIMIT=500`, `MAX_MESSAGES_PER_CALL=200`, `max_total_messages=1000`), and the following bugs:

- `get_messages` strips `id` and `senderPlatformId` from output, breaking the chain to `get_message_context` (which needs IDs)
- SQL-based message tools silently ignore `timezone`, `merge_consecutive`, `filter_invalid` params (those params don't exist in those tools because the SQL path never adopted them)
- `filter_invalid=true` works post-fetch rather than at SQL level — wasteful bandwidth for large groups
- `get_messages` defaults `limit` to 20, forcing excessive pagination
- `keyword` parameter is documented as "Substring search" but is actually FTS5 when available (REST behavior inherited from upstream)
- `execute_sql` description lists `message, member` as available tables but omits `chat_session`, `message_fts`, `member_name_history` that analytics tools actively use
- `get_messages.type` parameter is documented as "Filter by message type number" without listing the 0–99 mapping
- `keyword_frequency` is a stub but still occupies an LLM tool slot
- `get_session_summaries.session_id` description is a copy-paste residue from `keyword_frequency`

## 3. Goals

1. Establish a single rendering pipeline for all message-returning tools, enforced by a factory rather than convention.
2. Repair the `get_messages` → `get_message_context` call chain by preserving `id` and `senderPlatformId` end-to-end.
3. Bring the SQL-based analytics tools under the same `timezone` / `merge_consecutive` / `filter_invalid` parameter surface as REST-based tools.
4. Push `filter_invalid` filtering down to the SQL layer when feasible, eliminating wasted bandwidth.
5. Fix all known description inaccuracies (type mapping, keyword behavior, table list, residue).
6. Reduce tool count by removing redundant tools (`get_conversation_text`, `keyword_frequency`).
7. Land all of the above behind existing vitest infrastructure, including a "convention-enforcement" test that prevents regression.

## 4. Non-Goals

- Token-aware truncation (upstream has it; MCP delegates to the client's context budget).
- Anonymize-names support (MCP doesn't know who the "owner" is).
- Full i18n / locale support (LLMs handle mixed CN/EN output).
- Integration tests against a real ChatLab process (deferred — see Section 12).
- Changes to non-message tool categories beyond minor format-helper consolidation.

## 5. Architecture

### 5.1 The Three-Stage Pipeline

All message-returning tools follow this contract:

```
┌──────────┐    ┌───────────────┐    ┌─────────────┐
│  fetch   │ →  │ RawMessage[]  │ →  │   render    │
│  (REST   │    │ (typed        │    │ (text/json) │
│   or SQL)│    │  intermediate)│    │             │
└──────────┘    └───────────────┘    └─────────────┘
```

Stages 2 and 3 are owned by the factory; stage 1 is the only thing each tool implements.

### 5.2 The `RawMessage` Intermediate Type

```ts
// src/format.ts
export interface RawMessage {
  /** message.id (DB primary key). Required for chaining to get_message_context. */
  id: number
  /** Display name, priority: group_nickname → account_name → platform_id */
  senderName: string
  /** Cross-platform stable sender ID, used for follow-up filtering */
  senderPlatformId: string
  /** Message text content. May be null for non-text types (image / voice / etc.) */
  content: string | null
  /** Unix seconds */
  timestamp: number
  /** Message type code (0=text, 1=image, 2=voice, 3=video, 4=emoji, 5=file,
   *  7=location, 8=system, 21=voip, 23=quote, 24=pat, 25=link, 27=music,
   *  80=miniapp, 99=other) */
  type: number
}
```

Fields explicitly excluded: `senderAvatar`, `senderAliases`, `senderId` (numeric DB id), `replyToMessageId`, `replyToContent`. These are either token-wasteful (avatar/aliases) or not currently leveraged by any caller (reply chain).

### 5.3 The `messageTool` Factory

Location: `src/tools/message-tool.ts` (new file).

```ts
export interface MessageToolDef<TSchema extends ZodRawShape> {
  name: string
  description: string
  schema: TSchema           // tool-specific params; must include session_id
  fetch: (params: ToolParams<TSchema>) => Promise<MessageFetchResult>
}

export interface MessageFetchResult {
  messages: RawMessage[]
  total?: number            // optional, enables pagination instructions
  page?: number             // optional, enables pagination instructions
  has_more?: boolean        // optional, used when total is too expensive to compute
  extra?: Record<string, unknown>  // tool-specific metadata (hits, time_range, etc.)
}

export function registerMessageTool<TSchema extends ZodRawShape>(
  server: McpServer,
  client: ChatLabClient,
  def: MessageToolDef<TSchema>
): void
```

The factory performs five steps:

1. Merge shared params (`format`, `timezone`, `merge_consecutive`, `filter_invalid`) into the tool's zod schema.
2. Invoke `def.fetch(params)` to obtain `MessageFetchResult`.
3. Dispatch to `renderMessages(result, sharedOpts)` for final string output. Sorting by `timestamp` ascending happens inside `renderMessages` (REST returns desc; SQL may be arbitrary; multi-page concatenations can be out of order — all paths converge here).
4. Wrap with try/catch → `toolError(e, params.session_id)`.
5. Return `{ content: [{ type: 'text', text }] }` to MCP.

### 5.4 Shared Parameters (Auto-Injected)

```ts
const SHARED_MESSAGE_PARAMS = {
  format: z.enum(['json', 'text']).optional()
    .describe('Output format: text (default, compact) or json (raw structured)'),
  timezone: z.string().optional()
    .describe('IANA timezone for time display, e.g. "Asia/Shanghai", "UTC". Default: Asia/Shanghai'),
  merge_consecutive: z.boolean().optional()
    .describe('Merge consecutive messages from same sender (text format only, default: true)'),
  filter_invalid: z.boolean().optional()
    .describe('Filter stickers, system messages, single-char replies, etc. (text format only, default: true)'),
}
```

These 4 parameters are removed from individual tool schemas and inserted automatically. A tool's `fetch` function receives the merged params but is not expected to reference these fields — the factory consumes them after `fetch` returns.

### 5.5 The Render Pipeline

```ts
function renderMessages(
  result: MessageFetchResult,
  toolName: string,
  sessionId: string,
  opts: SharedOpts,
): string {
  const sorted = [...result.messages].sort((a, b) => a.timestamp - b.timestamp)

  if (opts.format === 'json') {
    return JSON.stringify({
      total: result.total ?? sorted.length,
      returned: sorted.length,
      ...(result.page !== undefined && { page: result.page }),
      ...result.extra,
      messages: sorted,                  // full RawMessage[], no field stripping
      ...(needsHint(result, sorted.length) && {
        has_more: true,
        hint: `Use page=${(result.page ?? 1) + 1}`,
      }),
    }, null, 2)
  }

  // text path
  const plainText = formatMessagesAsPlainText(sorted, {
    mergeConsecutive: opts.merge_consecutive ?? true,
    filterInvalid: opts.filter_invalid ?? true,
    timezone: opts.timezone ?? 'Asia/Shanghai',
  })

  const details: Record<string, unknown> = {
    total: result.total ?? sorted.length,
    returned: sorted.length,
    ...(result.page !== undefined && { page: result.page }),
    ...result.extra,
    ...(plainText && { messages: plainText.split('\n') }),
  }

  if (needsHint(result, sorted.length)) {
    const nextPage = (result.page ?? 1) + 1
    const remaining = (result.total ?? 0) - sorted.length
    details.instruction =
      `还有 ${remaining} 条未显示。调用 ${toolName}(session_id="${sessionId}", page=${nextPage})`
  }

  return formatToolResultAsText(details)
}
```

JSON-mode output intentionally **does not** apply `filter_invalid` or `merge_consecutive` — JSON callers want raw structured data. Description text already documents this constraint.

## 6. Per-Tool Migration

| # | Tool | Action | Fetch Function | Notes |
|---|---|---|---|---|
| 1 | `get_messages` | Refactor | `fetchMessagesViaRest` + SQL fast path | default limit 20 → 100; preserve id/senderPlatformId |
| 2 | `get_conversation_text` | **Delete** | — | Fully redundant with `get_messages(format='text')` |
| 3 | `get_full_conversation` | Thin wrapper | Loop over `fetchMessagesViaRest` at limit=500 | 5× fewer round-trips than current limit=100 |
| 4 | `get_message_context` | Refactor + SQL change | `fetchMessageContextViaSql` | `id BETWEEN` → time-window expansion |
| 5 | `get_conversation_between` | Refactor | `fetchConversationBetweenViaSql` | SQL unchanged; gains shared params |
| 6 | `deep_search_messages` | Refactor | `fetchDeepSearchViaSql` | FTS5 flow unchanged; gains shared params |

Estimated line-count delta across these 6 tools + the new factory: **−210 net lines** (495 → ~285). Every removed `.sort()` and inline `toLocaleString()` is a removed bug surface.

## 7. SQL Fast Path for `get_messages`

When `filter_invalid !== false && keyword === undefined`, or when `type === 0` is explicit, `fetchMessagesViaRest` routes to `fetchMessagesViaSql` instead. The SQL applies the same filters that upstream's `get_recent_messages` worker uses:

```sql
SELECT
  msg.id, msg.ts AS timestamp, msg.type, msg.content,
  m.platform_id AS senderPlatformId,
  COALESCE(m.group_nickname, m.account_name, m.platform_id) AS senderName
FROM message msg
JOIN member m ON msg.sender_id = m.id
WHERE 1=1
  ${typeFilter}             -- AND msg.type = ?  (default: msg.type = 0 when filter_invalid)
  ${timeFilter}             -- AND msg.ts >= ? AND msg.ts <= ?
  ${senderFilter}           -- AND m.platform_id = ?
  AND msg.content IS NOT NULL
  AND msg.content != ''
  AND COALESCE(m.account_name, '') != '系统消息'
ORDER BY msg.ts DESC
LIMIT ? OFFSET ?
```

Keyword searches continue to flow through REST `/messages`, because the upstream `worker.searchMessages` automatically uses FTS5 when the index exists. Reimplementing FTS tokenization in the MCP server would duplicate upstream's `ftsTokenizer`.

SQL path does not compute `total` (would require a second query); it returns `has_more` instead — a probe by requesting `limit + 1` rows and checking whether the surplus row exists. The factory consumes either `total` or `has_more` symmetrically when generating the pagination instruction.

## 8. Tool Inventory After Refactor (15 tools)

**Deleted (2):**
- `get_conversation_text` — fully redundant
- `keyword_frequency` — stub; alternatives documented in README

**Refactored — significant change (5):**
- `get_messages` — factory + SQL fast path
- `get_full_conversation` — thin wrapper
- `get_message_context` — factory + SQL change (id → time window)
- `get_conversation_between` — factory migration
- `deep_search_messages` — factory migration

**Touched — light cleanup (5):**
- `get_stats_overview` — replaces `formatStatsOverviewAsText` with `formatToolResultAsText`
- `execute_sql` — description-only fix (table list)
- `get_session_summaries` — description-only fix (copy-paste residue)
- `list_sessions` / `get_session` / `get_members` — minor field stripping cleanup; keep bespoke list formatters

**Unchanged (5):**
- `get_time_stats`, `get_member_activity`, `get_member_name_history`, `get_response_time_analysis`

Final count: **15 registered tools** (down from 17).

## 9. Description Fixes (independent of refactor)

| Tool | Location | Fix |
|---|---|---|
| `execute_sql` | src/tools/sql.ts:29 | Append `chat_session`, `message_fts`, `member_name_history` to table list |
| `get_messages.type` | src/tools/messages.ts:18 | Add full type code mapping (0=text, 1=image, …, 99=other) |
| `get_messages.keyword` | src/tools/messages.ts:13 | Reword to "Full-text search via FTS5 when available, falls back to LIKE" |
| `get_messages` page semantics | description body | State "page=1 returns the latest messages; within each page messages are sorted chronologically (ascending)" |
| `get_session_summaries.session_id` | src/tools/analytics.ts:214 | Audit and remove any "(unused; tool returns info only)" residue |

## 10. Constants Consolidation

Three currently-divergent constants unified to:

```ts
// src/format.ts
export const MESSAGES_PER_PAGE_MAX = 500
export const FULL_CONVERSATION_TOTAL_MAX = 2000
```

Replaces: `MAX_LIMIT = 500` (messages.ts), `MAX_MESSAGES_PER_CALL = 200` (conversation.ts), `max_total_messages` cap of 1000 (conversation.ts).

## 11. Testing Strategy

Three layers, all reusing existing vitest setup:

### 11.1 `format.ts` Pure Functions (new file `tests/format.test.ts`)

- RawMessage → text rendering (timezone, merge_consecutive, filter_invalid effects)
- RawMessage → JSON rendering (id/senderPlatformId preserved, no filter/merge applied, sorted ascending)
- `formatToolResultAsText` edge cases (missing messages, timeRange object, array fields)

### 11.2 Factory Contract Tests (new file `tests/message-tool.test.ts`)

The most important test surface. Validates:

- Shared params (`format`/`timezone`/`merge_consecutive`/`filter_invalid`) are auto-injected into every registered tool's schema
- A tool's `fetch` returning unsorted messages produces sorted text output
- `ChatLabError(404)` from `fetch` is translated to "Session not found: X"
- Pagination instruction generated only when `total > returned` or `has_more === true`
- A test fixture tool (`__test_tool__`) exercises the factory without depending on real fetch implementations

**Convention-enforcement test** (anti-regression):

```ts
it('no message tool implementation calls toLocaleString or formatMessagesAsPlainText directly', () => {
  // Static scan: read src/tools/*.ts, assert that only message-tool.ts and format.ts
  // reference these functions. Any future drift fails the test.
})
```

### 11.3 Per-Tool Fetch Tests (modify existing test files)

- `tests/tools/messages.test.ts` — update to test `fetchMessagesViaRest` + SQL fast path branching
- `tests/tools/analytics.test.ts` — update each fetch function; remove inline-formatting assertions
- `tests/tools/sessions.test.ts`, `tests/tools/stats.test.ts` — update for `formatToolResultAsText` output shape
- Delete tests for `get_conversation_text` and `keyword_frequency`

### 11.4 Coverage Targets

- `format.ts`: > 90% (pure functions, fully testable)
- `message-tool.ts`: > 85% (factory)
- Each `fetch*` function: > 75% (cover the main branches)

No global coverage gate — MCP entry, client wrapper, and other low-risk code paths are not forced to pad numbers.

## 12. Future Work (out of scope)

- Integration tests against a live ChatLab instance or HTTP mock server
- `keyword_frequency` real implementation (char-level unigram / bigram counting; no jieba dependency)
- `order: 'asc' | 'desc'` parameter for `get_messages` to invert pagination semantics (currently page=1 = latest)
- Reply-chain field support in `RawMessage` (replyToMessageId / replyToContent) if a future tool needs it

## 13. Migration & Compatibility

- `get_conversation_text` removed cleanly. No deprecation period — MCP server is 0.x and has no stability commitments. Note in CHANGELOG; users migrate to `get_messages(format='text')`.
- `keyword_frequency` removed cleanly. README documents the three alternatives (desktop app / `execute_sql` with LIKE / `get_messages` + LLM-side counting).
- All other tools retain their names and core parameters; new shared params (`timezone`, `merge_consecutive`, `filter_invalid`) become available on tools that didn't have them before — this is additive, not breaking.

## 14. File Map

New files:
- `src/tools/message-tool.ts` — factory and shared param injection
- `tests/format.test.ts` — pure function tests
- `tests/message-tool.test.ts` — factory contract + convention enforcement

Modified files:
- `src/format.ts` — add `RawMessage` interface, export shared constants
- `src/tools/messages.ts` — convert to factory registration; split `fetchMessagesViaRest` + `fetchMessagesViaSql`
- `src/tools/conversation.ts` — delete `get_conversation_text`; convert `get_full_conversation` to thin wrapper
- `src/tools/analytics.ts` — convert 3 message tools to factory; delete `keyword_frequency` registration; remove inline `toLocaleString` calls
- `src/tools/stats.ts` — replace `formatStatsOverviewAsText` with `formatToolResultAsText`
- `src/tools/sessions.ts` / `src/tools/members.ts` — minor cleanup (keep bespoke list formatters)
- `src/tools/sql.ts` — description update only
- All corresponding `tests/tools/*.test.ts` files — update assertions

Deleted files: none (no source files become empty).

## 15. Open Questions

None at design time. All open trade-offs (delete-vs-deprecate, SQL fast path conditions, factory naming) were resolved in brainstorming with explicit user approval.
