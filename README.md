# Xilot

X（Twitter）記事をAIで翻訳・要約・チャットできるChrome拡張機能。

## 機能

- **AI翻訳** — X記事の全文を日本語にストリーミング翻訳（スケルトンUIで進捗表示）
- **スクロール連動** — ブラウザとサイドパネルのスクロールが自動同期
- **ホバーハイライト** — 原文にカーソルを合わせると翻訳側が対応ブロックをハイライト
- **AIチャット** — 記事の内容について質問・深掘りが可能（Markdownレンダリング対応）
- **クイックアクション** — ワンクリックで要約・キーポイント・実践Tips・インフォグラフィック画像生成
- **画像生成** — Codex app-serverのgpt-image-2で記事の概要画像を生成・ダウンロード
- **セッション管理** — 記事ごとにチャット履歴を自動保存・復元

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. ビルド

```bash
npm run build
```

### 3. Codex app-serverの起動

```bash
codex app-server --listen ws://127.0.0.1:4500
```

自動起動（macOS LaunchAgent）を設定する場合:

```bash
# LaunchAgentを配置（Codex app-server）
cp scripts/launchagents/com.xilot.codex-server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.xilot.codex-server.plist

# WSプロキシ（Chrome拡張のOrigin制限を回避）
cp scripts/launchagents/com.xilot.ws-proxy.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.xilot.ws-proxy.plist
```

### 4. Chrome拡張機能の読み込み

1. `chrome://extensions` を開く
2. 「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ `dist` フォルダを選択

## 使い方

1. X記事のページを開く（例: `x.com/user/status/...`）
2. Xilotアイコンをクリック → サイドパネルが開いて翻訳開始
3. 「チャット」タブで記事について質問
4. クイックアクションボタンで要約・画像生成

## アーキテクチャ

```
Chrome拡張機能                    Codex App Server (ローカル)
├─ Content Script                 ├─ ws://127.0.0.1:4500
│   └─ DOM読み取り + スクロール連動      └─ AI翻訳・チャット・画像生成
├─ Side Panel (翻訳 + チャットUI)
├─ Background Script              WS Proxy
│   └─ Codex通信                  └─ ws://127.0.0.1:4501 → :4500
└─ manifest.json (MV3)                (Origin制限回避)
```

## 技術スタック

- TypeScript + Vite
- Chrome Extension Manifest V3 (Side Panel API)
- Codex App Server (JSON-RPC 2.0 over WebSocket)
- gpt-image-2 (画像生成)
- marked (Markdownレンダリング)

## ライセンス

ISC
