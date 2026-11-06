---
name: publish
description: Publish, schedule, take down or delete note.com articles and manage which magazines they are in, with the bundled note-cli. Use when the user wants to make a note article public, set hashtags / price / paywall / table of contents, schedule a post, re-publish an edited article, turn an article back into a draft, delete a published article, or add an article to a magazine.
---

# note-cli:publish

Publish and manage articles on note.com through the unofficial API wrapper `note-cli`. Publishing is public and visible to followers: **always confirm the title, hashtags, price and timing with the user before running a command with `--yes`.**

## Running note-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/note-cli.js` (requires [Bun](https://bun.sh)).

- If `note-cli` is on PATH, use it.
- Otherwise run `bun <plugin root>/dist/note-cli.js ...` with the absolute path. If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`). Below, `note-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `FORBIDDEN` (note refused, with its reason in `message`), `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login (only for commands that need it)

`note-cli auth status` tells you whether a session exists. To log in, run `note-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the note.com login page and waits for the user to finish logging in there. Tell the user to log in in that window. Never ask for their password. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header (or just the `_note_session_v5` value) from DevTools and pipe it to `note-cli auth import`.

## How publishing works

note requires reCAPTCHA v3 to publish, which only a real browser can pass. `note-cli publish` therefore opens a Chrome/Edge/Chromium window with a throwaway profile, copies the saved session into it, runs note's own publish request inside the page, and closes the window (about 10–30 seconds). Run it with a command timeout of at least 180 seconds. The user does not need to do anything in the window. If no browser is found, pass `--browser <path>`.

The article must already exist as a draft (create one with `note-cli draft create`, see `note-cli:draft`). Passing a Markdown file to `publish` saves it to the draft first, so edits and publishing happen in one step.

## Commands

```bash
note-cli publish <key|url> --dry-run [options]        # show what would be sent: title, hashtags, price, free/paid lengths; no browser
note-cli publish <key|url> [file.md] --yes [options]  # -> {published: true, url, ...}
  --hashtag <tag>        # repeatable or comma-separated: --hashtag AI --hashtag ClaudeCode,生成AI
  --price <yen>          # 0 (free, default) or 100–50000; paid articles need a paywall (see below)
  --refund               # allow refunds on a paid article
  --magazine <key>       # add to your magazine on publish (repeatable)
  --toc                  # show a table of contents
  --disable-comments     # turn comments off (may need note premium)
  --no-notify            # do not send the subscriber notification
  --schedule <time>      # scheduled post, e.g. 2026-12-01T09:00+09:00 (needs note premium)
  --eyecatch <image>     # with a file: set the cover image (1280:670)
note-cli reserved                         # your scheduled articles
note-cli unpublish <key|url> --yes        # back to draft (also cancels a scheduled post)
note-cli delete <key|url> --yes           # delete for good (published ones are unpublished first)
note-cli magazines [--note <key>]         # your magazines; with --note, whether the article is in each
note-cli magazine add <magazineKey> <noteKey>
note-cli magazine remove <magazineKey> <noteKey>
```

Running `publish` on an already published article re-publishes it with the current draft content and the given settings (pass the hashtags again; they are replaced).

## Paid articles

Put a line containing only `<!-- paywall -->` in the Markdown where the paid part starts, then publish with `--price`. Everything above the line is free to read. `--dry-run` reports `freeLength` and `paidLength` so you can check the split. Without `--price` the marker is ignored and the whole article is free.

Paid articles, articles that ever sold, and articles in paid or membership magazines **cannot be unpublished or deleted**. note answers `FORBIDDEN` with that reason. Tell the user before publishing a paid article.

## Workflow

1. Make sure the draft is final (`note-cli draft get <key>`) or have the Markdown file ready.
2. Run `publish ... --dry-run` with the intended options and show the user the summary (title, hashtags, price, free/paid split, schedule).
3. After the user confirms, run the same command with `--yes` instead of `--dry-run`.
4. Give the user the returned `url`.

## Errors

- `CONFIRMATION_REQUIRED`: `--yes` was missing. Confirm with the user, then add it.
- `FORBIDDEN` on `--schedule`: the account has no note premium, so scheduled posting is unavailable. Offer to publish now instead.
- `FORBIDDEN` on `unpublish`/`delete`: the article is paid, sold, or in a paid/membership magazine. It can only be edited, not removed.
- `PUBLISH_FAILED`: note rejected the request; `message` and `detail` carry note's reason. `detail.challenges` lists the verification note asked for. If it contains something other than `reCAPTCHAv3`, the account may need to publish once from the editor.
- `AUTH_ERROR`: the session has expired; log in again (`note-cli auth login`).
