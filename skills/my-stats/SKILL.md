---
name: my-stats
description: Look at the logged-in user's own note.com numbers (page views, likes, comments per article) with the bundled note-cli. Use when the user asks how their note articles are doing, which posts get the most views, or wants to review their note performance.
---

# note-cli:my-stats

Read the user's own note.com statistics through the unofficial API wrapper `note-cli`. Requires login.

## Running note-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/note-cli.js` (requires [Bun](https://bun.sh)).

- If `note-cli` is on PATH, use it.
- Otherwise run `bun <plugin root>/dist/note-cli.js ...` with the absolute path. If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`). Below, `note-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login (only for commands that need it)

`note-cli auth status` tells you whether a session exists. To log in, run `note-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the note.com login page and waits for the user to finish logging in there. Tell the user to log in in that window. Never ask for their password. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header from DevTools and pipe it to `note-cli auth import`.

## Commands

```bash
note-cli auth status                                  # who is logged in
note-cli stats pv --filter all|daily|weekly|monthly --sort pv|like|comment --page 1
note-cli analyze user <own urlname> --limit 100       # likes/title/timing breakdown of own posts
note-cli draft list                                   # own articles incl. drafts
```

`stats pv` returns note's raw response (per-article `read_count`, likes, comments plus totals). It is page-based (`--page N`); the response shape is unofficial, so inspect it before summarizing.

If not logged in, or on `AUTH_ERROR`, log in as described above.

## Reporting

- Lead with the totals for the period, then the top 5 articles by views, then anything surprising (high views but few likes, etc.).
- Combine with `analyze user` to relate performance to title style and posting time; flag small samples.
- The newer dashboard (impressions, referrers) uses an authenticated GraphQL API that note-cli does not support yet.
