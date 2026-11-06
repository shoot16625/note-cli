import { CliError, EDITOR_ORIGIN, type NoteClient } from "./client.ts";
import { normalizeNotes, type NoteSummary, type Skipped } from "./normalize.ts";

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
async function paginate(
  limit: number,
  pageSize: number,
  fetchBatch: (offset: number, size: number, pageIndex: number) => Promise<Batch>,
  startOffset = 0,
): Promise<Page<NoteSummary>> {
  const items: NoteSummary[] = [];
  const skipped: Skipped[] = [];
  let total: number | null = null;
  let exhausted = false;
  let offset = startOffset;
  for (let pageIndex = 0; items.length < limit; pageIndex++) {
    const size = Math.min(pageSize, limit - items.length);
    const batch = await fetchBatch(offset, size, pageIndex);
    const rowCount = Array.isArray(batch.rows) ? batch.rows.length : 0;
    const normalized = normalizeNotes(batch.rows, offset);
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
