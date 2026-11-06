---
name: draft
description: Save Markdown articles to note.com as drafts (never publishes) with the local note-cli. Use when the user wants to put an article on note / note.com, save or update a note draft, or read back a draft they are editing.
---

# note-cli:draft

Save articles to note.com **as drafts only** through the unofficial API wrapper `note-cli`. This tool never publishes; the user publishes from the note editor themselves.

## Before you start

1. Check login: `note-cli auth status`. If `loggedIn` is false, ask the user to run `! note-cli auth login` (it opens Chrome; they log in by hand). Do not ask for their password.
2. Prepare the article as a Markdown file. Title comes from frontmatter `title:` or the first `# Heading` (removed from the body), or `--title`.

## Commands

```bash
note-cli draft create article.md --dry-run   # preview converted HTML + warnings, no network
note-cli draft create article.md             # -> {id, key, editUrl, warnings}
note-cli draft update <id|key|url> article.md  # overwrite title + body of an existing draft
note-cli draft get <key|url>                 # read a draft back as text (--html for raw)
note-cli draft list --status draft           # your drafts (page 1; --page N)
note-cli draft delete <id|key> --yes         # drafts only; ask the user before running
```

All output is JSON on stdout; errors are JSON on stderr with `error.code` (`NOT_LOGGED_IN`, `AUTH_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `USAGE`).

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

On `AUTH_ERROR`, the session expired: ask the user to run `! note-cli auth login` again.
