import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { analyzeNotes } from "./analyze.ts";
import * as api from "./api.ts";
import { CliError, NoteClient } from "./client.ts";
import { attachmentMime, createEmbed, embedService, uploadAttachment, type Embed } from "./embeds.ts";
import { browserLogin } from "./login.ts";
import { eyecatchRatioWarning, isLocalImageRef, readImage, resolveImagePath, type ImageFile } from "./images.ts";
import { blockLinks, htmlToText, imageRefs, markdownToNoteHtml, parseArticle, visibleTextLength } from "./markdown.ts";
import { tryNormalizeNote, type Skipped } from "./normalize.ts";
import { buildPublishPayload, publishInBrowser, type CirclePermission, type PublishSettings } from "./publish.ts";
import { clearSession, loadSession, parseCookieHeader, saveSession, sessionPath } from "./session.ts";
import * as v from "./validate.ts";

export { noteKey } from "./validate.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | Array<string | boolean> | undefined>;

export interface Deps {
  client?: NoteClient;
  /** Browser publisher; tests swap it for a fake. */
  publish?: typeof publishInBrowser;
}

interface Command {
  usage: string;
  summary: string;
  options?: Options;
  /** minimum number of positional args */
  args?: number;
  run(ctx: { values: Values; positionals: string[]; client: NoteClient; deps: Deps }): Promise<unknown>;
}

const SORTS = ["popular", "hot", "new"];
const DEFAULT_MAX_CHARS = "20000";

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
    usage: "auth import [--cookie '<Cookie header or _note_session_v5 value>']   (or pipe it via stdin)",
    summary: "Save a session from a Cookie header (or just the _note_session_v5 value) copied from browser DevTools",
    options: { cookie: { type: "string" } },
    async run({ values }) {
      const raw = typeof values.cookie === "string" ? values.cookie : await readStdin();
      return finishLogin(parseImportedCookies(raw));
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
    usage: "draft create <file.md|-> [--title <title>] [--eyecatch <image>] [--no-embed] [--dry-run]",
    summary: "Create a new draft from Markdown; local images are uploaded, a URL alone on its line becomes an embed, a link alone to a local file an attachment",
    options: { title: { type: "string" }, eyecatch: { type: "string" }, "no-embed": { type: "boolean" }, "dry-run": { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const input = await readArticleInput(positionals[0], values);
      if (values["dry-run"]) return dryRunResult(input);
      // Images first, so a rejected image does not leave an empty draft behind.
      const imageUrls = await uploadImages(client, input);
      const draft = await api.createDraft(client, input.title);
      const article = await uploadAndConvert(client, input, draft.key, imageUrls);
      await api.saveDraft(client, draft.id, article);
      const eyecatch = await applyEyecatch(client, draft.id, input.eyecatch);
      return {
        created: true,
        ...draft,
        title: article.title,
        bodyLength: article.bodyLength,
        ...imagesField(article.images, eyecatch, article.embeds),
        warnings: [...article.warnings, ...eyecatch.warnings],
      };
    },
  },
  "draft update": {
    usage: "draft update <id|key|url> <file.md|-> [--title <title>] [--eyecatch <image>] [--no-embed] [--dry-run]",
    summary: "Overwrite an existing draft's title and body with Markdown (images, embeds and attachments as in draft create)",
    options: { title: { type: "string" }, eyecatch: { type: "string" }, "no-embed": { type: "boolean" }, "dry-run": { type: "boolean" } },
    args: 2,
    async run({ values, positionals, client }) {
      const ref = v.noteIdOrKey(positionals[0]);
      const input = await readArticleInput(positionals[1], values);
      if (values["dry-run"]) return dryRunResult(input);
      const { id, key } = await api.resolveNoteId(client, ref);
      const article = await uploadAndConvert(client, input, key);
      await api.saveDraft(client, id, article);
      const eyecatch = await applyEyecatch(client, id, input.eyecatch);
      return {
        updated: true,
        id,
        key,
        editUrl: key ? api.editUrl(key) : null,
        title: article.title,
        bodyLength: article.bodyLength,
        ...imagesField(article.images, eyecatch, article.embeds),
        warnings: [...article.warnings, ...eyecatch.warnings],
      };
    },
  },
  "draft get": {
    usage: "draft get <key|url> [--html] [--max-chars <n>]",
    summary: "Read a draft (or your own article) as the editor sees it",
    options: { html: { type: "boolean" }, "max-chars": { type: "string", default: DEFAULT_MAX_CHARS } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = v.noteKey(positionals[0]);
      const maxChars = int(values["max-chars"], "max-chars");
      const data = await api.getDraft(client, key);
      if (!data || typeof data !== "object") throw new CliError("NOT_FOUND", `No draft data for ${key}.`);
      const draft = data.note_draft ?? data;
      const html: string = typeof draft.body === "string" ? draft.body : typeof data.body === "string" ? data.body : "";
      return {
        id: data.id,
        key: data.key,
        status: data.status,
        title: draft.name ?? data.name,
        editUrl: data.key ? api.editUrl(data.key) : null,
        ...bodyField(html, Boolean(values.html), maxChars),
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
      return { page: int(values.page, "page"), isLastPage: res.isLastPage, count: items.length, notes: items, ...skippedField(res.skipped) };
    },
  },
  "draft delete": {
    usage: "draft delete <id|key|url> --yes",
    summary: "Delete a draft (drafts only; use `delete` for a published article)",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const ref = v.noteIdOrKey(positionals[0]);
      if (!values.yes) throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the draft.");
      const { id, key } = await api.resolveNoteId(client, ref);
      await api.deleteDraft(client, id);
      return { deleted: true, id, key };
    },
  },

  // ---------------- read ----------------
  search: {
    usage: "search <query> [--type note|user|magazine|hashtag] [--sort popular|hot|new] [--limit <n>] [--start <n>]",
    summary: "Search articles (default), creators, magazines or hashtags by keyword (--sort applies to articles only)",
    options: {
      type: { type: "string", default: "note" },
      sort: { type: "string", default: "popular" },
      limit: { type: "string", default: "20" },
      start: { type: "string", default: "0" },
    },
    args: 1,
    async run({ values, positionals, client }) {
      const q = positionals.join(" ");
      const type = oneOf(values.type, ["note", "user", "magazine", "hashtag"], "type");
      if (type !== "note") {
        const res = await api.searchOther(client, type as api.SearchType, q, {
          limit: int(values.limit, "limit"),
          start: int(values.start, "start"),
        });
        const field = { user: "users", magazine: "magazines", hashtag: "hashtags" }[type as api.SearchType];
        return { query: q, type, total: res.total, count: res.items.length, exhausted: res.exhausted, [field]: res.items, ...skippedField(res.skipped) };
      }
      const res = await api.searchNotes(client, q, {
        sort: oneOf(values.sort, SORTS, "sort") as api.SearchSort,
        limit: int(values.limit, "limit"),
        start: int(values.start, "start"),
      });
      return { query: q, total: res.total, count: res.items.length, exhausted: res.exhausted, notes: res.items, ...skippedField(res.skipped) };
    },
  },
  hashtag: {
    usage: "hashtag <tag> [--order popular|hot|new] [--limit <n>] [--paid-only]",
    summary: "List articles for a hashtag, with its total article count and related hashtags",
    options: {
      order: { type: "string", default: "popular" },
      limit: { type: "string", default: "50" },
      "paid-only": { type: "boolean" },
    },
    args: 1,
    async run({ values, positionals, client }) {
      const tag = v.hashtag(positionals[0]);
      const order = oneOf(values.order, SORTS, "order") as api.HashtagOrder;
      // Extra details only: the article list below is the command's main result.
      const info = await api.hashtagInfo(client, tag).catch((e) => {
        if (e instanceof CliError && e.code !== "NOT_LOGGED_IN") return null;
        throw e;
      });
      const res = await api.hashtagNotes(client, tag, {
        order,
        limit: int(values.limit, "limit"),
        paidOnly: Boolean(values["paid-only"]),
      });
      return {
        hashtag: tag,
        articleCount: info?.count ?? null,
        relatedHashtags: info?.related ?? [],
        total: res.total,
        count: res.items.length, exhausted: res.exhausted, notes: res.items, ...skippedField(res.skipped) };
    },
  },
  user: {
    usage: "user <urlname> [--limit <n>]",
    summary: "Show a creator's profile and recent articles",
    options: { limit: { type: "string", default: "20" } },
    args: 1,
    async run({ values, positionals, client }) {
      const urlname = v.urlname(positionals[0]);
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
        exhausted: res.exhausted,
        notes: res.items,
        ...skippedField(res.skipped),
      };
    },
  },
  note: {
    usage: "note <key|url> [--html] [--max-chars <n>]",
    summary: "Read a published article (summary + body text; paid parts are hidden)",
    options: { html: { type: "boolean" }, "max-chars": { type: "string", default: DEFAULT_MAX_CHARS } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = v.noteKey(positionals[0]);
      const maxChars = int(values["max-chars"], "max-chars");
      const data = await api.getNote(client, key);
      const summary = tryNormalizeNote(data);
      if (typeof summary === "string") {
        throw new CliError("API_ERROR", `Unexpected response for ${key}: ${summary}.`);
      }
      const body: string = typeof data.body === "string" ? data.body : "";
      return {
        ...summary,
        description: data.description ?? null,
        canRead: data.can_read ?? data.canRead ?? null,
        ...bodyField(body, Boolean(values.html), maxChars),
      };
    },
  },

  likes: {
    usage: "likes <key|url> [--limit <n>]",
    summary: "List who liked an article (newest first)",
    options: { limit: { type: "string", default: "50" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = v.noteKey(positionals[0]);
      const res = await api.noteLikes(client, key, { limit: int(values.limit, "limit") });
      return { key, total: res.total, count: res.items.length, exhausted: res.exhausted, likes: res.items, ...skippedField(res.skipped) };
    },
  },
  comments: {
    usage: "comments <key|url> [--limit <n>]",
    summary: "Read an article's comments (top-level; replies are counted in replyCount)",
    options: { limit: { type: "string", default: "50" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = v.noteKey(positionals[0]);
      const res = await api.noteComments(client, key, { limit: int(values.limit, "limit") });
      return { key, total: res.total, count: res.items.length, exhausted: res.exhausted, comments: res.items, ...skippedField(res.skipped) };
    },
  },
  magazine: {
    usage: "magazine <key|url> [--limit <n>]",
    summary: "Show a magazine and its articles (in the magazine's order)",
    options: { limit: { type: "string", default: "20" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = v.magazineKey(positionals[0]);
      const magazine = await api.getMagazine(client, key);
      const res = await api.magazineNotes(client, key, { limit: int(values.limit, "limit") });
      return { magazine, count: res.items.length, exhausted: res.exhausted, notes: res.items, ...skippedField(res.skipped) };
    },
  },
  categories: {
    usage: "categories",
    summary: "List note's article categories (use the slug with `category`)",
    async run({ client }) {
      return { categories: await api.categories(client) };
    },
  },
  category: {
    usage: "category <slug> [--sort new|trend] [--limit <n>]",
    summary: "List articles in a category; `featured` is note's editorial pick (sort does not apply)",
    options: { sort: { type: "string", default: "new" }, limit: { type: "string", default: "20" } },
    args: 1,
    async run({ values, positionals, client }) {
      const slug = v.categorySlug(positionals[0]);
      const sort = oneOf(values.sort, ["new", "trend"], "sort") as api.CategorySort;
      const res = await api.categoryNotes(client, slug, { sort, limit: int(values.limit, "limit") });
      return { category: slug, sort: slug === "featured" ? null : sort, count: res.items.length, exhausted: res.exhausted, notes: res.items, ...skippedField(res.skipped) };
    },
  },
  contests: {
    usage: "contests [--state opened|closed|finished|all] [--type contest|theme|all] [--limit <n>]",
    summary: "List note's contests and themed hashtags (closing soonest first)",
    options: {
      state: { type: "string", default: "opened" },
      type: { type: "string", default: "all" },
      limit: { type: "string", default: "50" },
    },
    async run({ values, client }) {
      const state = oneOf(values.state, ["opened", "closed", "finished", "all"], "state");
      const type = oneOf(values.type, ["contest", "theme", "all"], "type");
      const limit = int(values.limit, "limit");
      const res = await api.contests(client);
      const items = res.items
        .filter((c) => state === "all" || c.state === state)
        // "theme" is an always-on hashtag theme; everything else (contest, contestLight, ...) is a real contest.
        .filter((c) => type === "all" || (type === "theme") === (c.type === "theme"))
        .sort((a, b) => (a.closeAt ?? "9999").localeCompare(b.closeAt ?? "9999"));
      return { state, type, total: items.length, count: Math.min(items.length, limit), contests: items.slice(0, limit), ...skippedField(res.skipped) };
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
      return { source: { type: "search", query: q, sort: values.sort, total: res.total }, ...skippedField(res.skipped), ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
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
      const tag = v.hashtag(positionals[0]);
      const res = await api.hashtagNotes(client, tag, {
        order: oneOf(values.order, SORTS, "order") as api.HashtagOrder,
        limit: int(values.limit, "limit"),
      });
      return { source: { type: "hashtag", hashtag: tag, order: values.order, total: res.total }, ...skippedField(res.skipped), ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    },
  },
  "analyze user": {
    usage: "analyze user <urlname> [--limit <n>] [--top <n>]",
    summary: "Summarize a creator's articles (yours or a competitor's)",
    options: { limit: { type: "string", default: "100" }, top: { type: "string", default: "10" } },
    args: 1,
    async run({ values, positionals, client }) {
      const urlname = v.urlname(positionals[0]);
      const res = await api.creatorNotes(client, urlname, { limit: int(values.limit, "limit") });
      return { source: { type: "user", urlname, total: res.total }, ...skippedField(res.skipped), ...analyzeNotes(res.items, { top: int(values.top, "top") }) };
    },
  },
  "stats pv": {
    usage: "stats pv [--filter all|daily|weekly|monthly|yearly] [--sort pv|like|comment] [--page <n>]",
    summary: "Your own page views / likes / comments per article (requires login)",
    options: {
      filter: { type: "string", default: "all" },
      sort: { type: "string", default: "pv" },
      page: { type: "string", default: "1" },
    },
    async run({ values, client }) {
      return api.statsPv(client, {
        filter: oneOf(values.filter, ["all", "daily", "weekly", "monthly", "yearly"], "filter") as api.PvFilter,
        sort: oneOf(values.sort, ["pv", "like", "comment"], "sort") as api.PvSort,
        page: int(values.page, "page"),
      });
    },
  },

  "stats dashboard": {
    usage:
      "stats dashboard [--period 7d|28d|365d|all|this-month|last-month|custom] [--from <YYYY-MM-DD> --to <YYYY-MM-DD>] [--order published|pv|impressions|likes|comments|sales] [--limit <n>]",
    summary:
      "Your dashboard for a period (requires login): totals incl. impressions and sales, where readers came from, and per-article numbers",
    options: {
      period: { type: "string", default: "28d" },
      from: { type: "string" },
      to: { type: "string" },
      order: { type: "string", default: "pv" },
      limit: { type: "string", default: "20" },
    },
    async run({ values, client }) {
      const range = dashboardRangeFrom(values);
      const order = oneOf(values.order, Object.keys(api.DASHBOARD_ORDERS), "order") as api.DashboardOrder;
      const limit = int(values.limit, "limit");
      const summary = await api.dashboardSummary(client, range);
      const referrers = await api.dashboardReferrers(client, range);
      const notes = limit > 0 ? await api.dashboardNotes(client, range, { order, limit }) : [];
      return {
        period: values.period,
        from: range.from,
        to: range.to,
        lastUpdatedAt: summary.lastUpdatedAt,
        totals: summary.totals,
        referrers,
        ...(limit > 0 ? { order, notes } : {}),
      };
    },
  },
  "stats chart": {
    usage:
      "stats chart [--metric pv|impressions|likes|comments|sales] [--period 7d|28d|365d|all|this-month|last-month|custom] [--from <YYYY-MM-DD> --to <YYYY-MM-DD>]",
    summary: "One of your metrics over time (by day, week or month depending on the period; requires login)",
    options: {
      metric: { type: "string", default: "pv" },
      period: { type: "string", default: "28d" },
      from: { type: "string" },
      to: { type: "string" },
    },
    async run({ values, client }) {
      const metric = oneOf(values.metric, Object.keys(api.DASHBOARD_METRICS), "metric") as api.DashboardMetric;
      const range = dashboardRangeFrom(values);
      return { metric, period: values.period, from: range.from, to: range.to, ...(await api.dashboardChart(client, range, metric)) };
    },
  },

  // ---------------- publishing ----------------
  publish: {
    usage:
      "publish <key|url> [file.md|-] --yes [--hashtag <tag>]... [--price <yen>] [--magazine <key>]... [--membership all|none|<planKey>]... [--schedule <time>] [--toc] [--disable-comments] [--refund] [--no-notify] [--hide-from-profile] [--title <t>] [--eyecatch <image>] [--no-embed] [--dry-run] [--browser <path>] [--timeout <sec>]",
    summary:
      "Publish a draft (or re-publish an article), optionally saving a Markdown file to it first. A browser window opens briefly to pass note's reCAPTCHA",
    options: {
      yes: { type: "boolean" },
      hashtag: { type: "string", multiple: true },
      price: { type: "string", default: "0" },
      magazine: { type: "string", multiple: true },
      membership: { type: "string", multiple: true },
      "hide-from-profile": { type: "boolean" },
      schedule: { type: "string" },
      toc: { type: "boolean" },
      "disable-comments": { type: "boolean" },
      refund: { type: "boolean" },
      "no-notify": { type: "boolean" },
      "no-embed": { type: "boolean" },
      title: { type: "string" },
      eyecatch: { type: "string" },
      "dry-run": { type: "boolean" },
      browser: { type: "string" },
      timeout: { type: "string", default: "120" },
    },
    args: 1,
    async run({ values, positionals, client, deps }) {
      const key = v.noteKey(positionals[0]);
      const settings = publishSettings(values);
      const membership = list(values.membership);
      if (membership.length) settings.circlePermissions = circlePermissions(membership, await api.membershipAccess(client));
      const timeoutSec = int(values.timeout, "timeout");
      const input = positionals[1] ? await readArticleInput(positionals[1], values) : null;

      if (values["dry-run"]) {
        const note = input
          ? { name: input.title, body: dryRunResult(input).html, slug: null, key }
          : await savedNote(client, key);
        return { dryRun: true, key, ...publishPreview(buildPublishPayload(note, settings)) };
      }
      if (!values.yes) {
        throw new CliError("CONFIRMATION_REQUIRED", "Publishing makes the article public. Pass --yes to publish (try --dry-run first).");
      }
      const session = await client.getSession();
      if (!session?.cookies._note_session_v5) {
        throw new CliError("NOT_LOGGED_IN", "Not logged in. Run `note-cli auth login` (or `note-cli auth import`).");
      }

      const current = await api.getDraft(client, key);
      if (!current?.id) throw new CliError("NOT_FOUND", `Could not find your article ${key}.`);
      const id = Number(current.id);
      let note = noteFromDraft(current);
      const extra: Record<string, unknown> = {};
      const warnings: string[] = [];
      if (input) {
        const article = await uploadAndConvert(client, input, key);
        await api.saveDraft(client, id, article);
        const eyecatch = await applyEyecatch(client, id, input.eyecatch);
        note = { ...note, name: article.title, body: article.html };
        Object.assign(extra, imagesField(article.images, eyecatch, article.embeds));
        warnings.push(...article.warnings, ...eyecatch.warnings);
      }
      const payload = buildPublishPayload(note, settings);

      const res = await (deps.publish ?? publishInBrowser)({
        cookies: session.cookies,
        noteId: id,
        noteKey: key,
        payload,
        browser: typeof values.browser === "string" ? values.browser : undefined,
        timeoutSec,
      });
      if (res.status < 200 || res.status >= 300) throw publishError(res, settings);
      const urlname = session.urlname ?? current.user?.urlname;
      return {
        [settings.publishAt ? "scheduled" : "published"]: true,
        id,
        key,
        title: note.name,
        url: res.body?.data?.note_url ?? (urlname ? `https://note.com/${urlname}/n/${key}` : null),
        ...(settings.publishAt ? { publishAt: settings.publishAt } : {}),
        price: settings.price,
        hashtags: settings.hashtags,
        ...extra,
        warnings,
      };
    },
  },
  unpublish: {
    usage: "unpublish <key|url> --yes",
    summary: "Turn a published (or scheduled) article back into a draft; paid or sold articles cannot be",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = v.noteKey(positionals[0]);
      if (!values.yes) throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to take the article down (it becomes a draft).");
      await api.changeToDraft(client, key);
      return { unpublished: true, key, status: "draft" };
    },
  },
  delete: {
    usage: "delete <key|url> --yes",
    summary: "Delete one of your articles for good; a published one is turned back into a draft first",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const key = v.noteKey(positionals[0]);
      if (!values.yes) throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the article. This cannot be undone.");
      const data = await api.getDraft(client, key);
      if (!data?.id) throw new CliError("NOT_FOUND", `Could not find your article ${key}.`);
      const id = Number(data.id);
      const wasStatus: string | null = typeof data.status === "string" ? data.status : null;
      if (wasStatus && wasStatus !== "draft") await api.changeToDraft(client, key);
      await api.deleteDraft(client, id);
      return { deleted: true, id, key, wasStatus };
    },
  },
  reserved: {
    usage: "reserved",
    summary: "List your scheduled articles",
    async run({ client }) {
      const res = await api.reservedNotes(client);
      return { count: res.items.length, notes: res.items, ...skippedField(res.skipped) };
    },
  },

  // ---------------- engagement ----------------
  like: {
    usage: "like <key|url>",
    summary: "Like (スキ) an article",
    args: 1,
    async run({ positionals, client }) {
      const key = v.noteKey(positionals[0]);
      await api.likeNote(client, key, true);
      return { liked: true, key };
    },
  },
  unlike: {
    usage: "unlike <key|url>",
    summary: "Remove your like from an article",
    args: 1,
    async run({ positionals, client }) {
      const key = v.noteKey(positionals[0]);
      await api.likeNote(client, key, false);
      return { liked: false, key };
    },
  },
  comment: {
    usage: "comment <key|url> <text|-> [--reply-to <commentKey>]",
    summary: "Post a comment (or a reply) on an article; `-` reads the text from stdin",
    options: { "reply-to": { type: "string" } },
    args: 2,
    async run({ values, positionals, client }) {
      const key = v.noteKey(positionals[0]);
      const text = (positionals[1] === "-" && positionals.length === 2 ? await readStdin() : positionals.slice(1).join(" ")).trim();
      if (!text) throw new CliError("INVALID_INPUT", "The comment is empty.");
      const replyTo = typeof values["reply-to"] === "string" ? v.token(values["reply-to"], "comment key") : undefined;
      try {
        return { posted: true, key, comment: await api.postComment(client, key, text, { replyTo }) };
      } catch (e) {
        if (e instanceof CliError && (e.detail as any)?.error?.type === "comment_acknowledgement") {
          throw new CliError(
            "COMMENT_GUIDELINES",
            "note asks you to accept its comment guidelines once: open any article in a browser, start a comment, and accept the guidelines. Then retry.",
            { status: e.status, detail: e.detail },
          );
        }
        throw e;
      }
    },
  },
  "comment delete": {
    usage: "comment delete <key|url> <commentKey> --yes",
    summary: "Delete a comment (your own, or any comment on your article)",
    options: { yes: { type: "boolean" } },
    args: 2,
    async run({ values, positionals, client }) {
      const key = v.noteKey(positionals[0]);
      const commentKey = v.token(positionals[1], "comment key");
      if (!values.yes) throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the comment.");
      await api.deleteComment(client, key, commentKey);
      return { deleted: true, key, commentKey };
    },
  },
  follow: {
    usage: "follow <urlname>",
    summary: "Follow a creator",
    args: 1,
    async run({ positionals, client }) {
      return follow(client, v.urlname(positionals[0]), true);
    },
  },
  unfollow: {
    usage: "unfollow <urlname>",
    summary: "Unfollow a creator",
    args: 1,
    async run({ positionals, client }) {
      return follow(client, v.urlname(positionals[0]), false);
    },
  },
  magazines: {
    usage: "magazines [--note <key|url>]",
    summary: "List your own magazines (with --note: whether that article is already in each)",
    options: { note: { type: "string" } },
    async run({ values, client }) {
      const note = typeof values.note === "string" ? v.noteKey(values.note) : undefined;
      const items = await api.myMagazines(client, note);
      return { count: items.length, magazines: items };
    },
  },
  "magazine add": {
    usage: "magazine add <magazineKey|url> <noteKey|url>",
    summary: "Add an article (yours or anyone's published one) to your magazine",
    args: 2,
    async run({ positionals, client }) {
      const magazine = v.magazineKey(positionals[0]);
      const key = v.noteKey(positionals[1]);
      await api.addToMagazine(client, magazine, key, true);
      return { added: true, magazine, key };
    },
  },
  "magazine remove": {
    usage: "magazine remove <magazineKey|url> <noteKey|url>",
    summary: "Remove an article from your magazine",
    args: 2,
    async run({ positionals, client }) {
      const magazine = v.magazineKey(positionals[0]);
      const key = v.noteKey(positionals[1]);
      await api.addToMagazine(client, magazine, key, false);
      return { removed: true, magazine, key };
    },
  },

  // ---------------- account ----------------
  notices: {
    usage: "notices",
    summary: "Unread notification and message counts",
    async run({ client }) {
      return api.noticeCounts(client);
    },
  },
  "membership plans": {
    usage: "membership plans",
    summary: "Your membership (メンバーシップ) plans",
    async run({ client }) {
      const plans = await api.membershipPlans(client);
      return { count: plans.length, plans };
    },
  },
  "membership joined": {
    usage: "membership joined",
    summary: "Memberships you belong to",
    async run({ client }) {
      return api.membershipSummaries(client);
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

interface ArticleInput {
  title: string;
  markdown: string;
  /** Markdown image src -> the local file it points to (already read and validated). */
  images: Map<string, ImageFile>;
  eyecatch: ImageFile | null;
  /** Bare URLs on their own line, to embed (empty with --no-embed). */
  embedUrls: string[];
  /** Markdown link href -> the local file to attach. */
  attachments: Map<string, AttachmentFile>;
}

interface AttachmentFile {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

/**
 * Read the Markdown and every local image it references, so missing or unsupported images fail
 * before anything is uploaded. Image paths are relative to the Markdown file (or the cwd for stdin);
 * frontmatter `eyecatch:` is too, while --eyecatch is relative to the cwd.
 */
async function readArticleInput(file: string, values: Values): Promise<ArticleInput> {
  const source = file === "-" ? await readStdin() : await readFile(file, "utf8").catch((e) => {
    throw new CliError("INVALID_INPUT", `Cannot read ${file}: ${(e as Error).message}`);
  });
  const baseDir = file === "-" ? process.cwd() : dirname(resolve(file));
  const parsed = parseArticle(source);
  const title = (typeof values.title === "string" && values.title) || parsed.title;
  if (!title) throw new CliError("INVALID_INPUT", "No title: add frontmatter `title:`, a leading `# Title`, or --title.");

  const images = new Map<string, ImageFile>();
  const byPath = new Map<string, ImageFile>();
  for (const src of imageRefs(parsed.markdown).filter(isLocalImageRef)) {
    const path = resolveImagePath(src, baseDir);
    const image = byPath.get(path) ?? (await readImage(path));
    byPath.set(path, image);
    images.set(src, image);
  }

  const eyecatchPath =
    typeof values.eyecatch === "string"
      ? resolve(values.eyecatch)
      : parsed.frontmatter.eyecatch
        ? resolveImagePath(parsed.frontmatter.eyecatch, baseDir)
        : null;
  const eyecatch = eyecatchPath ? await readImage(eyecatchPath) : null;

  const links = blockLinks(parsed.markdown);
  const attachments = new Map<string, AttachmentFile>();
  for (const href of links.files) {
    const path = resolveImagePath(href, baseDir);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new CliError("INVALID_INPUT", `Cannot attach ${href}: no such file (${path}). A link alone on its line to a local file becomes a download attachment.`);
    if (info.size > MAX_ATTACHMENT_BYTES) throw new CliError("INVALID_INPUT", `Cannot attach ${path}: larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    attachments.set(href, { path, bytes: new Uint8Array(await readFile(path)), mimeType: attachmentMime(path) });
  }
  return { title, markdown: parsed.markdown, images, eyecatch, embedUrls: values["no-embed"] ? [] : links.urls, attachments };
}

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function dryRunResult(input: ArticleInput) {
  // Preview with the local paths as image sources; nothing is uploaded.
  const preview = new Map([...input.images.keys()].map((src) => [src, src]));
  const { html, bodyLength, warnings } = markdownToNoteHtml(input.markdown, { images: preview });
  return {
    dryRun: true,
    title: input.title,
    html,
    bodyLength,
    images: [...input.images].map(([src, f]) => ({ src, path: f.path, mimeType: f.mimeType, bytes: f.bytes.length })),
    eyecatch: input.eyecatch ? { path: input.eyecatch.path, mimeType: input.eyecatch.mimeType, bytes: input.eyecatch.bytes.length } : null,
    ...(input.embedUrls.length ? { embeds: input.embedUrls.map((url) => ({ url, service: embedService(url) ?? "decided by note (link card or player)" })) } : {}),
    ...(input.attachments.size ? { attachments: [...input.attachments.values()].map((f) => ({ path: f.path, mimeType: f.mimeType, bytes: f.bytes.length })) } : {}),
    warnings: [
      // Attachment links are uploaded on a real run; the preview leaves them as text.
      ...warnings.filter((w) => ![...input.attachments.keys()].some((href) => w.startsWith(`Link "${href}"`))),
      ...(input.eyecatch ? [eyecatchRatioWarning(input.eyecatch)].filter((w): w is string => !!w) : []),
    ],
  };
}

/** Upload each distinct local image once; returns Markdown src -> uploaded URL. */
async function uploadImages(client: NoteClient, input: ArticleInput): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const [src, file] of input.images) {
    let url = byPath.get(file.path);
    if (!url) {
      url = (await api.uploadImage(client, file)).url;
      byPath.set(file.path, url);
    }
    urls.set(src, url);
  }
  return urls;
}

/**
 * Upload each distinct local image once (unless done already), create embeds and attachments on the draft, then convert
 * the Markdown. Embeds and attachments belong to a draft, so they need its key; a failed one is
 * reported as a warning and its line stays a plain link.
 */
async function uploadAndConvert(client: NoteClient, input: ArticleInput, noteKey: string | null, uploaded?: Map<string, string>) {
  const urls = uploaded ?? (await uploadImages(client, input));
  const embeds = new Map<string, Embed>();
  const blockWarnings: string[] = [];
  if (!noteKey && (input.embedUrls.length || input.attachments.size)) {
    blockWarnings.push("Embeds and attachments were skipped because the draft was given by numeric id; pass its key (n...) instead.");
  } else if (noteKey) {
    for (const url of input.embedUrls) {
      try {
        embeds.set(url, await createEmbed(client, noteKey, url));
      } catch (e) {
        if (!(e instanceof CliError) || e.code === "NOT_LOGGED_IN" || e.code === "AUTH_ERROR") throw e;
        blockWarnings.push(`Could not embed ${url} (${e.message}); left as a link.`);
      }
    }
    for (const [href, file] of input.attachments) {
      try {
        embeds.set(href, await uploadAttachment(client, noteKey, file));
      } catch (e) {
        if (!(e instanceof CliError) || e.code === "NOT_LOGGED_IN" || e.code === "AUTH_ERROR") throw e;
        blockWarnings.push(`Could not attach ${file.path} (${e.message}); dropped.`);
      }
    }
  }
  const { html, bodyLength, warnings } = markdownToNoteHtml(input.markdown, { images: urls, embeds });
  return {
    title: input.title,
    html,
    bodyLength,
    warnings: [...blockWarnings, ...warnings],
    images: [...urls].map(([src, url]) => ({ src, url })),
    embeds: [...embeds.values()].map((e) => ({ service: e.service, url: e.url, key: e.key })),
  };
}

interface EyecatchOutcome {
  result: { path: string; set: boolean; url: string | null } | null;
  warnings: string[];
}

/**
 * Set the eyecatch after the draft is saved. A rejection is reported as a warning instead of an
 * error, because the draft itself was already saved and the caller needs its id.
 */
async function applyEyecatch(client: NoteClient, noteId: number, file: ImageFile | null): Promise<EyecatchOutcome> {
  if (!file) return { result: null, warnings: [] };
  try {
    const { url } = await api.setEyecatch(client, noteId, file);
    return { result: { path: file.path, set: true, url }, warnings: [] };
  } catch (e) {
    if (!(e instanceof CliError) || e.code === "NOT_LOGGED_IN") throw e;
    return {
      result: { path: file.path, set: false, url: null },
      warnings: [`${e.message} The draft was saved without an eyecatch; fix the image and run \`draft update\` with --eyecatch.`],
    };
  }
}

function imagesField(images: Array<{ src: string; url: string }>, eyecatch: EyecatchOutcome, embeds: unknown[] = []) {
  return {
    ...(images.length ? { images } : {}),
    ...(embeds.length ? { embeds } : {}),
    ...(eyecatch.result ? { eyecatch: eyecatch.result } : {}),
  };
}

/** Repeatable and comma-separated option values, e.g. --hashtag a --hashtag b,c. */
function list(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .filter((x): x is string => typeof x === "string")
    .flatMap((x) => x.split(/[,、]/))
    .map((x) => x.trim())
    .filter(Boolean);
}

function publishSettings(values: Values): PublishSettings {
  const price = int(values.price, "price");
  if (price !== 0 && (price < 100 || price > 50000)) {
    throw new CliError("USAGE", "--price must be 0 (free) or between 100 and 50000 yen.");
  }
  let publishAt: string | undefined;
  if (typeof values.schedule === "string") {
    const at = new Date(values.schedule);
    if (Number.isNaN(at.getTime())) {
      throw new CliError("USAGE", `--schedule is not a date/time: "${values.schedule}". Use e.g. 2026-12-01T09:00+09:00.`);
    }
    if (at.getTime() < Date.now() + 5 * 60_000) throw new CliError("USAGE", "--schedule must be at least 5 minutes in the future.");
    publishAt = at.toISOString();
  }
  return {
    hashtags: [...new Set(list(values.hashtag).map(v.hashtag))],
    price,
    magazineKeys: [...new Set(list(values.magazine).map(v.magazineKey))],
    publishAt,
    notify: !values["no-notify"],
    toc: Boolean(values.toc),
    disableComments: Boolean(values["disable-comments"]),
    refund: Boolean(values.refund),
    hideFromProfile: Boolean(values["hide-from-profile"]),
  };
}

/**
 * --membership values -> note's `circle_permissions`: `all` = every member of your membership,
 * plan keys = only those plans, `none` = take the article out of the membership.
 */
export function circlePermissions(choices: string[], access: api.MembershipAccess[]): CirclePermission[] {
  if (choices.includes("none")) {
    if (choices.length > 1) throw new CliError("USAGE", "--membership none cannot be combined with other values.");
    return [];
  }
  const circle = access[0];
  if (!circle) throw new CliError("FORBIDDEN", "You have no membership (メンバーシップ) to publish the article to.");
  if (choices.includes("all")) {
    if (choices.length > 1) throw new CliError("USAGE", "--membership all already covers every plan; do not list plans with it.");
    return [{ kind: "circle", keys: [circle.circle.key] }];
  }
  const known = new Map(access.flatMap((a) => a.plans.map((p) => [p.key, p])));
  const unknown = choices.filter((c) => !known.has(c));
  if (unknown.length) {
    const plans = [...known.values()].map((p) => `${p.key}${p.name ? ` (${p.name})` : ""}`).join(", ") || "none";
    throw new CliError("USAGE", `Unknown membership plan: ${unknown.join(", ")}. Your plans: ${plans}.`);
  }
  return [{ kind: "circle_plan", keys: [...new Set(choices)] }];
}

function dashboardRangeFrom(values: Values) {
  const period = oneOf(values.period, Object.keys(api.DASHBOARD_PERIODS), "period") as api.DashboardPeriod;
  const date = (x: unknown, name: string) => {
    if (x === undefined) return undefined;
    if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(new Date(x).getTime())) {
      throw new CliError("USAGE", `--${name} must be a date like 2026-10-01.`);
    }
    return x;
  };
  const from = date(values.from, "from");
  const to = date(values.to, "to");
  if (period !== "custom" && (from || to)) throw new CliError("USAGE", "--from/--to only apply with --period custom.");
  if (from && to && from > to) throw new CliError("USAGE", "--from must not be after --to.");
  return api.dashboardRange(period, { from, to });
}

/** The title/body the editor currently holds (an article being re-edited keeps its edits in note_draft). */
function noteFromDraft(data: any): { name: string; body: string; slug: string | null; key: string | null } {
  const draft = data?.note_draft ?? {};
  const name = draft.name ?? data?.name;
  const body = draft.body ?? data?.body;
  if (typeof name !== "string" || !name.trim()) throw new CliError("INVALID_INPUT", "The draft has no title; set one before publishing.");
  if (typeof body !== "string" || !body.trim()) throw new CliError("INVALID_INPUT", "The draft has no body; save content before publishing.");
  return { name, body, slug: typeof data?.slug === "string" ? data.slug : null, key: typeof data?.key === "string" ? data.key : null };
}

async function savedNote(client: NoteClient, key: string) {
  const data = await api.getDraft(client, key);
  if (!data) throw new CliError("NOT_FOUND", `Could not find your article ${key}.`);
  return noteFromDraft(data);
}

function publishPreview(p: ReturnType<typeof buildPublishPayload>) {
  return {
    title: p.name,
    status: p.status,
    publishAt: p.publish_at ?? null,
    price: p.price,
    hashtags: p.hashtags.map((h) => h.slice(1)),
    magazineKeys: p.magazine_keys,
    toc: p.index,
    disableComments: p.disable_comment,
    refund: p.is_refund,
    notify: p.send_notifications_flag,
    hideFromProfile: p.exclude_from_creator_top,
    ...(p.circle_permissions ? { membership: p.circle_permissions } : {}),
    bodyLength: p.body_length,
    freeLength: visibleTextLength(p.free_body),
    paidLength: visibleTextLength(p.pay_body),
    images: p.image_keys.length,
  };
}

function publishError(res: { status: number; body: any; challenges: string[] }, settings: PublishSettings): CliError {
  const message: string = res.body?.error?.message ?? (typeof res.body === "string" ? res.body.slice(0, 300) : JSON.stringify(res.body ?? null).slice(0, 300));
  if (settings.publishAt && res.status === 422 && /予約/.test(message)) {
    return new CliError("FORBIDDEN", `note refused the scheduled post (${message}). Scheduled posting needs a note premium account.`, {
      status: res.status,
      detail: res.body,
    });
  }
  const code = res.status === 401 ? "AUTH_ERROR" : "PUBLISH_FAILED";
  return new CliError(code, `Publishing failed: HTTP ${res.status}. ${message}`, { status: res.status, detail: { challenges: res.challenges, body: res.body } });
}

async function follow(client: NoteClient, urlname: string, on: boolean) {
  const creator = await api.getCreator(client, urlname);
  const userKey = creator?.key;
  if (typeof userKey !== "string") throw new CliError("NOT_FOUND", `Could not find creator "${urlname}".`);
  await api.followUser(client, userKey, on);
  return { following: on, urlname, nickname: creator?.nickname ?? null };
}

/** Accept a full Cookie header, `_note_session_v5=...`, or just the bare session value. */
export function parseImportedCookies(raw: string): Record<string, string> {
  const s = raw.trim();
  const cookies = s.includes("=") ? parseCookieHeader(s) : s ? { _note_session_v5: s } : {};
  if (!cookies._note_session_v5) {
    throw new CliError("INVALID_INPUT", "Expected a Cookie header containing _note_session_v5, or the _note_session_v5 value itself.");
  }
  return cookies;
}

/** Body as text (default) or HTML, cut to `maxChars` characters (0 = no limit) so long articles don't flood an agent's context. */
function bodyField(html: string, asHtml: boolean, maxChars: number) {
  const full = asHtml ? html : htmlToText(html);
  const chars = [...full];
  const truncated = maxChars > 0 && chars.length > maxChars;
  const body = truncated ? chars.slice(0, maxChars).join("") : full;
  return { ...(asHtml ? { bodyHtml: body } : { bodyText: body }), bodyChars: chars.length, truncated };
}

/** Only mention skipped rows when there were some. */
function skippedField(skipped: Skipped[]) {
  return skipped.length ? { skipped: { count: skipped.length, rows: skipped.slice(0, 10) } } : {};
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

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
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
    const result = await cmd.run({ values: values as Values, positionals, client, deps });
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
