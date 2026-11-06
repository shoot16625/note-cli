---
name: my-stats
description: Look at the logged-in user's own note.com numbers (page views, impressions, likes, comments, sales, referrers, trends) with the bundled note-cli. Use when the user asks how their note articles are doing, which posts get the most views, or wants to review their note performance.
---

# note-cli:my-stats

Read the user's own note.com statistics through the unofficial API wrapper `note-cli`. Requires login.

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
note-cli auth status                                  # who is logged in
note-cli stats dashboard [--period 7d|28d|365d|all|this-month|last-month] [--order pv|impressions|likes|comments|sales|published] [--limit 20]
                                                      # totals, referrers and per-article numbers for the period (default 28d)
note-cli stats dashboard --period custom --from 2026-10-01 --to 2026-10-31
note-cli stats chart --metric pv|impressions|likes|comments|sales --period 28d   # one metric over time
note-cli stats pv --filter all|daily|weekly|monthly|yearly --sort pv|like|comment --page 1
note-cli analyze user <own urlname> --limit 100       # likes/title/timing breakdown of own posts
note-cli draft list                                   # own articles incl. drafts
```

`stats dashboard` is the same data as note's dashboard page: `totals` (`pageViews`, `impressions`, `likes`, `comments`, `sales` in yen), `referrers` (where readers came from: note.com, search engines, X, ChatGPT, ...) and `notes` with the same numbers per article. Impressions are `null` before May 2021. `lastUpdatedAt` says how fresh the numbers are (note updates them about daily). `--limit 0` skips the per-article list.

`stats pv` returns note's older raw response (per-article `read_count`, likes, comments plus totals). It is page-based (`--page N`); the response shape is unofficial, so inspect it before summarizing.

If not logged in, or on `AUTH_ERROR`, log in as described above.

## Reporting

- Lead with the totals for the period, then the top 5 articles by views, then anything surprising (high views but few likes, etc.).
- Combine with `analyze user` to relate performance to title style and posting time; flag small samples.
- Use `stats dashboard` for the overview and `stats chart` to see whether a spike was one day or a trend. Compare impressions to page views (click-through) and point out referrers that grew.
