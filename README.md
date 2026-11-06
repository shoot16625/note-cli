# note-cli

A CLI and agent plugin for [note.com](https://note.com) built on its **unofficial** API, made to be driven by AI coding agents such as Claude Code, Codex, Cursor and Gemini CLI. Every command prints JSON.

- **Drafts**: convert Markdown (Obsidian syntax too) to note's editor HTML and save it as a draft, uploading local images and the eyecatch; URLs on their own line become embeds (YouTube, X, note articles, link cards, ...) and linked local files become download attachments.
- **Publishing**: publish with hashtags, price and paywall, table of contents, magazines and membership plans; schedule posts; take articles down or delete them.
- **Engagement**: like, comment, follow, add articles to your magazines, and check notifications and memberships.
- **Research**: search articles, creators, magazines and hashtags; browse hashtags, categories, magazines and contests; read article text, likes and comments.
- **Analysis**: like-count distribution, paid ratio, title patterns, posting weekday/hour, top authors and articles.
- **Your stats**: the dashboard's numbers (page views, impressions, likes, comments, sales) in total, per article, over time and by referrer.

> ⚠️ This is not an official note.com API. It can break without notice. Keep usage personal and low-volume, and follow note.com's terms of service.

References: [shimayuz/note-com-mcp](https://github.com/shimayuz/note-com-mcp), [note 非公式 API を徹底調査](https://note.com/marie_222/n/n6a10366298b0)

## Install

The plugin bundles the CLI as a single dependency-free file (`dist/note-cli.js`). The only requirement is [Bun](https://bun.sh) 1.2 or later:

```bash
curl -fsSL https://bun.sh/install | bash
```

Installation differs by agent. If you use more than one, install note-cli separately for each.

| Agent | Install |
|---|---|
| [Claude Code](#claude-code) | `/plugin marketplace add shoot16625/note-cli` |
| [Codex](#codex) | `codex plugin marketplace add shoot16625/note-cli` |
| [Cursor](#cursor) | `/add-plugin` from this repository |
| [Gemini CLI](#gemini-cli) | `gemini extensions install https://github.com/shoot16625/note-cli` |
| [GitHub Copilot CLI](#github-copilot-cli) | `copilot plugin marketplace add shoot16625/note-cli` |
| [Factory Droid](#factory-droid) | `droid plugin marketplace add https://github.com/shoot16625/note-cli` |
| [Qwen Code](#qwen-code) | `qwen extensions install shoot16625/note-cli` |
| [Devin CLI](#devin-cli) | `devin plugins install shoot16625/note-cli` |
| [Kimi Code](#kimi-code) | `/plugins install https://github.com/shoot16625/note-cli` |
| [Antigravity](#antigravity) | `agy plugin install https://github.com/shoot16625/note-cli` |
| [Pi](#pi) | `pi install git:github.com/shoot16625/note-cli` |
| [Anything else](#other-agents-opencode-windsurf-cline-) | `npx skills add shoot16625/note-cli` |

### Claude Code

```text
/plugin marketplace add shoot16625/note-cli
/plugin install note-cli@note-cli
```

### Codex

```bash
codex plugin marketplace add shoot16625/note-cli
```

Then open `/plugins` (CLI) or **Plugins** in the sidebar (app) and install **note-cli**.

### Cursor

In Cursor Agent chat:

```text
/add-plugin https://github.com/shoot16625/note-cli
```

### Gemini CLI

```bash
gemini extensions install https://github.com/shoot16625/note-cli
gemini extensions update note-cli   # later
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

Qwen Code installs plugins from Claude Code marketplaces directly. Pick `note-cli` when prompted:

```bash
qwen extensions install shoot16625/note-cli
qwen extensions update note-cli   # later
```

### Devin CLI

```bash
devin plugins install shoot16625/note-cli
devin plugins update note-cli   # later
```

### Kimi Code

```text
/plugins install https://github.com/shoot16625/note-cli
```

### Antigravity

```bash
agy plugin install https://github.com/shoot16625/note-cli
```

Reinstall with the same command to update.

### Pi

```bash
pi install git:github.com/shoot16625/note-cli
```

### Other agents (OpenCode, Windsurf, Cline, ...)

Any agent that reads `SKILL.md` skills can install them with the [`skills`](https://github.com/vercel-labs/skills) CLI, which asks which agents to install for:

```bash
npx skills add shoot16625/note-cli
```

This copies only the skills, not the bundled CLI, so also install the CLI (the skills will offer to do it on first use):

```bash
bun add -g github:shoot16625/note-cli
```

### CLI only (optional)

To use `note-cli` directly in your shell:

```bash
bun add -g github:shoot16625/note-cli
```

## Skills

| Skill | What it does |
|---|---|
| `note-cli:draft` | Save, update and read back Markdown drafts |
| `note-cli:publish` | Publish, schedule, unpublish and delete articles; manage magazines |
| `note-cli:engage` | Like, comment, follow; notifications and memberships |
| `note-cli:research` | Search and analyze articles, hashtags and creators |
| `note-cli:my-stats` | Review your dashboard: views, impressions, likes, sales, referrers |

Examples: "save `post.md` to note as a draft", "publish it with the hashtags AI and ClaudeCode", or "what kind of note articles about Claude Code get the most likes?"

## Login

Since 2026-05, note's email/password login API requires reCAPTCHA. note-cli therefore opens a real browser and lets you log in by hand.

```bash
note-cli auth login                  # opens Chrome/Edge/Chromium on the login page; log in there
note-cli auth login --browser "/path/to/chrome"
note-cli auth import --cookie '_note_session_v5=...; XSRF-TOKEN=...'   # a Cookie header from DevTools, or just the _note_session_v5 value
note-cli auth status
note-cli auth logout
```

`auth login` uses a throwaway browser profile and reads the cookies through the Chrome DevTools Protocol. Your normal browser profile is never touched.

The session is saved to `~/.config/note-cli/session.json` with mode 0600. Setting `NOTE_COOKIE` overrides the saved session.

Your note account must have a verified email address before it can create drafts.

## Commands

```bash
# Drafts (login required)
note-cli draft create article.md [--title T] [--eyecatch cover.png] [--no-embed] [--dry-run]
note-cli draft update <key|url> article.md [--eyecatch cover.png] [--no-embed]
note-cli draft get <key|url> [--html] [--max-chars N]
note-cli draft list [--page N] [--status draft|published]
note-cli draft delete <id|key|url> --yes

# Publishing (login required; opens a browser window briefly, see below)
note-cli publish <key|url> [article.md] --yes [--hashtag T]... [--price YEN] [--refund] [--magazine KEY]... \
    [--membership all|none|PLAN]... [--toc] [--disable-comments] [--no-notify] [--hide-from-profile] \
    [--schedule 2026-12-01T09:00+09:00] [--eyecatch cover.png] [--dry-run]
note-cli reserved                               # scheduled articles
note-cli unpublish <key|url> --yes              # back to draft (cancels a scheduled post too)
note-cli delete <key|url> --yes                 # delete; published articles are unpublished first
note-cli magazines [--note <key>]               # your magazines
note-cli magazine add|remove <magazineKey> <noteKey>

# Engagement (login required)
note-cli like|unlike <key|url>
note-cli comment <key|url> "text" [--reply-to <commentKey>]
note-cli comment delete <key|url> <commentKey> --yes
note-cli follow|unfollow <urlname>
note-cli notices                                # unread counts
note-cli membership plans|joined

# Research (no login)
note-cli search "<query>" [--type note|user|magazine|hashtag] [--sort popular|hot|new] [--limit N] [--start N]
note-cli hashtag <tag> [--order popular|hot|new] [--limit N] [--paid-only]   # also article count + related tags
note-cli user <urlname> [--limit N]
note-cli note <key|url> [--html] [--max-chars N]
note-cli likes <key|url> [--limit N]            # who liked an article
note-cli comments <key|url> [--limit N]         # top-level comments with reply counts
note-cli magazine <key|url> [--limit N]         # magazine details + its articles
note-cli categories                             # category slugs
note-cli category <slug> [--sort new|trend] [--limit N]   # `featured` = note's editorial pick
note-cli contests [--state opened|closed|finished|all] [--type contest|theme|all] [--limit N]

# Analysis
note-cli analyze search "<query>" [--sort ...] [--limit 100] [--top 10]
note-cli analyze hashtag <tag> [--order ...] [--limit 100]
note-cli analyze user <urlname> [--limit 100]
note-cli stats dashboard [--period 7d|28d|365d|all|this-month|last-month|custom] [--from D --to D] \
    [--order pv|impressions|likes|comments|sales|published] [--limit N]   # login required
note-cli stats chart [--metric pv|impressions|likes|comments|sales] [--period ...]          # login required
note-cli stats pv [--filter all|daily|weekly|monthly|yearly] [--sort pv|like|comment] [--page N]   # login required
```

Article bodies are cut at 20,000 characters by default (`--max-chars 0` for no limit); the output reports `bodyChars` and `truncated`. List outputs report `exhausted`, plus `skipped` when rows could not be read, which usually means the unofficial API changed.

Identifiers are validated before any request: note keys (`n...`) or note URLs, urlnames (letters, digits, `_`, `-`), and hashtags without `/ \ ? # % .` or whitespace (note silently drops every hashtag of an article when one contains a dot or space).

Errors go to stderr as `{"error": {"code", "message", ...}}`. The exit code is 1 for errors and 2 for usage mistakes. `FORBIDDEN` means note refused the action and gives its reason; `AUTH_ERROR` means the session has expired.

### Publishing

note requires reCAPTCHA v3 to publish, which a plain HTTP client cannot pass. `publish` opens Chrome/Edge/Chromium with a throwaway profile, copies the saved session into it, and sends note's own publish request from inside the editor page. The window closes when it is done. Nothing needs to be clicked. Use `--browser` (or `NOTE_CLI_BROWSER`) if no browser is found.

- `publish` needs an existing draft. With a Markdown file, the file is saved to the draft first.
- A line containing only `<!-- paywall -->` marks where the paid part starts. It takes effect with `--price` (100–50000 yen), which requires it.
- `--dry-run` prints the title, hashtags, price and the free/paid lengths without opening a browser.
- Scheduled posts (`--schedule`) and turning comments off need note premium. note refuses them otherwise, and the CLI reports `FORBIDDEN`.
- `--membership all` makes the article readable by every member of your membership, `--membership <planKey>` by those plans only, and `--membership none` takes it out.
- Paid articles, articles that ever sold, and articles in paid or membership magazines cannot be unpublished or deleted.
- Commenting may first require accepting note's comment guidelines once in a browser (`COMMENT_GUIDELINES`).

### Markdown conversion

| Markdown | note |
|---|---|
| `#` / `##` | Large heading |
| `###` | Small heading |
| `####` and deeper | Bold paragraph |
| Line break inside a paragraph | Line break (`<br>`) |
| Lists, quotes, code blocks, bold, strikethrough, horizontal rules | Kept as is |
| Links | Kept for `http`, `https` and `mailto`; other schemes are dropped, keeping the link text, with a warning |
| Images with a local path (`![alt](img/a.png "caption")`) | Uploaded to note and embedded as an image block; the title becomes the caption. PNG, JPEG, GIF or WebP, up to 10 MB |
| Images with a URL | Replaced with a link, with a warning (download the file and reference it locally to embed it) |
| A bare URL alone on its line | An embed, chosen the way the editor does: YouTube, Vimeo, niconico, X posts and profiles, note articles, GitHub, Spotify, Speaker Deck, Google Maps/Slides/Forms, Bluesky, Threads and more; other pages become link cards. `--no-embed` keeps the link |
| `[label](file.pdf)` alone on its line (a local file) | A download attachment (up to 100 MB) |
| Obsidian `![[img.png]]`, `[[Page\|label]]`, `==text==` | Image, plain text, bold |
| Tables | **Not supported by note**: rendered as a code block, with a warning |

The title comes from `--title`, then frontmatter `title:`, then a leading `# Heading`, which is removed from the body.

Image paths are relative to the Markdown file (the current directory when reading stdin). An image used more than once is uploaded once. The eyecatch (cover image) comes from `--eyecatch` (relative to the current directory) or frontmatter `eyecatch:` (relative to the Markdown file). note only accepts eyecatches with a 1280:670 aspect ratio, such as 1280x670. `--dry-run` reads and checks every image without uploading anything. If note rejects the eyecatch, the draft is still saved and the output carries a warning.

### Environment variables

| Variable | Purpose |
|---|---|
| `NOTE_COOKIE` | Cookie header string. Overrides the saved session |
| `NOTE_CLI_HOME` | Directory where the session is stored |
| `NOTE_CLI_BROWSER` | Browser executable used by `auth login` and `publish` |
| `NOTE_CLI_INTERVAL_MS` | Minimum delay between requests (default 500 ms) |
| `NOTE_CLI_DEBUG` | Log request URLs to stderr |

## Not supported yet

- The GraphQL dashboard (impressions, referrers)
- Creating or editing magazines and membership plans, sales and payouts

## Development

```bash
bun install
bun run dev search "Claude Code"   # run from source
bun run build                      # bundle src/ into dist/note-cli.js (commit the result)
bun run check                      # typecheck, tests, build, and a check that dist/ is up to date
```

Repository layout:

- `src/`: TypeScript sources
- `dist/note-cli.js`: bundled CLI that ships with the plugin
- `skills/`: plugin skills
- `.claude-plugin/`: Claude Code plugin and marketplace manifests
- `.codex-plugin/` and `.agents/plugins/`: Codex plugin and marketplace manifests
- `.cursor-plugin/`, `.devin-plugin/`, `.kimi-plugin/`, `.antigravity-plugin/`: plugin manifests for those agents
- `gemini-extension.json` and `GEMINI.md`: Gemini CLI extension
- `package.json` `pi` field: Pi package

Copilot CLI, Factory Droid and Qwen Code read `.claude-plugin/`. When bumping the version, update every manifest; `test/manifests.test.ts` checks they match `package.json`.
