import { CliError, EDITOR_ORIGIN, type NoteClient } from "./client.ts";
import { sniffImageType, stockPhotoCropUrl, stockPhotoRef, type ImageFile, type StockPhotoRef } from "./images.ts";
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
  /** Credit a gallery photo as the eyecatch. note only keeps it once the eyecatch is set. */
  opts: { stockPhotoImageId?: number } = {},
): Promise<unknown> {
  const res = await client.request("/v1/text_notes/draft_save", {
    method: "POST",
    auth: "required",
    editor: true,
    query: { id },
    json: {
      name: body.title,
      body: body.html,
      body_length: body.bodyLength,
      index: false,
      is_lead_form: false,
      ...(opts.stockPhotoImageId ? { stock_photo_image_id: opts.stockPhotoImageId } : {}),
    },
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

// ---------- みんなのフォトギャラリー ----------

export interface StockPhoto {
  /** Pass this to --eyecatch (or frontmatter `eyecatch:`) to use the photo as the cover. */
  eyecatch: string;
  stockPhotoImageId: number;
  thumbnailUrl: string | null;
  originalUrl: string;
  width: number | null;
  height: number | null;
  keywords: string[];
  /** Who note credits under the cover: the creator's urlname, or "artist / museum" for public-domain art. */
  credit: string | null;
  creator: { urlname: string; nickname: string | null } | null;
  artwork: { title: string | null; artistName: string | null; museumName: string | null } | null;
  sourceNote: { key: string; title: string | null } | null;
}

/** Search みんなのフォトギャラリー, the free photos the editor's 記事にあう画像を選ぶ offers. Needs login. */
export async function searchStockPhotos(
  client: NoteClient,
  opts: { query: string; page: number; size: number; publicDomainOnly: boolean },
): Promise<{ items: StockPhoto[]; isLastPage: boolean | null; skipped: Skipped[] }> {
  const res = await client.request("/v2/stock_photo_images", {
    auth: "required",
    query: { page: opts.page, query: opts.query, size: opts.size, public_domain_only: opts.publicDomainOnly },
  });
  const d = res?.data ?? {};
  const rows: any[] = Array.isArray(d.contents) ? d.contents : [];
  const items: StockPhoto[] = [];
  const skipped: Skipped[] = [];
  for (const [index, x] of rows.entries()) {
    const id = Number(x?.stockPhotoImageId ?? x?.stock_photo_image_id);
    const original = x?.url?.original;
    if (!Number.isInteger(id) || id <= 0 || typeof original !== "string") {
      skipped.push({ index, reason: "missing stockPhotoImageId or url.original" });
      continue;
    }
    const pd = (x.isPublicDomainImage ?? x.is_public_domain_image) === true;
    const art = x.publicDomainImageDetail ?? x.public_domain_image_detail ?? {};
    const artwork = pd ? { title: art.title ?? null, artistName: art.artistName ?? art.artist_name ?? null, museumName: art.museumName ?? art.museum_name ?? null } : null;
    const creator = !pd && x.user?.urlname ? { urlname: String(x.user.urlname), nickname: x.user.nickname ?? null } : null;
    items.push({
      eyecatch: stockPhotoRef(id, original.split("?")[0]),
      stockPhotoImageId: id,
      thumbnailUrl: x.url.stockPhotoThumb ?? x.url.stock_photo_thumb ?? x.url.imageUrl ?? null,
      originalUrl: original,
      width: typeof x.size?.width === "number" ? x.size.width : null,
      height: typeof x.size?.height === "number" ? x.size.height : null,
      keywords: Array.isArray(x.keywords) ? x.keywords.map((k: any) => k?.text).filter((t: unknown): t is string => typeof t === "string") : [],
      credit: artwork ? [artwork.artistName, artwork.museumName].filter(Boolean).join(" / ") || null : (creator?.urlname ?? null),
      creator,
      artwork,
      sourceNote: !pd && x.note?.key ? { key: String(x.note.key), title: x.note.name ?? null } : null,
    });
  }
  return { items, isLastPage: typeof d.isLastPage === "boolean" ? d.isLastPage : (d.is_last_page ?? null), skipped };
}

/** Download a gallery photo, center-cropped to note's 1280x670 eyecatch size by its image CDN. */
export async function downloadStockPhoto(client: NoteClient, ref: StockPhotoRef): Promise<ImageFile> {
  const { bytes } = await client.download(stockPhotoCropUrl(ref.url));
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new CliError("API_ERROR", `The gallery photo ${ref.url} did not download as an image.`);
  return { path: ref.url, filename: `stock-${ref.stockPhotoImageId}.jpg`, mimeType, bytes, stockPhotoImageId: ref.stockPhotoImageId };
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

/** A membership and its plans, as offered when choosing who may read an article. */
export interface MembershipAccess {
  circle: { key: string; name: string | null };
  plans: Array<{ key: string; name: string | null }>;
}

export async function membershipAccess(client: NoteClient): Promise<MembershipAccess[]> {
  const res = await client.request("/v3/memberships/circle_permissions", { auth: "required" });
  const rows: any[] = Array.isArray(res?.data) ? res.data : [];
  return rows
    .filter((r) => typeof r?.circle?.key === "string")
    .map((r) => ({
      circle: { key: r.circle.key, name: r.circle.name ?? null },
      plans: (Array.isArray(r.circle_plans) ? r.circle_plans : [])
        .filter((p: any) => typeof p?.key === "string")
        .map((p: any) => ({ key: p.key, name: p.name ?? null })),
    }));
}

// ---------------- dashboard (GraphQL) ----------------

const GRAPHQL_URL = "https://graphql.note.com/graphql";

/**
 * Run a query on note's GraphQL API as the logged-in user. The API takes a short-lived JWT that
 * `POST /v3/graphql/auth` sets as the `note_gql_auth_token` cookie; without it, dashboard
 * queries quietly return zeros instead of failing.
 */
export async function graphql<T = any>(client: NoteClient, query: string, variables: Record<string, unknown>): Promise<T> {
  const auth = await client.requestRaw("/v3/graphql/auth", { method: "POST", auth: "required" });
  const token = auth.headers
    .getSetCookie()
    .map((c) => c.match(/^note_gql_auth_token=([^;]+)/)?.[1])
    .find(Boolean);
  if (!token) throw new CliError("AUTH_ERROR", "note did not issue a GraphQL token; run `note-cli auth login` again.");
  const res = await client.request(GRAPHQL_URL, { method: "POST", json: { query, variables }, bearer: token });
  if (Array.isArray(res?.errors) && res.errors.length) {
    throw new CliError("API_ERROR", `GraphQL error: ${res.errors.map((e: any) => e?.message).join("; ")}`, { detail: res.errors });
  }
  return res?.data as T;
}

export const DASHBOARD_PERIODS = {
  "7d": "LAST_7_DAYS",
  "28d": "LAST_28_DAYS",
  "365d": "LAST_365_DAYS",
  all: "ALL",
  "this-month": "THIS_MONTH",
  "last-month": "LAST_MONTH",
  custom: "CUSTOM",
} as const;
export type DashboardPeriod = keyof typeof DASHBOARD_PERIODS;

export const DASHBOARD_ORDERS = {
  published: "PUBLISHED_DATE_DESC",
  pv: "PAGE_VIEW_COUNT_DESC",
  impressions: "IMPRESSION_COUNT_DESC",
  likes: "LIKE_COUNT_DESC",
  comments: "COMMENT_COUNT_DESC",
  sales: "SALES_DESC",
} as const;
export type DashboardOrder = keyof typeof DASHBOARD_ORDERS;

export const DASHBOARD_METRICS = { impressions: "IMPRESSION", pv: "PAGE_VIEW", likes: "LIKE", comments: "COMMENT", sales: "SALES" } as const;
export type DashboardMetric = keyof typeof DASHBOARD_METRICS;

/** The variables note's dashboard sends: a period unit plus its first day (and last day for custom). */
export function dashboardRange(period: DashboardPeriod, opts: { from?: string; to?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = (d: Date) => {
    // The dashboard works in Japan time.
    const jst = new Date(d.getTime() + 9 * 3600_000);
    return jst.toISOString().slice(0, 10);
  };
  const minus = (days: number) => new Date(now.getTime() - days * 86400_000);
  const today = day(now);
  switch (period) {
    case "7d":
      return { unit: "LAST_7_DAYS", date: day(minus(6)), endDate: null, from: day(minus(6)), to: today };
    case "28d":
      return { unit: "LAST_28_DAYS", date: day(minus(27)), endDate: null, from: day(minus(27)), to: today };
    case "365d":
      return { unit: "LAST_365_DAYS", date: day(minus(364)), endDate: null, from: day(minus(364)), to: today };
    case "all":
      return { unit: "ALL", date: today, endDate: null, from: null, to: today };
    case "this-month":
      return { unit: "THIS_MONTH", date: `${today.slice(0, 7)}-01`, endDate: null, from: `${today.slice(0, 7)}-01`, to: today };
    case "last-month": {
      const [y, m] = today.split("-").map(Number);
      const first = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
      return { unit: "LAST_MONTH", date: first, endDate: null, from: first, to: null };
    }
    case "custom": {
      if (!opts.from || !opts.to) throw new CliError("USAGE", "--period custom needs --from and --to (YYYY-MM-DD).");
      return { unit: "CUSTOM", date: opts.from, endDate: opts.to, from: opts.from, to: opts.to };
    }
  }
}

type Range = ReturnType<typeof dashboardRange>;
const rangeVars = (r: Range) => ({ unit: r.unit, date: r.date, endDate: r.endDate });

const METRIC_FIELDS = "pageViewCount impressionCount likeCount commentCount salesAmount";

export interface DashboardMetrics {
  pageViews: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  sales: number | null;
}

const metrics = (m: any): DashboardMetrics => ({
  pageViews: num(m?.pageViewCount),
  impressions: num(m?.impressionCount),
  likes: num(m?.likeCount),
  comments: num(m?.commentCount),
  sales: num(m?.salesAmount),
});

export async function dashboardSummary(client: NoteClient, range: Range) {
  const data = await graphql(
    client,
    `query Summary($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime) {
      dashboardSummary(unit: $unit, date: $date, endDate: $endDate) { lastUpdatedAt metrics { ${METRIC_FIELDS} } }
    }`,
    rangeVars(range),
  );
  return { lastUpdatedAt: data?.dashboardSummary?.lastUpdatedAt ?? null, totals: metrics(data?.dashboardSummary?.metrics) };
}

/** Per-article numbers for the period, drafts included, newest first unless `order` says otherwise. */
export async function dashboardNotes(client: NoteClient, range: Range, opts: { order: DashboardOrder; limit: number }) {
  const notes: Array<{ key: string | null; title: string | null; status: string | null; publishedAt: string | null; url: string | null } & DashboardMetrics> = [];
  let after: string | null = null;
  while (notes.length < opts.limit) {
    const data: any = await graphql(
      client,
      `query Notes($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime, $order: DashboardNoteListOrder, $first: Int!, $after: String) {
        dashboardNoteListConnection(unit: $unit, date: $date, endDate: $endDate, order: $order, first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { note { key title status publishedAt link { absoluteUrl } } metrics { ${METRIC_FIELDS} } } }
        }
      }`,
      { ...rangeVars(range), order: DASHBOARD_ORDERS[opts.order], first: Math.min(50, opts.limit - notes.length), after },
    );
    const conn = data?.dashboardNoteListConnection;
    for (const edge of conn?.edges ?? []) {
      const n = edge?.node?.note ?? {};
      notes.push({
        key: n.key ?? null,
        title: n.title ?? null,
        status: n.status ?? null,
        publishedAt: n.publishedAt ?? null,
        url: n.link?.absoluteUrl ?? null,
        ...metrics(edge?.node?.metrics),
      });
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return notes.slice(0, opts.limit);
}

/** Where readers came from (note.com, search engines, X, ChatGPT, ...). */
export async function dashboardReferrers(client: NoteClient, range: Range) {
  const data = await graphql(
    client,
    `query Referrers($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime) {
      dashboardNoteReferrersChart(unit: $unit, date: $date, endDate: $endDate) { legend { name count } }
    }`,
    rangeVars(range),
  );
  const legend: any[] = data?.dashboardNoteReferrersChart?.legend ?? [];
  return legend.map((l) => ({ name: l?.name ?? null, count: num(l?.count) }));
}

/** One metric over time, by day/week/month depending on the period. */
export async function dashboardChart(client: NoteClient, range: Range, metric: DashboardMetric) {
  const data = await graphql(
    client,
    `query Chart($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime, $metric: DashboardMetricKind!) {
      dashboardMetricChart(unit: $unit, date: $date, endDate: $endDate, metric: $metric) { granularity points { label value startDate endDate } }
    }`,
    { ...rangeVars(range), metric: DASHBOARD_METRICS[metric] },
  );
  const chart = data?.dashboardMetricChart;
  return {
    granularity: chart?.granularity ?? null,
    points: (chart?.points ?? []).map((p: any) => ({ from: p?.startDate ?? null, to: p?.endDate ?? null, value: num(p?.value) })),
  };
}
