---
name: draft
description: Save, update or read note.com drafts from Markdown (images, eyecatch, gallery photos, embeds, attachments).
---

# note-cli:draft

Save articles to note.com as drafts through the unofficial API wrapper `note-cli`. Drafts are private. To make an article public (or schedule it, set a price or hashtags), continue with the `note-cli:publish` skill.

## Running note-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/note-cli.js` (requires [Bun](https://bun.sh)).

- If `note-cli` is on PATH, use it.
- Otherwise, if `<plugin root>/dist/note-cli.js` exists, run `bun <plugin root>/dist/note-cli.js ...` with the absolute path.
- Otherwise (the skill was installed on its own, e.g. with `npx skills add`), ask the user before installing the CLI globally with `bun add -g github:shoot16625/note-cli`, then use `note-cli`.
- If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`). Below, `note-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `FORBIDDEN` (note refused, with its reason in `message`), `NOT_FOUND`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login (only for commands that need it)

`note-cli auth status` tells you whether a session exists. To log in, run `note-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the note.com login page and waits for the user to finish logging in there. Tell the user to log in in that window. Never ask for their password. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header (or just the `_note_session_v5` value) from DevTools and pipe it to `note-cli auth import`.

## Before you start

1. Check login with `note-cli auth status`; log in as described above if `loggedIn` is false.
2. Prepare the article as a Markdown file. Title comes from frontmatter `title:` or the first `# Heading` (removed from the body), or `--title`.

## Commands

```bash
note-cli draft create article.md --dry-run   # preview converted HTML, images + warnings, no network
note-cli draft create article.md [--eyecatch cover.png] [--no-embed]   # -> {id, key, editUrl, images, embeds, eyecatch, warnings}
note-cli draft update <key|url> article.md [--eyecatch cover.png]  # overwrite title + body of an existing draft (use the key: embeds need it)
note-cli draft get <key|url>                 # read a draft back as text (--html for raw, --max-chars N, default 20000)
note-cli draft list --status draft           # your drafts (page 1; --page N)
note-cli draft delete <id|key> --yes         # drafts only (published: `note-cli delete`); ask the user before running
note-cli photo search 富士山 [--public-domain] [--limit N] [--page N]   # みんなのフォトギャラリー: free cover photos (login)
```

## Markdown → note conversion

- `#`/`##` → large heading, `###` → small heading, `####`+ → bold line (note has two heading levels).
- Single newlines are kept as line breaks; blank lines separate paragraphs.
- Lists, quotes, code blocks, bold/italic/strike, links, horizontal rules work.
- **Local images** (`![alt](img/a.png "caption")`, path relative to the Markdown file) are uploaded and embedded as image blocks; the optional title becomes the caption. PNG/JPEG/GIF/WebP, ≤ 10 MB. Put each image on its own line.
- **Image URLs are not uploaded** (they become links, with a warning). To embed one, download it and reference the local file.
- **Embeds**: a URL alone on its own line (a bare URL, not `[text](url)`) becomes an embed, like pasting it into the editor: YouTube/Vimeo/niconico players, X posts and profiles, note articles as cards, GitHub, Spotify, Speaker Deck, Google Maps/Slides/Forms, Bluesky, Threads and more; any other page becomes a link card. `--no-embed` keeps them as plain links. If note cannot fetch a URL, it stays a link and `warnings` says so.
- **Attachments**: a link to a local file alone on its own line (`[資料](files/guide.pdf)`) uploads the file as a download attachment (≤ 100 MB). Relative to the Markdown file.
- **Obsidian syntax**: `![[image.png]]` / `![[image.png|alt]]` are images, `[[Page|label]]` becomes its text, `==highlight==` becomes bold.
- **Tables become code blocks**, with a warning.
- **Eyecatch** (cover image): `--eyecatch <file>` or frontmatter `eyecatch: cover.png`. note only accepts a **1280:670** aspect ratio (e.g. 1280x670); `--dry-run` warns about other sizes. If note rejects it, the draft is still saved, `eyecatch.set` is false, and `warnings` explains why. Fix the image and rerun `draft update` with `--eyecatch`.
- **Gallery eyecatch** (the editor's 記事にあう画像を選ぶ): when the user has no cover image, run `note-cli photo search <keywords from the article>` and choose by `keywords` and `sourceNote.title` (download a few `thumbnailUrl`s to look at them if you can view images). `--public-domain` searches museum artworks instead. Pass the chosen photo's `eyecatch` value (`stock:<id>:<url>`) to `--eyecatch` or frontmatter `eyecatch:`. It is center-cropped to 1280x670 and note shows the `credit` under the cover automatically. Tell the user which photo you picked and whose it is.
- A line containing only `<!-- paywall -->` marks where the paid part of a paid article starts (it shows as the paywall line in the editor).
- Hashtags, price and magazines are set when publishing (`note-cli publish`, see `note-cli:publish`).

## Workflow

1. Write or edit the Markdown file with the user.
2. Run with `--dry-run` once: it checks that every referenced image exists and is supported. Relay any `warnings`.
3. Run `draft create` (or `draft update` with the key returned before — keep it so later edits update the same draft instead of creating duplicates).
4. Give the user the `editUrl`. If they want it public, follow `note-cli:publish`.

On `AUTH_ERROR` the session has expired: log in again as described above. An `API_ERROR` with `email_activation` means the account has not verified its email address yet.
