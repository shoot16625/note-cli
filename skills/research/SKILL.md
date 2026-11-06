---
name: research
description: Search note.com articles and analyze what performs well (likes, pricing, title patterns, posting time, top authors) with the bundled note-cli. Use for note market/competitor research, finding popular articles on a topic or hashtag, studying a creator, or reading an article's text.
---

# note-cli:research

Research note.com content through the unofficial API wrapper `note-cli`. These commands work without login.

## Running note-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/note-cli.js` (Node.js 22+).

- If `note-cli` is on PATH, use it.
- Otherwise run `node <plugin root>/dist/note-cli.js ...` with the absolute path. Below, `note-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login (only for commands that need it)

`note-cli auth status` tells you whether a session exists. To log in, run `note-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the note.com login page and waits for the user to finish logging in there. Tell the user to log in in that window. Never ask for their password. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header from DevTools and pipe it to `note-cli auth import`.

## Commands

```bash
note-cli search "<query>" --sort popular|hot|new --limit 20     # articles by keyword
note-cli hashtag <tag> --order popular|hot|new --limit 50 [--paid-only]
note-cli user <urlname> --limit 20                              # profile + recent articles
note-cli note <key|url>                                         # article text (paid parts are hidden)

note-cli analyze search "<query>" --limit 100 --top 10
note-cli analyze hashtag <tag> --limit 100
note-cli analyze user <urlname> --limit 100
```

Each article is returned as `{key, title, url, author, likeCount, commentCount, price, isPaid, publishAt, hashtags, imageCount}`.
Hashtags are only filled by `user` (creator) listings; search and hashtag listings return them empty.

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
