# chatlab-mcp

**[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)**

将 [ChatLab](https://github.com/hellodigua/ChatLab) 接入 AI 助手（Claude Desktop、Cursor、自定义 Agent）的 MCP 服务器。用自然语言查询本地聊天记录。

> 跟随 ChatLab v0.19.0

## 前置要求

- 已安装并运行 [ChatLab](https://github.com/hellodigua/ChatLab)
- 在 ChatLab 设置 → API 中启用 API 并生成 Token
- Node.js 18+

## 安装

### npx（推荐）

无需安装，直接配置 AI 客户端：

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

### 从源码安装

```bash
git clone https://github.com/gamesme/chatlab-mcp
cd chatlab-mcp
npm install && npm run build
```

## Claude Desktop 配置

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

**使用 npx：**
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

**使用源码（建议指定 Homebrew 的 node 路径以避免版本问题）：**
```json
{
  "mcpServers": {
    "chatlab": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/绝对路径/chatlab-mcp/dist/index.js"],
      "env": {
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx",
        "CHATLAB_URL": "http://127.0.0.1:5200"
      }
    }
  }
}
```

保存后重启 Claude Desktop，工具列表中将出现 `chatlab` 相关工具。

## 工具列表

### 核心 (6 个)
| 工具 | 说明 |
|------|------|
| `list_sessions` | 列出所有已导入的会话（名称、平台、消息数） |
| `get_session` | 根据 ID 获取单个会话详情 |
| `get_messages` | 获取消息，支持关键词、时间范围、发送者过滤和分页（每次最多 100 条） |
| `get_members` | 获取会话中的所有成员及其消息数 |
| `get_stats_overview` | 统计概览：消息数、成员活跃度、消息类型分布、时间范围 |
| `execute_sql` | 对会话数据库执行聚合查询（COUNT/GROUP BY） |

### 分析 (v0.19.0+，9 个)
| 工具 | 说明 |
|------|------|
| `get_message_context` | 获取目标消息前后 N 条上下文 |
| `get_conversation_between` | 两个成员之间的对话（按时间交错） |
| `get_session_summaries` | AI 生成的子会话摘要（来自 chat_session 表） |
| `deep_search_messages` | FTS5 全文搜索，附带上下文窗口 |
| `get_time_stats` | 小时/工作日/日分布（支持时区） |
| `get_member_activity` | 按消息数排名的活跃成员（含占比） |
| `get_member_name_history` | 成员历史昵称/账号名变更记录 |
| `get_response_time_analysis` | 成员对的回复间隔（LAG 窗口函数） |
| `keyword_frequency` | 占位实现（NLP 分词未打包，返回替代方案提示） |

### 注意事项

- `get_messages` 每次最多返回 100 条，使用 `page` 参数翻页。有更多结果时响应中会包含 `has_more` 和 `hint` 提示。
- `execute_sql` 仅用于统计聚合，读取消息内容请使用 `get_messages` 或 `get_message_context`。
- 分析类工具通过同一 `/sql` 接口下发自己的 SQL（不再注入 200 行 LIMIT）。
- 所有头像/二进制字段已在服务端自动剥离，减少上下文占用。

## CLI 参数

```bash
node dist/index.js --token <token> --url <url>
# 或通过环境变量
CHATLAB_TOKEN=clb_xxx CHATLAB_URL=http://127.0.0.1:5200 node dist/index.js
```

`CHATLAB_URL` 默认为 `http://127.0.0.1:5200`。

## 开发

```bash
npm test             # 运行所有测试
npm run test:watch   # 监听模式
npm run dev          # 使用 ts-node 直接运行（无需编译）
npm run build        # 编译 TypeScript → dist/
```
