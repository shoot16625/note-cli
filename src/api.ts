import { CliError, EDITOR_ORIGIN, type NoteClient } from "./client.ts";
import type { ImageFile } from "./images.ts";
import {
  normalizeNotes,
  normalizeRows,
  tryNormalizeComment,
  tryNormalizeContest,
  tryNormalizeHashtag,
  tryNormalizeLike,
  tryNormalizeMagazine,
  tryNormalizeNote,
  tryNormalizeUser,
  type CommentSummary,
  type ContestSummary,
  type HashtagSummary,
  type LikeSummary,
  type MagazineSummary,
  type Normalizer,
  type NoteSummary,
  type Skipped,
  type UserSummary,
} from "./normalize.ts";

export type SearchSort = "popular" | "hot" | "new";
export type HashtagOrder = "popular" | "hot" | "new";

export interface Page<T> {
  items: T[];
  total: number | null;
  /** true when the source has no more results beyond what was fetched */
  exhausted: boolean;
  /** rows dropped because they lacked required fields (a sign the unofficial API changed) */
  skipped: Skipped[];
}

interface Batch {
  rows: unknown;
  total: number | null;
  /** the API's own "last page" flag, when it sends one */
  isLastPage: boolean | null;
}

/**
 * Shared pagination loop. Stops at `limit`, on an empty batch, on an explicit last-page flag,
 * when `total` has been reached, or when a batch comes back shorter than requested.
 */
async function paginate<T = NoteSummary>(
  limit: number,
  pageSize: number,
  fetchBatch: (offset: number, size: number, pageIndex: number) => Promise<Batch>,
  startOffset = 0,
  normalize: Normalizer<T> = tryNormalizeNote as unknown as Normalizer<T>,
): Promise<Page<T>> {
  const items: T[] = [];
  const skipped: Skipped[] = [];
  let total: number | null = null;
  let exhausted = false;
  let offset = startOffset;
  for (let pageIndex = 0; items.length < limit; pageIndex++) {
    const size = Math.min(pageSize, limit - items.length);
    const batch = await fetchBatch(offset, size, pageIndex);
    const rowCount = Array.isArray(batch.rows) ? batch.rows.length : 0;
    const normalized = normalizeRows(batch.rows, normalize, offset);
    items.push(...normalized.items);
    skipped.push(...normalized.skipped);
    total = batch.total ?? total;
    offset += rowCount;
    if (
      rowCount === 0 ||
      batch.isLastPage === true ||
      (total !== null && offset >= total) ||
      (batch.isLastPage === null && rowCount < size)
    ) {
      exhausted = true;
      break;
    }
  }
  return { items: items.slice(0, limit), total, exhausted, skipped };
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// ---------- read (public) ----------

export async function searchNotes(
  client: NoteClient,
  q: string,
  opts: { sort?: SearchSort; limit?: number; start?: number } = {},
): Promise<Page<NoteSummary>> {
  // v3/searches caps size at ~20 and always sends is_last_page: null, so rely on total_count.
  return paginate(
    opts.limit ?? 20,
    20,
    async (start, size) => {
      const res = await client.request("/v3/searches", {
        auth: "optional",
        query: { context: "note", q, size, start, sort: opts.sort ?? "popular" },
      });
      const notes = res?.data?.notes ?? {};
      return { rows: notes.contents, total: num(notes.total_count), isLastPage: bool(notes.is_last_page) };
    },
    opts.start ?? 0,
  );
}

export type SearchType = "user" | "magazine" | "hashtag";

type SearchResult<K extends SearchType> = K extends "user"
  ? UserSummary
  : K extends "magazine"
    ? MagazineSummary
    : HashtagSummary;

const SEARCH_NORMALIZERS: { [K in SearchType]: Normalizer<SearchResult<K>> } = {
  user: tryNormalizeUser,
  magazine: tryNormalizeMagazine,
  hashtag: tryNormalizeHashtag,
};

/** Search creators, magazines or hashtags (the same endpoint as article search, with another context). */
export async function searchOther<K extends SearchType>(
  client: NoteClient,
  type: K,
  q: string,
  opts: { limit?: number; start?: number } = {},
): Promise<Page<SearchResult<K>>> {
  const bucket = { user: "users", magazine: "magazines", hashtag: "hashtags" }[type];
  return paginate(
    opts.limit ?? 20,
    20,
    async (start, size) => {
      const res = await client.request("/v3/searches", { auth: "optional", query: { context: type, q, size, start } });
      const list = res?.data?.[bucket] ?? {};
      return { rows: list.contents, total: num(list.total_count), isLastPage: bool(list.is_last_page) };
    },
    opts.start ?? 0,
    SEARCH_NORMALIZERS[type] as Normalizer<SearchResult<K>>,
  );
}

export interface HashtagInfo {
  name: string;
  count: number | null;
  related: HashtagSummary[];
}

/** Article count and related hashtags for one tag. */
export async function hashtagInfo(client: NoteClient, tag: string): Promise<HashtagInfo | null> {
  const res = await client.request(`/v2/hashtags/${encodeURIComponent(tag)}`, { auth: "optional" });
  const data = res?.data;
  if (!data || typeof data !== "object") return null;
  return {
    name: String(data.name ?? tag).replace(/^#/, ""),
    count: num(data.count),
    related: normalizeRows(data.relatedHashtags ?? data.related_hashtags, tryNormalizeHashtag).items,
  };
}

export async function hashtagNotes(
  client: NoteClient,
  tag: string,
  opts: { order?: HashtagOrder; limit?: number; paidOnly?: boolean } = {},
): Promise<Page<NoteSummary>> {
  // Fixed 50 rows per page; `size` is not a parameter, so the short-batch rule is disabled via isLastPage.
  return paginate(opts.limit ?? 50, 50, async (_offset, _size, pageIndex) => {
    const res = await client.request(`/v3/hashtags/${encodeURIComponent(tag)}/notes`, {
      auth: "optional",
      query: { order: opts.order ?? "popular", page: pageIndex + 1, paid_only: opts.paidOnly ? "true" : undefined },
    });
    const data = res?.data ?? {};
    return { rows: data.notes, total: num(data.count), isLastPage: bool(data.is_last_page) ?? false };
  });
}

export async function creatorNotes(
  client: NoteClient,
  urlname: string,
  opts: { limit?: number } = {},
): Promise<Page<NoteSummary>> {
  return paginate(opts.limit ?? 50, 50, async (_offset, _size, pageIndex) => {
    const res = await client.request(`/v2/creators/${encodeURIComponent(urlname)}/contents`, {
      auth: "optional",
      query: { kind: "note", page: pageIndex + 1 },
    });
    const data = res?.data ?? {};
    return { rows: data.contents, total: num(data.totalCount), isLastPage: bool(data.isLastPage) ?? false };
  });
}

export async function getCreator(client: NoteClient, urlname: string): Promise<any> {
  const res = await client.request(`/v2/creators/${encodeURIComponent(urlname)}`, { auth: "optional" });
  return res?.data;
}

export async function getNote(client: NoteClient, key: string): Promise<any> {
  const res = await client.request(`/v3/notes/${encodeURIComponent(key)}`, { auth: "optional" });
  return res?.data;
}

export async function noteLikes(client: NoteClient, key: string, opts: { limit?: number } = {}): Promise<Page<LikeSummary>> {
  // 50 users per page; the total lives in extra_fields.like_count and is_last_page sits at the top level.
  return paginate(
    opts.limit ?? 50,
    50,
    async (_offset, _size, pageIndex) => {
      const res = await client.request(`/v3/notes/${encodeURIComponent(key)}/likes`, {
        auth: "optional",
        query: { page: pageIndex + 1 },
      });
      return {
        rows: res?.data?.likes,
        total: num(res?.data?.extra_fields?.like_count),
        isLastPage: bool(res?.is_last_page ?? res?.data?.is_last_page) ?? false,
      };
    },
    0,
    tryNormalizeLike,
  );
}

/** Top-level comments (replies are counted in replyCount, not listed). */
export async function noteComments(
  client: NoteClient,
  key: string,
  opts: { limit?: number } = {},
): Promise<Page<CommentSummary>> {
  return paginate(
    opts.limit ?? 50,
    20,
    async (_offset, _size, pageIndex) => {
      const res = await client.request(`/v3/notes/${encodeURIComponent(key)}/note_comments`, {
        auth: "optional",
        query: { page: pageIndex + 1 },
      });
      return {
        rows: res?.data,
        total: num(res?.total_count),
        isLastPage: res && "next_page" in res ? res.next_page === null : false,
      };
    },
    0,
    tryNormalizeComment,
  );
}

export async function getMagazine(client: NoteClient, key: string): Promise<MagazineSummary> {
  const res = await client.request(`/v1/magazines/${encodeURIComponent(key)}`, { auth: "optional" });
  const m = tryNormalizeMagazine(res?.data);
  if (typeof m === "string") throw new CliError("API_ERROR", `Unexpected response for magazine ${key}: ${m}.`);
  return m;
}

export async function magazineNotes(
  client: NoteClient,
  key: string,
  opts: { limit?: number } = {},
): Promise<Page<NoteSummary>> {
  // This section endpoint reports total_count 0; rely on is_last_page.
  return paginate(opts.limit ?? 20, 20, async (_offset, _size, pageIndex) => {
    const res = await client.request(`/v1/layout/magazine/${encodeURIComponent(key)}/section`, {
      auth: "optional",
      query: { page: pageIndex + 1 },
    });
    const section = res?.data?.section ?? {};
    return { rows: section.contents, total: null, isLastPage: bool(section.is_last_page) ?? false };
  });
}

export interface Category {
  id: number | null;
  name: string;
  /** Pass this to `category`. */
  slug: string;
}

/** note's article categories. Only those with an article feed are returned (topic pages have none). */
export async function categories(client: NoteClient): Promise<Category[]> {
  const res = await client.request("/v2/categories", { auth: "optional" });
  const list = res?.data?.categories;
  if (!Array.isArray(list)) return [];
  const out: Category[] = [{ id: null, name: "注目 (featured)", slug: "featured" }];
  for (const c of list) {
    if (typeof c?.engName === "string" && typeof c?.endpoint === "string" && c.endpoint.includes("/v1/categories/")) {
      out.push({ id: num(c.id), name: String(c.name ?? c.engName), slug: c.engName });
    }
  }
  return out;
}

export type CategorySort = "new" | "trend";

export async function categoryNotes(
  client: NoteClient,
  slug: string,
  opts: { sort?: CategorySort; limit?: number } = {},
): Promise<Page<NoteSummary>> {
  return paginate(opts.limit ?? 20, 10, async (_offset, _size, pageIndex) => {
    const res =
      slug === "featured"
        ? await client.request("/v3/notes/top_articles", { auth: "optional", query: { page: pageIndex + 1 } })
        : await client.request(`/v1/categories/${encodeURIComponent(slug)}`, {
            auth: "optional",
            query: { note_intro_only: "true", sort: opts.sort ?? "new", page: pageIndex + 1 },
          });
    const data = res?.data ?? {};
    return { rows: data.notes ?? data.articles, total: null, isLastPage: bool(data.last_page) ?? false };
  });
}

export type ContestState = "opened" | "closed" | "finished";

export async function contests(client: NoteClient): Promise<{ items: ContestSummary[]; skipped: Skipped[] }> {
  const res = await client.request("/v2/contests", { auth: "optional" });
  return normalizeRows(res?.data?.contests, tryNormalizeContest);
}

// ---------- authenticated ----------

export async function currentUser(client: NoteClient): Promise<any> {
  const res = await client.request("/v2/current_user", { auth: "required" });
  if (!res?.data) throw new CliError("AUTH_ERROR", "current_user returned no data; session is likely invalid.");
  return res.data;
}

export async function getDraft(client: NoteClient, key: string): Promise<any> {
  const res = await client.request(`/v3/notes/${encodeURIComponent(key)}`, {
    auth: "required",
    query: { draft: "true", draft_reedit: "false" },
  });
  return res?.data;
}

/** Turn a validated numeric id or note key into the numeric id the draft APIs need. */
export async function resolveNoteId(
  client: NoteClient,
  ref: { id: number } | { key: string },
): Promise<{ id: number; key: string | null }> {
  if ("id" in ref) return { id: ref.id, key: null };
  const data = await getDraft(client, ref.key);
  if (!data?.id) throw new CliError("NOT_FOUND", `Could not resolve note id for "${ref.key}".`);
  return { id: Number(data.id), key: data.key ?? ref.key };
}

export async function myNotes(
  client: NoteClient,
  page = 1,
): Promise<{ items: NoteSummary[]; skipped: Skipped[]; isLastPage: boolean | null }> {
  const res = await client.request("/v2/note_list/contents", { auth: "required", query: { page } });
  const data = res?.data ?? {};
  const list = data.notes ?? data.contents ?? (Array.isArray(data) ? data : undefined);
  const { items, skipped } = normalizeNotes(list);
  return { items, skipped, isLastPage: bool(data.isLastPage) ?? bool(data.is_last_page) };
}

export interface DraftRef {
  id: number;
  key: string;
  editUrl: string;
}

export function editUrl(key: string): string {
  return `${EDITOR_ORIGIN}/notes/${key}/edit/`;
}

/** Create an empty draft and return its id/key. */
export async function createDraft(client: NoteClient, title: string): Promise<DraftRef> {
  const res = await client.request("/v1/text_notes", {
    method: "POST",
    auth: "required",
    editor: true,
    json: { body: "<p></p>", body_length: 0, name: title, index: false, is_lead_form: false },
  });
  const d = res?.data ?? res;
  const note = d?.note ?? d?.text_note ?? d;
  const id = note?.id ?? d?.note_id;
  const key = note?.key ?? d?.note_key;
  if (!id || !key) {
    throw new CliError("API_ERROR", "Draft was created but id/key were missing from the response.", { detail: res });
  }
  return { id: Number(id), key, editUrl: editUrl(key) };
}

export async function saveDraft(
  client: NoteClient,
  id: number,
  body: { title: string; html: string; bodyLength: number },
): Promise<unknown> {
  const res = await client.request("/v1/text_notes/draft_save", {
    method: "POST",
    auth: "required",
    editor: true,
    query: { id },
    json: { name: body.title, body: body.html, body_length: body.bodyLength, index: false, is_lead_form: false },
  });
  return res?.data ?? res;
}

export async function deleteDraft(client: NoteClient, id: number): Promise<unknown> {
  const res = await client.request("/v1/text_notes/draft_delete", {
    method: "DELETE",
    auth: "required",
    editor: true,
    query: { id },
  });
  return res?.data ?? res;
}

export type PvFilter = "all" | "daily" | "weekly" | "monthly" | "yearly";
export type PvSort = "pv" | "like" | "comment";

export async function statsPv(
  client: NoteClient,
  opts: { filter?: PvFilter; page?: number; sort?: PvSort } = {},
): Promise<any> {
  const res = await client.request("/v1/stats/pv", {
    auth: "required",
    query: { filter: opts.filter ?? "all", page: opts.page ?? 1, sort: opts.sort ?? "pv" },
  });
  return res?.data ?? res;
}

// ---------- images ----------

export interface UploadedImage {
  /** Public URL to embed in a note body. */
  url: string;
}

/**
 * Upload an image to note's storage: ask note for a presigned S3 POST, then send the file there.
 * The returned URL can be used in `<img src>` inside a draft body.
 */
export async function uploadImage(
  client: NoteClient,
  image: Pick<ImageFile, "bytes" | "filename" | "mimeType">,
): Promise<UploadedImage> {
  const presignForm = new FormData();
  presignForm.append("filename", image.filename);
  const res = await client.request("/v3/images/upload/presigned_post", {
    method: "POST",
    auth: "required",
    editor: true,
    form: presignForm,
  });
  const data = res?.data ?? {};
  const url = data.url;
  const action = data.action;
  const post = data.post;
  if (typeof url !== "string" || typeof action !== "string" || !post || typeof post !== "object") {
    throw new CliError("API_ERROR", "Image upload: presigned_post response was missing url/action/post.", { detail: res });
  }
  const s3Form = new FormData();
  for (const [k, v] of Object.entries(post as Record<string, unknown>)) {
    if (v !== null && v !== undefined && v !== "") s3Form.append(k, String(v));
  }
  // S3 requires the file to be the last field.
  s3Form.append("file", new Blob([image.bytes], { type: image.mimeType }), image.filename);
  await client.postForm(action, s3Form);
  return { url };
}

/** Set a draft's eyecatch (cover) image. note requires a 1280:670 aspect ratio. */
export async function setEyecatch(
  client: NoteClient,
  noteId: number,
  image: Pick<ImageFile, "bytes" | "filename" | "mimeType">,
): Promise<{ url: string | null }> {
  const form = new FormData();
  form.append("note_id", String(noteId));
  form.append("file", new Blob([image.bytes], { type: image.mimeType }), image.filename);
  const res = await client.request("/v1/image_upload/note_eyecatch", {
    method: "POST",
    auth: "required",
    editor: true,
    form,
  });
  // Validation failures (e.g. wrong aspect ratio) come back as HTTP 200 with an error body.
  if (res?.error) {
    const message = typeof res.error.message === "string" ? res.error.message : JSON.stringify(res.error);
    throw new CliError("API_ERROR", `Eyecatch was rejected: ${message}`, { detail: res });
  }
  const d = res?.data ?? res;
  const url = d?.url ?? d?.eyecatch_url ?? d?.eyecatch ?? null;
  return { url: typeof url === "string" ? url : null };
}

// ---------- actions (authenticated) ----------

const write = (client: NoteClient, path: string, method: "POST" | "PUT" | "DELETE", json?: unknown) =>
  client.request(path, { method, auth: "required", ...(json !== undefined ? { json } : {}) });

export async function likeNote(client: NoteClient, key: string, like: boolean): Promise<unknown> {
  const res = await write(client, `/v3/notes/${encodeURIComponent(key)}/likes`, like ? "POST" : "DELETE", like ? {} : undefined);
  return res?.data ?? res;
}

/** note stores comments as a tiny AST; each line of text becomes a paragraph. */
export function commentAst(text: string) {
  return {
    type: "root",
    children: text.split(/\n{2,}/).map((para) => ({
      type: "element",
      tag_name: "p",
      children: [{ type: "text", value: para }],
    })),
  };
}

export async function postComment(
  client: NoteClient,
  key: string,
  text: string,
  opts: { replyTo?: string } = {},
): Promise<CommentSummary> {
  const res = await write(client, `/v3/notes/${encodeURIComponent(key)}/note_comments`, "POST", {
    comment: commentAst(text),
    ...(opts.replyTo ? { parent_key: opts.replyTo } : {}),
  });
  if (res?.error) throw new CliError("API_ERROR", `Comment was rejected: ${res.error.message ?? JSON.stringify(res.error)}`, { detail: res });
  const c = tryNormalizeComment(res?.data ?? res);
  if (typeof c === "string") throw new CliError("API_ERROR", `Comment was posted but the response was unexpected: ${c}.`, { detail: res });
  return c;
}

export async function deleteComment(client: NoteClient, key: string, commentKey: string): Promise<void> {
  await write(client, `/v3/notes/${encodeURIComponent(key)}/note_comments/${encodeURIComponent(commentKey)}`, "DELETE");
}

/** Follow or unfollow a creator. The path takes the user's hex `key`, not the numeric id or urlname. */
export async function followUser(client: NoteClient, userKey: string, follow: boolean): Promise<unknown> {
  const res = await write(client, `/v3/users/${encodeURIComponent(userKey)}/following`, follow ? "POST" : "DELETE", follow ? {} : undefined);
  return res?.data ?? res ?? null;
}

/** Turn a published or scheduled article back into a draft (the "下書きに戻す" menu item). */
export async function changeToDraft(client: NoteClient, key: string): Promise<unknown> {
  const res = await write(client, `/v2/notes/${encodeURIComponent(key)}/change_status`, "POST", { status: "draft" });
  if (res?.error) throw new CliError("API_ERROR", `Could not change ${key} to a draft: ${res.error.message ?? JSON.stringify(res.error)}`, { detail: res });
  return res?.data ?? res;
}

export interface MyMagazine {
  id: number | null;
  key: string;
  name: string;
  status: string | null;
  noteCount: number | null;
  /** Whether the note passed as `noteKey` is already in this magazine (when the API says). */
  includesNote: boolean | null;
}

/** Magazines you can add articles to. */
export async function myMagazines(client: NoteClient, noteKey?: string): Promise<MyMagazine[]> {
  const res = await client.request("/v1/my/magazines", { auth: "required", query: { note_key: noteKey } });
  const list = res?.data?.magazines;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m: any) => typeof m?.key === "string")
    .map((m: any) => ({
      id: num(m.id),
      key: m.key,
      name: String(m.name ?? ""),
      status: typeof m.status === "string" ? m.status : null,
      noteCount: num(m.note_count),
      includesNote: bool(m.selected ?? m.is_added ?? m.included),
    }));
}

export async function addToMagazine(client: NoteClient, magazineKey: string, noteKey: string, add: boolean): Promise<unknown> {
  const base = `/v1/our/magazines/${encodeURIComponent(magazineKey)}/notes`;
  const res = add
    ? await write(client, base, "POST", { note_key: noteKey })
    : await write(client, `${base}/${encodeURIComponent(noteKey)}`, "DELETE");
  if (res?.error) throw new CliError("API_ERROR", `Magazine update failed: ${res.error.message ?? JSON.stringify(res.error)}`, { detail: res });
  return res?.data ?? res;
}

/** Your scheduled (reserved) articles. */
export async function reservedNotes(client: NoteClient): Promise<{ items: NoteSummary[]; skipped: Skipped[] }> {
  const res = await client.request("/v3/notes/reserved", { auth: "required" });
  return normalizeRows(res?.data, tryNormalizeNote);
}

export async function noticeCounts(client: NoteClient): Promise<{ notices: number | null; infoNotices: number | null; messages: number | null }> {
  const res = await client.request("/v3/notice_counts", { auth: "required" });
  const d = res?.data ?? {};
  return { notices: num(d.unread_notice_count), infoNotices: num(d.unread_info_notice_count), messages: num(d.unread_dm_count) };
}

export async function membershipPlans(client: NoteClient): Promise<unknown[]> {
  const res = await client.request("/v2/circle/plans", { auth: "required" });
  const plans = res?.data?.circlePlans ?? res?.data?.circle_plans;
  return Array.isArray(plans) ? plans : [];
}

export async function membershipSummaries(client: NoteClient): Promise<{ total: number | null; items: unknown[] }> {
  const res = await client.request("/v2/circle/memberships/summaries", { auth: "required" });
  const d = res?.data ?? {};
  return { total: num(d.totalCount ?? d.total_count), items: Array.isArray(d.summaries) ? d.summaries : [] };
}
