# chatlab-mcp

**[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)**

[ChatLab](https://github.com/hellodigua/ChatLab) を AI アシスタント（Claude Desktop、Cursor、カスタムエージェント）に接続する MCP サーバーです。自然言語でローカルのチャット履歴を検索できます。

> ChatLab v0.17.2 に対応

## 必要条件

- [ChatLab](https://github.com/hellodigua/ChatLab) がインストール済みで起動していること
- ChatLab の設定 → API で API を有効化し、トークンを生成していること
- Node.js 18+

## インストール

### npx（推奨）

インストール不要。AI クライアントに直接設定します：

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

### ソースからインストール

```bash
git clone https://github.com/gamesme/chatlab-mcp
cd chatlab-mcp
npm install && npm run build
```

## Claude Desktop の設定

`~/Library/Application Support/Claude/claude_desktop_config.json` を編集します：

**npx を使用：**
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

**ソースを使用（バージョン問題を避けるため Homebrew の node パスを指定推奨）：**
```json
{
  "mcpServers": {
    "chatlab": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/絶対パス/chatlab-mcp/dist/index.js"],
      "env": {
        "CHATLAB_TOKEN": "clb_xxxxxxxxxxxx",
        "CHATLAB_URL": "http://127.0.0.1:5200"
      }
    }
  }
}
```

保存後、Claude Desktop を再起動するとツール一覧に `chatlab` ツールが表示されます。

## ツール一覧

| ツール | 説明 |
|--------|------|
| `list_sessions` | インポート済みのセッション一覧（名前・プラットフォーム・メッセージ数） |
| `get_session` | ID を指定して単一セッションの詳細を取得 |
| `get_messages` | メッセージ取得。キーワード・時間範囲・送信者でフィルタ可能、ページネーション対応（1回最大100件） |
| `get_members` | セッションの全メンバーとメッセージ数を取得 |
| `get_stats_overview` | 統計概要：メッセージ数・メンバー活動・メッセージ種別分布・期間 |
| `execute_sql` | セッション DB に対して集計クエリ（COUNT/GROUP BY）を実行 |

### 注意事項

- `get_messages` は1回最大100件を返します。`page` パラメータでページネーションできます。残りがある場合はレスポンスに `has_more` と `hint` が含まれます。
- `execute_sql` は統計集計専用です（単語頻度・活動分析・メンバー間のやり取りなど）。メッセージ内容の取得には `get_messages` を使用してください。
- アバター・バイナリフィールドはサーバー側で自動的に除去され、コンテキスト消費を抑えます。

## CLI オプション

```bash
node dist/index.js --token <token> --url <url>
# または環境変数で指定
CHATLAB_TOKEN=clb_xxx CHATLAB_URL=http://127.0.0.1:5200 node dist/index.js
```

`CHATLAB_URL` のデフォルトは `http://127.0.0.1:5200` です。

## 開発

```bash
npm test             # 全テストを実行
npm run test:watch   # ウォッチモード
npm run dev          # ts-node で直接実行（ビルド不要）
npm run build        # TypeScript をコンパイル → dist/
```
