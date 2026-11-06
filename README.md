# note-cli

note.com を**非公式 API** で操作する CLI と、Claude Code / Codex 用の skills です。ローカルのエージェントから使うことを前提に、出力はすべて JSON です。

- 下書き保存（Markdown → note の HTML へ変換。**公開はしません**）
- 記事検索・ハッシュタグ・クリエイターの記事一覧・本文取得
- 分析（スキ数の分布、有料比率、タイトルの特徴、投稿曜日・時間帯、上位著者・記事）
- 自分の PV 統計

> ⚠️ note.com の公式 API ではありません。仕様は予告なく変わる可能性があります。利用規約の範囲内で、低頻度の個人利用に留めてください。

参考: [shimayuz/note-com-mcp](https://github.com/shimayuz/note-com-mcp) / [note 非公式 API を徹底調査](https://note.com/marie_222/n/n6a10366298b0)

## インストール

Node.js 23.6 以上が必要です（TypeScript をビルドせずに直接実行します）。

```bash
scripts/install.sh
```

このスクリプトは次の 2 つを行います。

- `npm link` で `note-cli` コマンドを PATH に入れる
- このリポジトリを Claude Code のプラグインマーケットプレイスとして登録し、`note-cli` プラグインをインストールする

Claude Code で手動インストールする場合:

```bash
claude plugin marketplace add /path/to/note-cli   # または shoot16625/note-cli
claude plugin install note-cli@note-cli
```

Codex では `~/.codex/config.toml` に次を追加します。

```toml
[marketplaces.note-cli]
source_type = "local"
source = "/path/to/note-cli"

[plugins."note-cli@note-cli"]
enabled = true
```

## ログイン

2026-05 以降、email とパスワードによるログイン API には reCAPTCHA が必要になったため、ブラウザで手動ログインして Cookie を保存する方式にしています。

```bash
note-cli auth login                 # Chrome が開く → 手動でログイン → Cookie を保存
note-cli auth login --channel msedge
note-cli auth import --cookie '_note_session_v5=...; XSRF-TOKEN=...'   # DevTools から Cookie ヘッダをコピーして登録
note-cli auth status
note-cli auth logout
```

セッションは `~/.config/note-cli/session.json`（パーミッション 0600）に保存されます。環境変数 `NOTE_COOKIE` を指定すると、保存済みのセッションより優先されます。

## コマンド

```bash
# 下書き
note-cli draft create article.md [--title T] [--dry-run]
note-cli draft update <id|key|url> article.md
note-cli draft get <key|url> [--html]
note-cli draft list [--page N] [--status draft|published]
note-cli draft delete <id|key|url> --yes

# 検索・閲覧（ログイン不要）
note-cli search "<query>" [--sort popular|hot|new] [--limit N] [--start N]
note-cli hashtag <tag> [--order popular|hot|new] [--limit N] [--paid-only]
note-cli user <urlname> [--limit N]
note-cli note <key|url> [--html]

# 分析
note-cli analyze search "<query>" [--sort ...] [--limit 100] [--top 10]
note-cli analyze hashtag <tag> [--order ...] [--limit 100]
note-cli analyze user <urlname> [--limit 100]
note-cli stats pv [--filter all|daily|weekly|monthly] [--sort pv|like|comment] [--page N]   # 要ログイン
```

エラーは stderr に `{"error": {"code", "message", ...}}` の形で出力されます。終了コードはエラー時 1、使い方の誤りで 2 です。

### Markdown 変換ルール

| Markdown | note |
|---|---|
| `#` / `##` | 大見出し |
| `###` | 小見出し |
| `####` 以下 | 太字の段落 |
| 段落内の改行 | 改行（`<br>`） |
| リスト・引用・コード・リンク・太字・取り消し線・区切り線 | そのまま |
| 画像 | **未対応**（リンクに置き換え、warning を出力） |
| 表 | **未対応**（コードブロックに置き換え、warning を出力） |

タイトルは frontmatter の `title:`、本文先頭の `# 見出し`、`--title` のいずれかから取ります。

### 環境変数

| 変数 | 用途 |
|---|---|
| `NOTE_COOKIE` | Cookie ヘッダ文字列。保存済みのセッションより優先 |
| `NOTE_CLI_HOME` | セッションの保存先ディレクトリ |
| `NOTE_CLI_INTERVAL_MS` | リクエストの最小間隔（既定 500ms） |
| `NOTE_CLI_DEBUG` | リクエスト URL を stderr に出力 |

## Skills（`note-cli` プラグイン）

| skill | 用途 |
|---|---|
| `note-cli:draft` | Markdown 記事を下書き保存・更新・読み戻し |
| `note-cli:research` | 検索、ハッシュタグ、競合クリエイターの分析 |
| `note-cli:my-stats` | 自分の PV・スキ・コメントの振り返り |

プラグインの定義は `.claude-plugin/`（Claude Code）と `.codex-plugin/`・`.agents/plugins/`（Codex）にあります。

## 未対応（今後の候補）

- 画像アップロード（本文・見出し画像）
- 公開・予約投稿、ハッシュタグ・価格の設定（`PUT /api/v1/text_notes/{id}`）
- GraphQL ダッシュボード（インプレッション・流入元）

## 開発

```bash
npm run check   # 型チェック + テスト
```
