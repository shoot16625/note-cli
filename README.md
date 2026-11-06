# note-cli

A CLI and agent plugin for [note.com](https://note.com) built on its **unofficial** API, made to be driven by Claude Code and Codex. Every command prints JSON.

- **Drafts**: convert Markdown to note's editor HTML and save it as a draft. It never publishes.
- **Research**: search articles, list a hashtag's or a creator's articles, and read article text.
- **Analysis**: like-count distribution, paid ratio, title patterns, posting weekday/hour, top authors and articles.
- **Your stats**: page views, likes and comments per article.

> ⚠️ This is not an official note.com API. It can break without notice. Keep usage personal and low-volume, and follow note.com's terms of service.

References: [shimayuz/note-com-mcp](https://github.com/shimayuz/note-com-mcp), [note 非公式 API を徹底調査](https://note.com/marie_222/n/n6a10366298b0)

## Install

The plugin bundles the CLI as a single dependency-free file (`dist/note-cli.js`). The only requirement is [Bun](https://bun.sh) 1.2 or later:

```bash
curl -fsSL https://bun.sh/install | bash
```

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

### CLI only (optional)

To use `note-cli` directly in your shell:

```bash
bun add -g github:shoot16625/note-cli
```

## Skills

| Skill | What it does |
|---|---|
| `note-cli:draft` | Save, update and read back Markdown drafts |
| `note-cli:research` | Search and analyze articles, hashtags and creators |
| `note-cli:my-stats` | Review your own page views, likes and comments |

Examples: "save `post.md` to note as a draft" or "what kind of note articles about Claude Code get the most likes?"

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
note-cli draft create article.md [--title T] [--dry-run]
note-cli draft update <id|key|url> article.md
note-cli draft get <key|url> [--html] [--max-chars N]
note-cli draft list [--page N] [--status draft|published]
note-cli draft delete <id|key|url> --yes

# Research (no login)
note-cli search "<query>" [--sort popular|hot|new] [--limit N] [--start N]
note-cli hashtag <tag> [--order popular|hot|new] [--limit N] [--paid-only]
note-cli user <urlname> [--limit N]
note-cli note <key|url> [--html] [--max-chars N]

# Analysis
note-cli analyze search "<query>" [--sort ...] [--limit 100] [--top 10]
note-cli analyze hashtag <tag> [--order ...] [--limit 100]
note-cli analyze user <urlname> [--limit 100]
note-cli stats pv [--filter all|daily|weekly|monthly|yearly] [--sort pv|like|comment] [--page N]   # login required
```

Article bodies are cut at 20,000 characters by default (`--max-chars 0` for no limit); the output reports `bodyChars` and `truncated`. List outputs report `exhausted`, plus `skipped` when rows could not be read, which usually means the unofficial API changed.

Identifiers are validated before any request: note keys (`n...`) or note URLs, urlnames (letters, digits, `_`, `-`), and hashtags without `/ \ ? # %` or whitespace.

Errors go to stderr as `{"error": {"code", "message", ...}}`. The exit code is 1 for errors and 2 for usage mistakes.

### Markdown conversion

| Markdown | note |
|---|---|
| `#` / `##` | Large heading |
| `###` | Small heading |
| `####` and deeper | Bold paragraph |
| Line break inside a paragraph | Line break (`<br>`) |
| Lists, quotes, code blocks, bold, strikethrough, horizontal rules | Kept as is |
| Links | Kept for `http`, `https` and `mailto`; other schemes are dropped, keeping the link text, with a warning |
| Images | **Not supported yet**: replaced with a link, with a warning |
| Tables | **Not supported by note**: rendered as a code block, with a warning |

The title comes from `--title`, then frontmatter `title:`, then a leading `# Heading`, which is removed from the body.

### Environment variables

| Variable | Purpose |
|---|---|
| `NOTE_COOKIE` | Cookie header string. Overrides the saved session |
| `NOTE_CLI_HOME` | Directory where the session is stored |
| `NOTE_CLI_BROWSER` | Browser executable used by `auth login` |
| `NOTE_CLI_INTERVAL_MS` | Minimum delay between requests (default 500 ms) |
| `NOTE_CLI_DEBUG` | Log request URLs to stderr |

## Not supported yet

- Image upload (body images and eyecatch)
- Publishing, scheduled posts, hashtags and price (`PUT /api/v1/text_notes/{id}`)
- The GraphQL dashboard (impressions, referrers)

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
