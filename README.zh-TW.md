# chatlab-mcp

**[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)**

將 [ChatLab](https://github.com/hellodigua/ChatLab) 接入 AI 助手（Claude Desktop、Cursor、自訂 Agent）的 MCP 伺服器。用自然語言查詢本地聊天記錄。

> 跟隨 ChatLab v0.17.2

## 前置需求

- 已安裝並執行 [ChatLab](https://github.com/hellodigua/ChatLab)
- 在 ChatLab 設定 → API 中啟用 API 並產生 Token
- Node.js 18+

## 安裝

### npx（推薦）

無需安裝，直接設定 AI 客戶端：

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

### 從原始碼安裝

```bash
git clone https://github.com/gamesme/chatlab-mcp
cd chatlab-mcp
npm install && npm run build
```

## Claude Desktop 設定

編輯 `~/Library/Application Support/Claude/claude_desktop_config.json`：

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

**使用原始碼（建議指定 Homebrew 的 node 路徑以避免版本問題）：**
```json
{
  "mcpServers": {
    "chatlab": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/絕對路徑/chatlab-mcp/dist/index.js"],
      "env": {
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx",
        "CHATLAB_URL": "http://127.0.0.1:5200"
      }
    }
  }
}
```

儲存後重新啟動 Claude Desktop，工具清單中將出現 `chatlab` 相關工具。

## 工具清單

| 工具 | 說明 |
|------|------|
| `list_sessions` | 列出所有已匯入的會話（名稱、平台、訊息數） |
| `get_session` | 根據 ID 取得單一會話詳情 |
| `get_messages` | 取得訊息，支援關鍵字、時間範圍、發送者篩選與分頁（每次最多 100 則） |
| `get_members` | 取得會話中的所有成員及其訊息數 |
| `get_stats_overview` | 統計概覽：訊息數、成員活躍度、訊息類型分佈、時間範圍 |
| `execute_sql` | 對會話資料庫執行聚合查詢（COUNT/GROUP BY） |

### 注意事項

- `get_messages` 每次最多回傳 100 則，使用 `page` 參數翻頁。有更多結果時回應中會包含 `has_more` 與 `hint` 提示。
- `execute_sql` 僅用於統計聚合（詞頻、活躍分析、成員互動等），讀取訊息內容請使用 `get_messages`。
- 所有頭像/二進位欄位已在伺服器端自動移除，減少 Context 佔用。

## CLI 參數

```bash
node dist/index.js --token <token> --url <url>
# 或透過環境變數
CHATLAB_TOKEN=clb_xxx CHATLAB_URL=http://127.0.0.1:5200 node dist/index.js
```

`CHATLAB_URL` 預設為 `http://127.0.0.1:5200`。

## 開發

```bash
npm test             # 執行所有測試
npm run test:watch   # 監聽模式
npm run dev          # 使用 ts-node 直接執行（無需編譯）
npm run build        # 編譯 TypeScript → dist/
```
