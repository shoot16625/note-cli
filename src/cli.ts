import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { analyzeNotes } from "./analyze.ts";
import * as api from "./api.ts";
import { CliError, NoteClient } from "./client.ts";
import { browserLogin } from "./login.ts";
import { htmlToText, markdownToNoteHtml, parseArticle } from "./markdown.ts";
import { normalizeNote } from "./normalize.ts";
import { clearSession, loadSession, parseCookieHeader, saveSession, sessionPath } from "./session.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | undefined>;

interface Command {
  usage: string;
  summary: string;
  options?: Options;
  /** minimum number of positional args */
  args?: number;
  run(ctx: { values: Values; positionals: string[]; client: NoteClient }): Promise<unknown>;
}

const SORTS = ["popular", "hot", "new"];

const COMMANDS: Record<string, Command> = {
  // ---------------- auth ----------------
  "auth login": {
    usage: "auth login [--timeout <sec>] [--browser <path to Chrome/Edge/Chromium>]",
    summary: "Open a browser, log in to note.com by hand, and save the session cookies",
    options: { timeout: { type: "string", default: "300" }, browser: { type: "string" } },
    async run({ values }) {
      const cookies = await browserLogin({
        timeoutSec: int(values.timeout, "timeout"),
        browser: typeof values.browser === "string" ? values.browser : undefined,
        isLoggedIn: async (c) => {
          try {
            await api.currentUser(new NoteClient({ session: { cookies: c, savedAt: "probe" } }));
            return true;
          } catch {
            return false;
          }
        },
      });
      return finishLogin(cookies);
    },
  },
  "auth import": {
    usage: "auth import [--cookie '<Cookie header>']   (or pipe the header via stdin)",
    summary: "Save a session from a Cookie header copied from browser DevTools",
    options: { cookie: { type: "string" } },
    async run({ values }) {
      const raw = typeof values.cookie === "string" ? values.cookie : await readStdin();
      const cookies = parseCookieHeader(raw.trim());
      if (!cookies._note_session_v5) {
        throw new CliError("INVALID_INPUT", "The cookie string must contain _note_session_v5.");
      }
      return finishLogin(cookies);
    },
  },
  "auth status": {
    usage: "auth status",
    summary: "Show whether the saved session is valid and which account it belongs to",
    async run({ client }) {
      const session = await loadSession();
      if (!session) return { loggedIn: false, sessionPath: sessionPath() };
      try {
        const me = await api.currentUser(client);
        return { loggedIn: true, urlname: me.urlname, nickname: me.nickname, userId: me.id, savedAt: session.savedAt };
      } catch (e) {
        if (e instanceof CliError && (e.code === "AUTH_ERROR" || e.code === "NOT_LOGGED_IN")) {
          return { loggedIn: false, reason: e.message, sessionPath: sessionPath() };
        }
        throw e;
      }
    },
  },
  "auth logout": {
    usage: "auth logout",
    summary: "Delete the saved session file",
    async run() {
      return { removed: await clearSession(), sessionPath: sessionPath() };
    },
  },

  // ---------------- drafts ----------------
  "draft create": {
    usage: "draft create <file.md|-> [--title <title>] [--dry-run]",
    summary: "Create a new draft from Markdown (title: frontmatter `title:` or first `# H1`)",
    options: { title: { type: "string" }, "dry-run": { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const article = await loadArticle(positionals[0], values.title);
      if (values["dry-run"]) return { dryRun: true, ...article };
      const draft = await api.createDraft(client, article.title);
      await api.saveDraft(client, draft.id, article);
      return { created: true, ...draft, title: article.title, bodyLength: article.bodyLength, warnings: article.warnings };
    },
  },
  "draft update": {
    usage: "draft update <id|key|url> <file.md|-> [--title <title>] [--dry-run]",
    summary: "Overwrite an existing draft's title and body with Markdown",
    options: { title: { type: "string" }, "dry-run": { type: "boolean" } },
    args: 2,
    async run({ values, positionals, client }) {
      const article = await loadArticle(positionals[1], values.title);
      if (values["dry-run"]) return { dryRun: true, ...article };
      const { id, key } = await api.resolveNoteId(client, positionals[0]);
      await api.saveDraft(client, id, article);
      return {
        updated: true,
        id,
        key,
        editUrl: key ? api.editUrl(key) : null,
        title: article.title,
        bodyLength: article.bodyLength,
        warnings: article.warnings,
      };
    },
  },
  "draft get": {
    usage: "draft get <key|url> [--html]",
    summary: "Read a draft (or your own article) as the editor sees it",
    options: { html: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const data = await api.getDraft(client, noteKey(positionals[0]));
      const draft = data?.note_draft ?? data;
      const html: string = draft?.body ?? data?.body ?? "";
      return {
        id: data?.id,
        key: data?.key,
        status: data?.status,
        title: draft?.name ?? data?.name,
        editUrl: data?.key ? api.editUrl(data.key) : null,
        ...(values.html ? { bodyHtml: html } : { bodyText: htmlToText(html) }),
      };
    },
  },
  "draft list": {
    usage: "draft list [--page <n>] [--status draft|published]",
    summary: "List your own articles (drafts and published) from the note list",
    options: { page: { type: "string", default: "1" }, status: { type: "string" } },
    async run({ values, client }) {
      const res = await api.myNotes(client, int(values.page, "page"));
      const items = values.status ? res.items.filter((n) => n.status === values.status) : res.items;
      return { page: int(values.page, "page"), isLastPage: res.isLastPage, count: items.length, notes: items };
    },
  },
  "draft delete": {
    usage: "draft delete <id|key|url> --yes",
    summary: "Delete a draft (drafts only; published articles are not affected)",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      if (!values.yes) throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the draft.");
      const { id, key } = await api.resolveNoteId(client, positionals[0]);
      await api.deleteDraft(client, id);
      return { deleted: true, id, key };
    },
  },

  // ---------------- read ----------------
  search: {
    usage: "search <query> [--sort popular|hot|new] [--limit <n>] [--start <n>]",
    summary: "Search articles by keyword",
    options: {
      sort: { type: "string", default: "popular" },
      limit: { type: "string", default: "20" },
      start: { type: "string", default: "0" },
    },
    args: 1,
    async run({ values, positionals, client }) {
      const q = positionals.join(" ");
      const res = await api.searchNotes(client, q, {
        sort: oneOf(values.sort, SORTS, "sort") as api.SearchSort,
        limit: int(values.limit, "limit"),
        start: int(values.start, "start"),
      });
      return { query: q, total: res.total, count: res.items.length, notes: res.items };
    },
  },
  hashtag: {
    usage: "hashtag <tag> [--order popular|hot|new] [--limit <n>] [--paid-only]",
    summary: "List articles for a hashtag",
    options: {
      order: { type: "string", default: "popular" },
      limit: { type: "string", default: "50" },
      "paid-only": { type: "boolean" },
    },
    args: 1,
    async run({ values, positionals, client }) {
      const res = await api.hashtagNotes(client, positionals[0], {
        order: oneOf(values.order, SORTS, "order") as api.HashtagOrder,
        limit: int(values.limit, "limit"),
        paidOnly: Boolean(values["paid-only"]),
      });
      return { hashtag: positionals[0].replace(/^#/, ""), total: res.total, count: res.items.length, notes: res.items };
    },
  },
  user: {
    usage: "user <urlname> [--limit <n>]",
    summary: "Show a creator's profile and recent articles",
    options: { limit: { type: "string", default: "20" } },
    args: 1,
    async run({ values, positionals, client }) {
      const urlname = positionals[0];
      const creator = await api.getCreator(client, urlname);
      const res = await api.creatorNotes(client, urlname, { limit: int(values.limit, "limit") });
      return {
        profile: {
          urlname: creator?.urlname,
          nickname: creator?.nickname,
          profile: creator?.profile,
          noteCount: creator?.noteCount,
          followerCount: creator?.followerCount,
          followingCount: creator?.followingCount,
        },
        total: res.total,
        count: res.items.length,
        notes: res.items,
      };
    },
  },
  note: {
    usage: "note <key|url> [--html]",
    summary: "Read a published article (summary + body text)",
    options: { html: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const data = await api.getNote(client, noteKey(positionals[0]));
      const body: string = data?.body ?? "";
      return {
        ...normalizeNote(data ?? {}),
        description: data?.description ?? null,
        canRead: data?.can_read ?? data?.canRead ?? null,
        ...(values.html ? { bodyHtml: body } : { bodyText: htmlToText(body) }),
      };
    },
  },

  // ---------------- analysis ----------------
  "analyze search": {
    usage: "analyze search <query> [--sort popular|hot|new] [--limit <n>] [--top <n>]",
    summary: "Fetch search results and summarize likes, pricing, titles and timing",
    options: {
      sort: { type: "string", default: "popular" },
      limit: { type: "string", default: "100" },
      top: { type: "string", default: "10" },
    },
    args: 1,
    async run({ values, positionals, client }) {
      const q = positionals.join(" ");
      const res = await api.searchNotes(client, q, {
        sort: oneOf(values.sort, SORTS, "sort") as api.SearchSort,
        limit: int(values.limit, "limit"),
      });
      return { source: { type: "search", query: q, sort: values.sort, total: res.total }, ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    },
  },
  "analyze hashtag": {
    usage: "analyze hashtag <tag> [--order popular|hot|new] [--limit <n>] [--top <n>]",
    summary: "Fetch a hashtag's articles and summarize them",
    options: {
      order: { type: "string", default: "popular" },
      limit: { type: "string", default: "100" },
      top: { type: "string", default: "10" },
    },
    args: 1,
    async run({ values, positionals, client }) {
      const res = await api.hashtagNotes(client, positionals[0], {
        order: oneOf(values.order, SORTS, "order") as api.HashtagOrder,
        limit: int(values.limit, "limit"),
      });
      return { source: { type: "hashtag", hashtag: positionals[0], order: values.order, total: res.total }, ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    },
  },
  "analyze user": {
    usage: "analyze user <urlname> [--limit <n>] [--top <n>]",
    summary: "Summarize a creator's articles (yours or a competitor's)",
    options: { limit: { type: "string", default: "100" }, top: { type: "string", default: "10" } },
    args: 1,
    async run({ values, positionals, client }) {
      const res = await api.creatorNotes(client, positionals[0], { limit: int(values.limit, "limit") });
      return { source: { type: "user", urlname: positionals[0], total: res.total }, ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    },
  },
  "stats pv": {
    usage: "stats pv [--filter all|daily|weekly|monthly] [--sort pv|like|comment] [--page <n>]",
    summary: "Your own page views / likes / comments per article (requires login)",
    options: {
      filter: { type: "string", default: "all" },
      sort: { type: "string", default: "pv" },
      page: { type: "string", default: "1" },
    },
    async run({ values, client }) {
      return api.statsPv(client, {
        filter: oneOf(values.filter, ["all", "daily", "weekly", "monthly"], "filter") as api.PvFilter,
        sort: oneOf(values.sort, ["pv", "like", "comment"], "sort") as api.PvSort,
        page: int(values.page, "page"),
      });
    },
  },
};

// ---------------- helpers ----------------

async function finishLogin(cookies: Record<string, string>) {
  const probe = new NoteClient({ session: { cookies, savedAt: new Date().toISOString() } });
  const me = await api.currentUser(probe);
  const path = await saveSession({ cookies, urlname: me.urlname, userId: me.id, savedAt: new Date().toISOString() });
  return { loggedIn: true, urlname: me.urlname, nickname: me.nickname, sessionPath: path };
}

async function loadArticle(file: string, titleOverride: string | boolean | undefined) {
  const source = file === "-" ? await readStdin() : await readFile(file, "utf8").catch((e) => {
    throw new CliError("INVALID_INPUT", `Cannot read ${file}: ${(e as Error).message}`);
  });
  const parsed = parseArticle(source);
  const title = (typeof titleOverride === "string" && titleOverride) || parsed.title;
  if (!title) throw new CliError("INVALID_INPUT", "No title: add frontmatter `title:`, a leading `# Title`, or --title.");
  const { html, bodyLength, warnings } = markdownToNoteHtml(parsed.markdown);
  return { title, html, bodyLength, warnings };
}

export function noteKey(input: string): string {
  const m = input.match(/(?:^|\/)(n[0-9a-f]{12,})(?:[/?#]|$)/);
  return m ? m[1] : input;
}

function int(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CliError("USAGE", `--${name} must be a non-negative integer.`);
  return n;
}

function oneOf(v: unknown, allowed: string[], name: string): string {
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw new CliError("USAGE", `--${name} must be one of: ${allowed.join(", ")}.`);
  }
  return v;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new CliError("USAGE", "Expected input on stdin.");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function helpText(): string {
  const lines = [
    "note-cli — unofficial note.com CLI (JSON output)",
    "",
    "Usage: note-cli <command> [options]",
    "",
    ...Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.summary}`),
    "",
    "Env: NOTE_COOKIE (Cookie header, overrides saved session), NOTE_CLI_HOME, NOTE_CLI_INTERVAL_MS, NOTE_CLI_DEBUG",
  ];
  return lines.join("\n");
}

function findCommand(argv: string[]): { name: string; cmd: Command; rest: string[] } | null {
  const two = argv.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { name: two, cmd: COMMANDS[two], rest: argv.slice(2) };
  if (argv[0] && COMMANDS[argv[0]]) return { name: argv[0], cmd: COMMANDS[argv[0]], rest: argv.slice(1) };
  return null;
}

export async function main(argv: string[], deps: { client?: NoteClient } = {}): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    console.log(helpText());
    return 0;
  }
  const found = findCommand(argv);
  if (!found) {
    const group = Object.values(COMMANDS).filter((c) => c.usage.startsWith(`${argv[0]} `));
    console.error(group.length ? group.map((c) => `note-cli ${c.usage}`).join("\n") : `Unknown command: ${argv[0]}\n\n${helpText()}`);
    return 2;
  }
  const { cmd, rest } = found;
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`note-cli ${cmd.usage}\n  ${cmd.summary}`);
    return 0;
  }

  try {
    const { values, positionals } = parseArgs({ args: rest, options: cmd.options ?? {}, allowPositionals: true, strict: true });
    if (positionals.length < (cmd.args ?? 0)) throw new CliError("USAGE", `Usage: note-cli ${cmd.usage}`);
    const client = deps.client ?? new NoteClient();
    const result = await cmd.run({ values: values as Values, positionals, client });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      console.error(JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, detail: e.detail } }, null, 2));
      return e.code === "USAGE" ? 2 : 1;
    }
    if ((e as NodeJS.ErrnoException).code?.startsWith?.("ERR_PARSE_ARGS")) {
      console.error(`${(e as Error).message}\nUsage: note-cli ${cmd.usage}`);
      return 2;
    }
    console.error(JSON.stringify({ error: { code: "UNEXPECTED", message: (e as Error).stack ?? String(e) } }, null, 2));
    return 1;
  }
}
