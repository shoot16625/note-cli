---
name: research
description: Search note.com articles, creators, magazines and hashtags and analyze what performs well (likes, pricing, title patterns, posting time, top authors) with the bundled note-cli. Use for note market/competitor research, finding popular articles on a topic, hashtag or category, choosing hashtags, studying a creator or magazine, checking contests, or reading an article's text, likes and comments.
---

# note-cli:research

Research note.com content through the unofficial API wrapper `note-cli`. These commands work without login.

## Running note-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/note-cli.js` (requires [Bun](https://bun.sh)).

- If `note-cli` is on PATH, use it.
- Otherwise, if `<plugin root>/dist/note-cli.js` exists, run `bun <plugin root>/dist/note-cli.js ...` with the absolute path.
- Otherwise (the skill was installed on its own, e.g. with `npx skills add`), ask the user before installing the CLI globally with `bun add -g github:shoot16625/note-cli`, then use `note-cli`.
- If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`). Below, `note-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login (only for commands that need it)

`note-cli auth status` tells you whether a session exists. To log in, run `note-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the note.com login page and waits for the user to finish logging in there. Tell the user to log in in that window. Never ask for their password. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header (or just the `_note_session_v5` value) from DevTools and pipe it to `note-cli auth import`.

## Commands

```bash
note-cli search "<query>" --sort popular|hot|new --limit 20     # articles by keyword
note-cli search "<query>" --type user|magazine|hashtag          # creators / magazines / hashtags (with article counts)
note-cli hashtag <tag> --order popular|hot|new --limit 50 [--paid-only]   # + articleCount and relatedHashtags
note-cli user <urlname> --limit 20                              # profile + recent articles
note-cli note <key|url> [--max-chars N]                         # article text, cut at 20000 chars by default (paid parts are hidden)
note-cli likes <key|url> --limit 50                             # who liked it (urlname, followerCount, likedAt)
note-cli comments <key|url> --limit 50                          # top-level comments: text, likeCount, replyCount, creatorReplied
note-cli magazine <key|url> --limit 20                          # magazine info (noteCount, price) + its articles
note-cli categories                                             # category slugs (featured, tech, column, ...)
note-cli category <slug> --sort new|trend --limit 20            # articles in a category; `featured` = editorial pick
note-cli contests [--state opened] [--type contest|theme|all]   # running contests / themed hashtags, closing soonest first

note-cli analyze search "<query>" --limit 100 --top 10
note-cli analyze hashtag <tag> --limit 100
note-cli analyze user <urlname> --limit 100
```

Each article is returned as `{key, title, url, author, likeCount, commentCount, price, isPaid, publishAt, hashtags, excerpt, imageCount}`.

- `hashtags` are filled by `user` listings and `note`; search and hashtag listings don't include them.
- To pick hashtags for an article, compare `search "<topic>" --type hashtag` counts and `hashtag <tag>` `relatedHashtags`; `contests` shows themes that are currently promoted.
- `likes` lists the people who liked an article (useful for finding an author's audience); `comments` lists top-level comments only, with replies counted in `replyCount`.
- `excerpt` (≤ 200 chars) comes from `hashtag`, `user` and `note`; search results have none. Use `note <key>` to read one in full.
- `note` reports `bodyChars` and `truncated`; raise `--max-chars` (0 = no limit) only when you really need the whole text.
- List outputs include `exhausted` (no more results exist) and, when the API returned rows note-cli could not read, `skipped` with reasons. Mention `skipped` to the user: it usually means note changed its API.

`analyze` returns:
- `likes` — count/mean/median/p90/max of like counts
- `paid` — paid ratio, price distribution, likes of paid vs free
- `titleLength.byBucket` and `titleFeatures` — median likes by title length and with/without 【】, numbers, ?, !, separators
- `publishTime` — counts and median likes by weekday and hour (JST)
- `topAuthors`, `topHashtags`, `topNotes`

## How to use the results

- Samples are biased by sort order: `popular` shows winners, `new` shows the baseline. For "what works", compare `analyze search X --sort popular` with `--sort new`.
- Medians over small buckets (count < 5) are noise; say so instead of drawing conclusions.
- Likes are the only public engagement metric; page views are not public.
- Keep `--limit` modest (≤ 200). The API is unofficial; requests are throttled (`NOTE_CLI_INTERVAL_MS`, default 500ms) and heavy scraping can get the account or IP blocked.
- Summarize findings for the user with concrete examples (titles + URLs from `topNotes`), not raw JSON.
