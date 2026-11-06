---
name: engage
description: Like (スキ), comment and follow on note.com; notifications, memberships.
---

# note-cli:engage

Interact with other people on note.com through the unofficial API wrapper `note-cli`. These actions are visible to others: **only act on articles and creators the user named, and confirm comment text with the user before posting.** Never use these commands for bulk or automated liking, following or commenting; it breaks note's terms and gets accounts restricted.

## Running note-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/note-cli.js` (requires [Bun](https://bun.sh)).

- If `note-cli` is on PATH, use it.
- Otherwise, if `<plugin root>/dist/note-cli.js` exists, run `bun <plugin root>/dist/note-cli.js ...` with the absolute path.
- Otherwise (the skill was installed on its own, e.g. with `npx skills add`), ask the user before installing the CLI globally with `bun add -g github:shoot16625/note-cli`, then use `note-cli`.
- If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`). Below, `note-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `FORBIDDEN` (note refused, with its reason in `message`), `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login (only for commands that need it)

`note-cli auth status` tells you whether a session exists. To log in, run `note-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the note.com login page and waits for the user to finish logging in there. Tell the user to log in in that window. Never ask for their password. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header (or just the `_note_session_v5` value) from DevTools and pipe it to `note-cli auth import`.

## Commands

```bash
note-cli like <key|url>                     # スキ
note-cli unlike <key|url>
note-cli comment <key|url> "text"           # post a comment; blank lines separate paragraphs
note-cli comment <key|url> - < reply.txt    # read the text from stdin
note-cli comment <key|url> "text" --reply-to <commentKey>   # reply (comment keys come from `note-cli comments <key>`)
note-cli comment delete <key|url> <commentKey> --yes
note-cli follow <urlname>                   # also accepts @urlname or a profile URL
note-cli unfollow <urlname>
note-cli notices                            # unread notifications / messages
note-cli membership plans                   # your membership plans
note-cli membership joined                  # memberships you belong to
```

To read comments and likes, use `note-cli comments <key>` and `note-cli likes <key>` (see `note-cli:research`).

## Errors

- `COMMENT_GUIDELINES`: note wants the user to accept its comment guidelines once. Ask them to open any article on note.com in their browser, start a comment, and accept the guidelines, then retry. Do not try to accept them on the user's behalf.
- `FORBIDDEN`: note refused (for example, comments are turned off, or the creator blocked the account); `message` carries note's reason.
- `AUTH_ERROR`: the session has expired; log in again (`note-cli auth login`).
