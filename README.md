# Xilot（ザイロット）

X（Twitter）記事・投稿をAIで翻訳・要約・チャットできるChrome拡張機能。

Codex app-serverをバックエンドとして、記事や投稿の翻訳、AIチャット、インフォグラフィック画像生成をサイドパネルで提供します。

## 機能

- **AI翻訳** — X記事・投稿を日本語にストリーミング翻訳（スケルトンUI + プログレスバーで進捗表示）
- **スクロール連動** — 記事ではブラウザとサイドパネルのスクロールが自動同期。ホバーでハイライト
- **AIチャット** — 内容について質問・深掘りが可能（Markdownレンダリング対応）
- **クイックアクション** — ワンクリックで要約・キーポイント・実践Tips・インフォグラフィック画像生成
- **画像生成** — gpt-image-2で記事の概要画像を生成・ダウンロード
- **セッション管理** — 対象ごとにチャット履歴を自動保存・復元。新規チャット作成・セッション切り替え可能
- **ローカル保存** — 保存ボタンで原文・翻訳結果・投稿リンク・投稿画像・チャット履歴・生成画像をMac上の指定フォルダへ保存

## 前提条件

- **Node.js** v20以上
- **npm** v9以上
- **Google Chrome** v116以上（Side Panel API対応）
- **OpenAI Codex CLI** — ChatGPT Plus/Pro/Teamのアカウントが必要
  ```bash
  npm install -g @openai/codex
  codex auth login
  ```

## セットアップ

### 1. リポジトリをクローン

```bash
git clone https://github.com/Riku4230/xilot.git
cd xilot
```

### 2. 依存関係のインストール

```bash
npm install
```

### 3. ビルド

```bash
npm run build
```

`dist/` フォルダにChrome拡張機能がビルドされます。

### 4. Codex app-server + WSプロキシの起動

#### 方法A: 手動起動（動作確認用）

ターミナルを2つ開いて、それぞれ実行:

```bash
# ターミナル1: Codex app-server
codex app-server --listen ws://127.0.0.1:4500

# ターミナル2: WSプロキシ（認証付き）
node scripts/ws-proxy.mjs
```

WSプロキシの起動には認証トークンファイルが必要です:

```bash
# トークンファイルを生成（初回のみ）
openssl rand -hex 16 > ~/.codex/xilot-proxy-token
```

#### 方法B: 自動起動（macOS LaunchAgent）— 推奨

PC起動時に自動でCodex app-serverとWSプロキシが起動します。

```bash
# トークンファイルを生成（初回のみ）
openssl rand -hex 16 > ~/.codex/xilot-proxy-token
```

以下の2ファイルを `~/Library/LaunchAgents/` に配置:

**`com.xilot.codex-server.plist`** — Codex app-server用:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.xilot.codex-server</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js</string>
        <string>app-server</string>
        <string>--listen</string>
        <string>ws://127.0.0.1:4500</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/codex-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/codex-server.err</string>
</dict>
</plist>
```

**`com.xilot.ws-proxy.plist`** — WSプロキシ用:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.xilot.ws-proxy</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/path/to/xilot/scripts/ws-proxy.mjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/ws-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/ws-proxy.err</string>
</dict>
</plist>
```

> **注意:** `ws-proxy.mjs` のパスは実際のクローン先に合わせて変更してください。

登録:
```bash
launchctl load ~/Library/LaunchAgents/com.xilot.codex-server.plist
launchctl load ~/Library/LaunchAgents/com.xilot.ws-proxy.plist
```

動作確認:
```bash
curl -s http://127.0.0.1:4500/healthz  # → ok
curl -s http://127.0.0.1:4501/healthz  # → ok
```

### 5. Chrome拡張機能の読み込み

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. `dist` フォルダを選択

### 6. プロキシトークンの設定

拡張機能のService Workerコンソール（`chrome://extensions` → Xilot → 「Service Worker」リンク）で以下を実行:

```js
chrome.storage.local.set({ codexToken: "ここにトークンを貼り付け" })
```

トークンは `~/.codex/xilot-proxy-token` の内容です:
```bash
cat ~/.codex/xilot-proxy-token
```

> **注意:** 初回インストール時にデフォルトトークンが自動設定されますが、自分で生成したトークンに変更する場合はこの手順が必要です。

## 使い方

1. X記事または投稿ページを開く（例: `x.com/user/status/...` または `x.com/user/article/...`）
2. ツールバーのXilotアイコンをクリック → サイドパネルが開いて自動翻訳開始
3. 翻訳完了後、ブラウザのスクロールに連動してサイドパネルも追従
4. 「チャット」タブで内容について質問
5. クイックアクションボタン（📊概要画像 / 📝要約 / 🔑キーポイント / 💡実践Tips）でワンクリック分析
6. 「保存」タブで保存先を確認し、「保存」をクリックしてローカルへ書き出し

## ローカル保存

「保存」タブから現在の記事または投稿をMac上のフォルダに保存できます。初期保存先は `~/xilot` です。

保存先は「保存」タブの入力欄で変更できます。`~` はMacユーザーのホームディレクトリとして扱われます。安全のため、保存先はホームディレクトリ配下のみ指定できます。

保存形式:

```text
~/xilot/
  article/
    <記事ID>/
      original.md
      translation.md
      metadata.json
      links.json
  post/
    <投稿ID>/
      original.md
      translation.md
      metadata.json
      links.json
      media.json
      images/
        media-001.jpg
      session/
        <sessionId>/
          chat.md
          session.json
          images/
            image-001.png
  session/
    <記事ID>/
      <sessionId>/
        chat.md
        session.json
        images/
          image-001.png
```

「保存専用モード」をONにすると、チャットタブを閉じて保存タブ中心の操作に切り替わります。

## アーキテクチャ

```
┌──────────────────────────────────────────┐
│  Chrome ブラウザ                           │
│                                           │
│  X記事ページ ◄──► Side Panel (翻訳+チャット) │
│  (Content Script)    (sidepanel.js)       │
│        │                    │             │
│        └──► Background Script ◄──┘        │
│                    │                      │
└────────────────────┼──────────────────────┘
                     │ WebSocket
          ┌──────────▼──────────┐
          │  WS Proxy (:4501)   │ ← トークン認証
          └──────────┬──────────┘
          ┌──────────▼──────────┐
          │ Codex App Server    │ ← GPT-5.x / gpt-image-2
          │     (:4500)         │
          └─────────────────────┘
```

## 技術スタック

- **TypeScript + Vite** — ビルド・バンドル
- **Chrome Extension Manifest V3** — Side Panel API, Scripting API
- **Codex App Server** — JSON-RPC 2.0 over WebSocket
- **gpt-image-2** — インフォグラフィック画像生成
- **marked** — Markdownレンダリング

## トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| 「Codex app-serverに接続できません」 | サーバーが起動していない | `curl http://127.0.0.1:4500/healthz` で確認。okが返らなければ再起動 |
| 「ページとの通信に失敗しました」 | Content Scriptが未注入 | ページをリロード、または拡張機能を更新 |
| 403エラー（WSプロキシ） | トークン不一致 | `~/.codex/xilot-proxy-token` と `chrome.storage.local` の値を確認 |
| 画像が表示されない | Codexのレート制限 | しばらく待ってから再試行 |
| スクロールが勝手に戻る | 自動同期が干渉 | 手動スクロール後3秒間は自動同期が停止します |

## 停止・アンインストール

```bash
# LaunchAgentの停止
launchctl unload ~/Library/LaunchAgents/com.xilot.codex-server.plist
launchctl unload ~/Library/LaunchAgents/com.xilot.ws-proxy.plist

# LaunchAgentファイルの削除
rm ~/Library/LaunchAgents/com.xilot.codex-server.plist
rm ~/Library/LaunchAgents/com.xilot.ws-proxy.plist

# トークンファイルの削除
rm ~/.codex/xilot-proxy-token
```

Chrome拡張は `chrome://extensions` から削除できます。

## ライセンス

ISC
