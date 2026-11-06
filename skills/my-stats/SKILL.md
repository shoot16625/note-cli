---
name: my-stats
description: Look at the logged-in user's own note.com numbers (page views, likes, comments per article) with the local note-cli. Use when the user asks how their note articles are doing, which posts get the most views, or wants to review their note performance.
---

# note-cli:my-stats

Read the user's own note.com statistics through the unofficial API wrapper `note-cli`. Requires login.

## Commands

```bash
note-cli auth status                                  # who is logged in
note-cli stats pv --filter all|daily|weekly|monthly --sort pv|like|comment --page 1
note-cli analyze user <own urlname> --limit 100       # likes/title/timing breakdown of own posts
note-cli draft list                                   # own articles incl. drafts
```

`stats pv` returns note's raw response (per-article `read_count`, likes, comments plus totals). It is page-based (`--page N`); the response shape is unofficial, so inspect it before summarizing.

If not logged in or on `AUTH_ERROR`, ask the user to run `! note-cli auth login`.

## Reporting

- Lead with the totals for the period, then the top 5 articles by views, then anything surprising (high views but few likes, etc.).
- Combine with `analyze user` to relate performance to title style and posting time; flag small samples.
- The newer dashboard (impressions, referrers) uses an authenticated GraphQL API that note-cli does not support yet.
