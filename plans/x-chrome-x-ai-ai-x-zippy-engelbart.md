# X記事翻訳Chrome拡張機能 - 実装プラン

## Context

X（Twitter）の記事（Articles）機能で公開された長文コンテンツには、現在翻訳機能がない。Chrome拡張機能でサイドパネルに翻訳結果を表示し、元記事とスクロール連動させることで、快適な翻訳体験を提供したい。

**運用モデル**: ユーザー各自のCodex app-server（ChatGPT Plus/Pro等）を利用。拡張機能自体は無料配布。

**対象記事例**: https://x.com/eng_khairallah1/status/2047609433489035739

---

## リサーチ結果まとめ

### X記事のDOM構造（確定情報）

X記事はDraft.jsベースのリッチテキストエディタで構築されている。以下のセレクタが確認済み:

| 要素 | セレクタ |
|------|---------|
| 記事タイトル | `[data-testid="twitter-article-title"]` |
| ツイートコンテナ | `[data-testid="tweet"]` |
| ユーザー名 | `[data-testid="User-Name"]` |
| コンテンツブロック | `[class*="longform-"]` |
| テキスト本体 | `span[data-text="true"]` |
| タイムスタンプ | `<time>` 要素 |

**コンテンツブロックの種類**（classに含まれる識別子）:
- `longform-header-one` — 見出し
- `longform-blockquote` — 引用
- `longform-list-item` — リストアイテム
- その他: 段落、太字・斜体のスタイル属性

**URLパターン**: `x.com/*/status/*` または `x.com/*/article/*`

**重複排除**: `offset-key` 属性で重複コンテンツを識別可能

### Codex App Server の仕様

- **通信**: JSON-RPC 2.0（stdio / WebSocket / Unix socket）
- **主要プリミティブ**: Threads（会話）、Turns（やりとり）、Items（メッセージ・コマンド・ファイル編集）
- **API**: 80以上のメソッド（スレッド管理、ターン制御、シェル実行、ファイル操作、MCPサーバー統合）
- **ブラウザ機能**: Browser pluginを有効にすると、Codexがブラウザを操作可能（click, type, inspect DOM, screenshots）
- **制限**: ログイン不要の公開ページのみ対応（X記事は公開コンテンツなので問題なし）
- **認証**: WebSocket接続にBearer token / HMAC-signed JWT対応
- **ローカルデーモン**: ユーザーのマシン上で動作

---

## アーキテクチャ

```
[Chrome拡張機能]                    [Codex App Server (ユーザーのローカル)]
  ├─ Content Script                    ├─ JSON-RPC API (WebSocket)
  │   └─ DOM読み取り（方式A）           ├─ Browser Plugin
  ├─ Side Panel (翻訳UI)               │   └─ X記事ページを開いてDOM抽出（方式B）
  ├─ Background Script                 └─ AI翻訳（OpenAI API経由）
  │   └─ Codex app-serverと通信
  └─ Popup (設定画面)
```

---

## テキスト抽出: 2つのアプローチ

### 方式A: DOM直接読み取り（Content Script）— デフォルト

**仕組み**: Chrome拡張のContent Scriptが、X記事ページのDOMから直接テキストを抽出

**手順**:
1. Content Scriptが `x.com/*/status/*` or `x.com/*/article/*` にマッチするページに挿入
2. `[data-testid="twitter-article-title"]` の存在で記事ページかを判定
3. `[class*="longform-"]` でコンテンツブロックを列挙
4. 各ブロック内の `span[data-text="true"]` からテキスト抽出
5. `offset-key` 属性で重複排除
6. ブロックタイプ（header-one, blockquote, list-item等）を構造情報として保持
7. 各ブロックにDOM要素参照を保持（スクロール連動用）
8. Background Script経由でCodex app-serverに翻訳リクエスト送信

**メリット**:
- レスポンスが速い（DOM読み取りは即座）
- 外部サービス依存なし
- 各DOM要素への参照を直接持てるのでスクロール連動が容易

**デメリット**:
- XのDOM構造変更で壊れるリスク（ただしdata-testidは比較的安定）
- SPAの動的レンダリングへの対応が必要（MutationObserver）

### 方式B: Codex Browser Use（サーバーサイド）— フォールバック

**仕組み**: Codex app-serverのBrowser pluginでX記事ページを開き、AIがDOMを解析してテキスト抽出

**手順**:
1. Chrome拡張が現在のX記事URLをCodex app-serverに送信
2. Codex app-serverのBrowser pluginがそのURLを開く
3. CodexのAIがページのDOM状態を inspect し、記事テキストを構造化抽出
4. 抽出テキストをAIで翻訳
5. 結果をChrome拡張のSide Panelに返す

**メリット**:
- AIが適応的にテキスト抽出するため、DOM構造変更に強い
- Content Scriptのメンテナンスが不要
- テキスト抽出と翻訳を1ステップで実行可能

**デメリット**:
- レスポンスが遅い（ブラウザ起動+ページレンダリング+AI解析で5-15秒）
- スクロール連動用の段落位置マッピングが間接的になる
- Codex app-serverがローカルで起動している必要がある

### 推奨: ハイブリッド方式

- **デフォルト**: 方式A（DOM直接読み取り）→ 高速＆スクロール連動対応
- **フォールバック**: 方式Aが失敗（セレクタ不一致等）→ 方式B（Codex Browser Use）
- **翻訳**: どちらの方式でもCodex app-server経由でAI翻訳

---

## 実装ステップ

### Step 1: プロジェクト初期セットアップ
- Manifest V3 Chrome拡張の雛形作成
- TypeScript + Vite（またはCRXJS）でビルド環境構築
- ディレクトリ構成:
  ```
  src/
    manifest.json
    background/        # Service Worker
    content/           # Content Script（DOM読み取り）
    sidepanel/         # Side Panel UI（翻訳表示）
    popup/             # 設定画面（Codex接続設定）
    lib/               # 共通ユーティリティ
  ```
- manifest.jsonに必要な権限設定:
  - `"sidePanel"` permission
  - `"activeTab"` permission
  - content_scripts: `matches: ["*://x.com/*", "*://twitter.com/*"]`

### Step 2: X記事DOM構造の実地確認
- 共有されたURL（https://x.com/eng_khairallah1/status/2047609433489035739）をDevToolsで調査
- リサーチで判明したセレクタ（`twitter-article-title`, `longform-*`, `data-text="true"`）の実地検証
- 段落・見出し・画像・コードブロックなどの完全マッピング
- エッジケース確認（埋め込みツイート、画像、動画、LaTeX等）

### Step 3: Content Script — テキスト抽出エンジン（方式A）
- X記事ページの検出: `[data-testid="twitter-article-title"]` の存在チェック
- テキスト抽出:
  - `[class*="longform-"]` でブロック列挙
  - `span[data-text="true"]` でテキスト取得
  - `offset-key` で重複排除
  - ブロックタイプの判定（見出し/段落/引用/リスト）
- 構造化データ生成: `{ blockId, type, text, domElement }[]`
- MutationObserverでSPAナビゲーション対応

### Step 4: Side Panel UI
- 状態遷移: 初期画面 → ローディング → 翻訳結果表示
- 翻訳結果を段落ごとに表示（元のブロック構造を保持）
- Xのデザインに合わせたスタイリング

### Step 5: Codex App Server 連携
- ローカルCodex app-serverへのWebSocket接続
- 接続設定UI（ポート番号等をPopupで設定可能に）
- JSON-RPC 2.0プロトコルで翻訳リクエスト/レスポンス
- Browser Use フォールバック（方式B）の実装
  - Codex app-serverにURL送信 → Browser pluginで開く → AI抽出+翻訳

### Step 6: スクロール連動
- Content Script: IntersectionObserver で現在表示中のブロックを検出
- Message passing: `chrome.runtime.sendMessage` で表示ブロックIDをSide Panelに通知
- Side Panel: 対応する翻訳ブロックまでsmoothスクロール
- 逆方向: Side Panelのスクロールに元ページが追従するオプション

---

## 検証方法

1. **DOM抽出テスト**: 共有されたX記事URL（https://x.com/eng_khairallah1/status/2047609433489035739）でContent Scriptを実行し、全テキストブロックが正しく抽出できるか確認
2. **翻訳テスト**: 抽出テキストをCodex app-server経由で翻訳し、日本語の品質を確認
3. **スクロール連動テスト**: 元記事をスクロールした際にSide Panelが追従するか確認
4. **フォールバックテスト**: DOM抽出が失敗した場合にBrowser Useに切り替わるか確認
5. **複数記事テスト**: 異なる著者・異なる構成（画像多め、コードブロック含む等）の記事で動作確認

---

## 参考リソース

- [X Article to Markdown (Tampermonkey script)](https://gist.github.com/geekjourneyx/8129f7ae7ffd586b351222c2d124acdc) — DOM抽出の実装参考
- [Apify X Article to Markdown](https://apify.com/fastcrawler/x-twitter-article-to-markdown) — Draft.js形式の解析参考
- [Chrome sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) — Side Panel実装
- [Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) — JSON-RPC API仕様
- [Codex In-App Browser](https://developers.openai.com/codex/app/browser) — Browser Use機能
