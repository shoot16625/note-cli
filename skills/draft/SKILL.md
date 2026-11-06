---
name: draft
description: Save Markdown articles to note.com as drafts (never publishes) with the bundled note-cli. Use when the user wants to put an article on note / note.com, save or update a note draft, or read back a draft they are editing.
---

# note-cli:draft

Save articles to note.com **as drafts only** through the unofficial API wrapper `note-cli`. This tool never publishes; the user publishes from the note editor themselves.

## Running note-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/note-cli.js` (requires [Bun](https://bun.sh)).

- If `note-cli` is on PATH, use it.
- Otherwise, if `<plugin root>/dist/note-cli.js` exists, run `bun <plugin root>/dist/note-cli.js ...` with the absolute path.
- Otherwise (the skill was installed on its own, e.g. with `npx skills add`), ask the user before installing the CLI globally with `bun add -g github:shoot16625/note-cli`, then use `note-cli`.
- If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`). Below, `note-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login (only for commands that need it)

`note-cli auth status` tells you whether a session exists. To log in, run `note-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the note.com login page and waits for the user to finish logging in there. Tell the user to log in in that window. Never ask for their password. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header (or just the `_note_session_v5` value) from DevTools and pipe it to `note-cli auth import`.

## Before you start

1. Check login with `note-cli auth status`; log in as described above if `loggedIn` is false.
2. Prepare the article as a Markdown file. Title comes from frontmatter `title:` or the first `# Heading` (removed from the body), or `--title`.

## Commands

```bash
note-cli draft create article.md --dry-run   # preview converted HTML + warnings, no network
note-cli draft create article.md             # -> {id, key, editUrl, warnings}
note-cli draft update <id|key|url> article.md  # overwrite title + body of an existing draft
note-cli draft get <key|url>                 # read a draft back as text (--html for raw, --max-chars N, default 20000)
note-cli draft list --status draft           # your drafts (page 1; --page N)
note-cli draft delete <id|key> --yes         # drafts only; ask the user before running
```

## Markdown → note conversion

- `#`/`##` → large heading, `###` → small heading, `####`+ → bold line (note has two heading levels).
- Single newlines are kept as line breaks; blank lines separate paragraphs.
- Lists, quotes, code blocks, bold/italic/strike, links, horizontal rules work.
- **Images are not uploaded** (they become links) and **tables become code blocks**; both appear in `warnings`. Tell the user to add images in the editor.
- Hashtags, price, magazines, and eyecatch are not set by the draft API — the user sets them in the editor when publishing.

## Workflow

1. Write or edit the Markdown file with the user.
2. Run with `--dry-run` once and relay any `warnings`.
3. Run `draft create` (or `draft update` with the id returned before — keep it so later edits update the same draft instead of creating duplicates).
4. Give the user the `editUrl`.

On `AUTH_ERROR` the session has expired: log in again as described above. An `API_ERROR` with `email_activation` means the account has not verified its email address yet.
