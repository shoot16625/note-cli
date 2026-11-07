# note-cli

[note.com](https://note.com) の**非公式** API を使った CLI とエージェント用プラグインです。Claude Code、Codex、Cursor、Gemini CLI などの AI コーディングエージェントから操作することを想定しています。すべてのコマンドは JSON を出力します。

- **下書き**: Markdown（Obsidian 記法にも対応）を note のエディタ用 HTML に変換して下書き保存します。ローカル画像とアイキャッチもアップロードします。アイキャッチは「みんなのフォトギャラリー」から選ぶこともできます。1行だけの URL は埋め込み（YouTube、X、note 記事、リンクカードなど）に、ローカルファイルへのリンクは添付ファイルになります。
- **公開**: ハッシュタグ、価格と有料エリア、目次、マガジン、メンバーシッププランを指定して公開します。予約投稿、非公開化、削除もできます。
- **交流**: スキ、コメント、フォロー、自分のマガジンへの記事追加、通知とメンバーシップの確認ができます。
- **リサーチ**: 記事・クリエイター・マガジン・ハッシュタグの検索、ハッシュタグ・カテゴリ・マガジン・コンテストの閲覧、記事本文・スキ・コメントの取得ができます。
- **分析**: スキ数の分布、有料記事の割合、タイトルの傾向、投稿曜日・時間帯、上位の著者と記事を集計します。
- **自分の数字**: ダッシュボードの数字（ビュー、インプレッション、スキ、コメント、売上）を、合計・記事ごと・推移・流入元別に確認できます。

> ⚠️ note.com の公式 API ではありません。予告なく動かなくなる可能性があります。個人的な用途で少量の利用にとどめ、note.com の利用規約に従ってください。

参考: [shimayuz/note-com-mcp](https://github.com/shimayuz/note-com-mcp)、[note 非公式 API を徹底調査](https://note.com/marie_222/n/n6a10366298b0)

## インストール

プラグインには依存パッケージのない単一ファイルの CLI（`dist/note-cli.js`）が同梱されています。必要なのは [Bun](https://bun.sh) 1.2 以降だけです。

```bash
curl -fsSL https://bun.sh/install | bash
```

インストール方法はエージェントごとに異なります。複数のエージェントを使う場合は、それぞれにインストールしてください。

| エージェント | インストール |
|---|---|
| [Claude Code](#claude-code) | `/plugin marketplace add shoot16625/note-cli` |
| [Codex](#codex) | `codex plugin marketplace add shoot16625/note-cli` |
| [Cursor](#cursor) | このリポジトリから `/add-plugin` |
| [Gemini CLI](#gemini-cli) | `gemini extensions install https://github.com/shoot16625/note-cli` |
| [GitHub Copilot CLI](#github-copilot-cli) | `copilot plugin marketplace add shoot16625/note-cli` |
| [Factory Droid](#factory-droid) | `droid plugin marketplace add https://github.com/shoot16625/note-cli` |
| [Qwen Code](#qwen-code) | `qwen extensions install shoot16625/note-cli` |
| [Devin CLI](#devin-cli) | `devin plugins install shoot16625/note-cli` |
| [Kimi Code](#kimi-code) | `/plugins install https://github.com/shoot16625/note-cli` |
| [Antigravity](#antigravity) | `agy plugin install https://github.com/shoot16625/note-cli` |
| [Pi](#pi) | `pi install git:github.com/shoot16625/note-cli` |
| [その他](#その他のエージェントopencodewindsurfcline-など) | `npx skills add shoot16625/note-cli` |

### Claude Code

```text
/plugin marketplace add shoot16625/note-cli
/plugin install note-cli@note-cli
```

更新するときは、マーケットプレイスを更新してからプラグインを更新します。

```bash
claude plugin marketplace update note-cli
claude plugin update note-cli@note-cli
```

セッション内では `/plugin marketplace update note-cli` を実行してから、`/plugin` → Installed → note-cli → **Update now** を選びます。更新後は `/reload-plugins` を実行するか、新しいセッションを始めると反映されます。`/plugin` → Marketplaces → note-cli → **Enable auto-update** で自動更新をオンにすることもできます（サードパーティのマーケットプレイスは最初はオフです）。

### Codex

```bash
codex plugin marketplace add shoot16625/note-cli
```

続けて `/plugins`（CLI）またはサイドバーの **Plugins**（アプリ）を開き、**note-cli** をインストールします。

### Cursor

Cursor の Agent チャットで次を実行します。

```text
/add-plugin https://github.com/shoot16625/note-cli
```

### Gemini CLI

```bash
gemini extensions install https://github.com/shoot16625/note-cli
gemini extensions update note-cli   # 更新するとき
```

### GitHub Copilot CLI

```bash
copilot plugin marketplace add shoot16625/note-cli
copilot plugin install note-cli@note-cli
```

### Factory Droid

```bash
droid plugin marketplace add https://github.com/shoot16625/note-cli
droid plugin install note-cli@note-cli
```

### Qwen Code

Qwen Code は Claude Code のマーケットプレイスから直接プラグインをインストールできます。選択を求められたら `note-cli` を選んでください。

```bash
qwen extensions install shoot16625/note-cli
qwen extensions update note-cli   # 更新するとき
```

### Devin CLI

```bash
devin plugins install shoot16625/note-cli
devin plugins update note-cli   # 更新するとき
```

### Kimi Code

```text
/plugins install https://github.com/shoot16625/note-cli
```

### Antigravity

```bash
agy plugin install https://github.com/shoot16625/note-cli
```

更新するときは同じコマンドで再インストールします。

### Pi

```bash
pi install git:github.com/shoot16625/note-cli
```

### その他のエージェント（OpenCode、Windsurf、Cline など）

`SKILL.md` 形式のスキルを読み込めるエージェントなら、[`skills`](https://github.com/vercel-labs/skills) CLI でインストールできます。どのエージェントに入れるかは対話的に選べます。

```bash
npx skills add shoot16625/note-cli
```

この方法ではスキルだけがコピーされ、同梱の CLI は入りません。CLI も別途インストールしてください（初回利用時にスキルがインストールを提案します）。

```bash
bun add -g github:shoot16625/note-cli
```

### CLI のみ（任意）

シェルから `note-cli` を直接使う場合:

```bash
bun add -g github:shoot16625/note-cli
```

## スキル

| スキル | できること |
|---|---|
| `note-cli:draft` | Markdown の下書きを保存・更新・取得 |
| `note-cli:publish` | 記事の公開・予約投稿・非公開化・削除、マガジン管理 |
| `note-cli:engage` | スキ、コメント、フォロー、通知とメンバーシップ |
| `note-cli:research` | 記事・ハッシュタグ・クリエイターの検索と分析 |
| `note-cli:my-stats` | ダッシュボードの確認（ビュー、インプレッション、スキ、売上、流入元） |

使用例:「`post.md` を note に下書き保存して」「ハッシュタグ AI と ClaudeCode を付けて公開して」「Claude Code についての note 記事で、スキが多いのはどんな記事？」

## ログイン

2026 年 5 月以降、note のメールアドレス・パスワードによるログイン API には reCAPTCHA が必要になりました。そのため note-cli は実際のブラウザを開き、手動でログインしてもらう方式を取っています。

```bash
note-cli auth login                  # Chrome/Edge/Chromium でログインページを開くので、そこでログインする
note-cli auth login --browser "/path/to/chrome"
note-cli auth import --cookie '_note_session_v5=...; XSRF-TOKEN=...'   # DevTools からコピーした Cookie ヘッダー、または _note_session_v5 の値だけ
note-cli auth status
note-cli auth logout
```

`auth login` は使い捨てのブラウザプロファイルを使い、Chrome DevTools Protocol 経由で Cookie を読み取ります。普段使っているブラウザのプロファイルには一切触れません。

セッションは `~/.config/note-cli/session.json` にパーミッション 0600 で保存されます。環境変数 `NOTE_COOKIE` を設定すると、保存済みのセッションより優先されます。

下書きを作成するには、note アカウントのメールアドレス認証が済んでいる必要があります。

## コマンド

```bash
# 下書き（ログインが必要）
note-cli draft create article.md [--title T] [--eyecatch cover.png] [--no-embed] [--dry-run]
note-cli draft update <key|url> article.md [--eyecatch cover.png] [--no-embed]
note-cli draft get <key|url> [--html] [--max-chars N]
note-cli draft list [--page N] [--status draft|published]
note-cli draft delete <id|key|url> --yes
note-cli photo search [キーワード] [--public-domain] [--limit N] [--page N]   # みんなのフォトギャラリー

# 公開（ログインが必要。一時的にブラウザが開きます。後述）
note-cli publish <key|url> [article.md] --yes [--hashtag T]... [--price YEN] [--refund] [--magazine KEY]... \
    [--membership all|none|PLAN]... [--toc] [--disable-comments] [--no-notify] [--hide-from-profile] \
    [--schedule 2026-12-01T09:00+09:00] [--eyecatch cover.png] [--dry-run]
note-cli reserved                               # 予約投稿中の記事
note-cli unpublish <key|url> --yes              # 下書きに戻す（予約投稿の取り消しにも使える）
note-cli delete <key|url> --yes                 # 削除（公開中の記事は先に非公開化される）
note-cli magazines [--note <key>]               # 自分のマガジン
note-cli magazine add|remove <magazineKey> <noteKey>

# 交流（ログインが必要）
note-cli like|unlike <key|url>
note-cli comment <key|url> "text" [--reply-to <commentKey>]
note-cli comment delete <key|url> <commentKey> --yes
note-cli follow|unfollow <urlname>
note-cli notices                                # 未読数
note-cli membership plans|joined

# リサーチ（ログイン不要）
note-cli search "<query>" [--type note|user|magazine|hashtag] [--sort popular|hot|new] [--limit N] [--start N]
note-cli hashtag <tag> [--order popular|hot|new] [--limit N] [--paid-only]   # 記事数と関連タグも返す
note-cli user <urlname> [--limit N]
note-cli note <key|url> [--html] [--max-chars N]
note-cli likes <key|url> [--limit N]            # 記事にスキしたユーザー
note-cli comments <key|url> [--limit N]         # トップレベルのコメントと返信数
note-cli magazine <key|url> [--limit N]         # マガジンの詳細と収録記事
note-cli categories                             # カテゴリの slug 一覧
note-cli category <slug> [--sort new|trend] [--limit N]   # `featured` は note 編集部のおすすめ
note-cli contests [--state opened|closed|finished|all] [--type contest|theme|all] [--limit N]

# 分析
note-cli analyze search "<query>" [--sort ...] [--limit 100] [--top 10]
note-cli analyze hashtag <tag> [--order ...] [--limit 100]
note-cli analyze user <urlname> [--limit 100]
note-cli stats dashboard [--period 7d|28d|365d|all|this-month|last-month|custom] [--from D --to D] \
    [--order pv|impressions|likes|comments|sales|published] [--limit N]   # ログインが必要
note-cli stats chart [--metric pv|impressions|likes|comments|sales] [--period ...]          # ログインが必要
note-cli stats pv [--filter all|daily|weekly|monthly|yearly] [--sort pv|like|comment] [--page N]   # ログインが必要
```

記事本文はデフォルトで 20,000 文字で切り詰められます（`--max-chars 0` で無制限）。出力には `bodyChars` と `truncated` が含まれます。一覧系の出力には `exhausted` が含まれ、読み取れない行があった場合は `skipped` も含まれます。`skipped` が出る場合、たいていは非公式 API の仕様が変わったことを意味します。

識別子はリクエスト前に検証されます。対象は note のキー（`n...`）または記事 URL、urlname（英数字・`_`・`-`）、ハッシュタグ（`/ \ ? # % .` と空白を含まないもの。1つでも `.` や空白を含むタグがあると、note はその記事のハッシュタグを黙ってすべて捨てるため）です。

エラーは `{"error": {"code", "message", ...}}` の形式で stderr に出力されます。終了コードはエラー時が 1、使い方の誤りが 2 です。`FORBIDDEN` は note が操作を拒否したことを示し、その理由も出力されます。`AUTH_ERROR` はセッションの有効期限切れを示します。

### 公開について

note で記事を公開するには reCAPTCHA v3 を通過する必要があり、通常の HTTP クライアントでは通過できません。そこで `publish` は使い捨てプロファイルで Chrome/Edge/Chromium を開き、保存済みセッションをコピーしたうえで、エディタページ内から note 自身の公開リクエストを送信します。処理が終わるとウィンドウは閉じます。クリック操作は不要です。ブラウザが見つからない場合は `--browser`（または `NOTE_CLI_BROWSER`）で指定してください。

- `publish` には既存の下書きが必要です。Markdown ファイルを指定した場合は、先にその内容で下書きを保存します。
- `<!-- paywall -->` だけの行が有料エリアの開始位置になります。`--price`（100〜50000 円）と組み合わせたときに有効で、`--price` を指定する場合は必須です。
- `--dry-run` はブラウザを開かずに、タイトル、ハッシュタグ、価格、無料部分と有料部分の長さを出力します。
- 予約投稿（`--schedule`）とコメントの無効化には note プレミアムが必要です。未加入の場合は note に拒否され、CLI は `FORBIDDEN` を返します。
- `--membership all` でメンバーシップの全メンバー向け、`--membership <プランキー>` で指定したプランだけ向けに公開します。`--membership none` でメンバーシップから外します。
- 有料記事、一度でも売れたことのある記事、有料マガジンやメンバーシップのマガジンに含まれる記事は、非公開化も削除もできません。
- コメントするには、事前にブラウザで一度 note のコメントガイドラインに同意する必要がある場合があります（`COMMENT_GUIDELINES`）。

### Markdown の変換

| Markdown | note |
|---|---|
| `#` / `##` | 大見出し |
| `###` | 小見出し |
| `####` 以降 | 太字の段落 |
| 段落内の改行 | 改行（`<br>`） |
| リスト、引用、コードブロック、太字、取り消し線、水平線 | そのまま |
| リンク | `http`、`https`、`mailto` は保持。それ以外のスキームはリンクを外してテキストだけ残し、警告を出す |
| ローカルパスの画像（`![alt](img/a.png "caption")`） | note にアップロードして画像ブロックとして埋め込む。title はキャプションになる。PNG、JPEG、GIF、WebP で 10 MB まで |
| URL の画像 | リンクに置き換え、警告を出す（埋め込みたい場合はファイルをダウンロードしてローカルパスで参照する） |
| 1行だけの URL | エディタと同じ判定で埋め込みにする。YouTube、Vimeo、ニコニコ動画、X の投稿とプロフィール、note 記事、GitHub、Spotify、Speaker Deck、Google マップ/スライド/フォーム、Bluesky、Threads など。それ以外のページはリンクカード。`--no-embed` でリンクのまま |
| 1行だけのローカルファイルへのリンク（`[資料](file.pdf)`） | ダウンロード用の添付ファイル（100 MB まで） |
| Obsidian の `![[img.png]]`、`[[Page\|label]]`、`==text==` | 画像、テキスト、太字 |
| 表 | **note は非対応**。コードブロックとして出力し、警告を出す |

タイトルは `--title`、フロントマターの `title:`、先頭の `# 見出し` の順で決まります。先頭の見出しをタイトルに使った場合、その見出しは本文から削除されます。

画像のパスは Markdown ファイルからの相対パスです（stdin から読み込む場合はカレントディレクトリが基準）。同じ画像を複数回使っても、アップロードは 1 回だけです。アイキャッチ（カバー画像）は `--eyecatch`（カレントディレクトリ基準）またはフロントマターの `eyecatch:`（Markdown ファイル基準）で指定します。note が受け付けるアイキャッチは縦横比 1280:670（1280x670 など）のものだけです。`--dry-run` はすべての画像を読み込んで検証しますが、アップロードはしません。note がアイキャッチを拒否した場合でも下書きは保存され、出力に警告が含まれます。

エディタの「記事にあう画像を選ぶ」と同じく、「みんなのフォトギャラリー」の画像をアイキャッチにできます。`note-cli photo search 富士山` で探し（`--public-domain` で「世界の美術館」の作品）、結果の `eyecatch` の値（`stock:<id>:<url>`）を `--eyecatch` またはフロントマターの `eyecatch:` に渡します。画像は 1280x670 に中央で切り抜かれ、提供者のクレジットはエディタで選んだ場合と同じく note が自動で表示します。

### 環境変数

| 変数 | 用途 |
|---|---|
| `NOTE_COOKIE` | Cookie ヘッダー文字列。保存済みのセッションより優先される |
| `NOTE_CLI_HOME` | セッションを保存するディレクトリ |
| `NOTE_CLI_BROWSER` | `auth login` と `publish` で使うブラウザの実行ファイル |
| `NOTE_CLI_INTERVAL_MS` | リクエスト間の最小間隔（デフォルト 500 ms） |
| `NOTE_CLI_DEBUG` | リクエスト URL を stderr に出力する |

## 未対応の機能

- マガジンやメンバーシッププランの作成・編集、売上と振込

## 開発

```bash
bun install
bun run dev search "Claude Code"   # ソースから実行
bun run build                      # src/ を dist/note-cli.js にバンドル（生成物もコミットする）
bun run check                      # 型チェック、テスト、ビルド、dist/ が最新かどうかの確認
```

リポジトリ構成:

- `src/`: TypeScript のソース
- `dist/note-cli.js`: プラグインに同梱するバンドル済み CLI
- `skills/`: プラグインのスキル
- `.claude-plugin/`: Claude Code のプラグインとマーケットプレイスのマニフェスト
- `.codex-plugin/` と `.agents/plugins/`: Codex のプラグインとマーケットプレイスのマニフェスト
- `.cursor-plugin/`、`.devin-plugin/`、`.kimi-plugin/`、`.antigravity-plugin/`: 各エージェント用のプラグインマニフェスト
- `gemini-extension.json` と `GEMINI.md`: Gemini CLI 拡張
- `package.json` の `pi` フィールド: Pi パッケージ

Copilot CLI、Factory Droid、Qwen Code は `.claude-plugin/` を読み込みます。バージョンを上げるときはすべてのマニフェストを更新してください。`test/manifests.test.ts` が `package.json` と一致しているかを確認します。

ドキュメントは README のみ日本語で書き、スキル（`skills/`）やコード、マニフェストは英語で書きます。
