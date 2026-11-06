import { CliError, EDITOR_ORIGIN, type NoteClient } from "./client.ts";
import { normalizeNote, type NoteSummary } from "./normalize.ts";

export type SearchSort = "popular" | "hot" | "new";
export type HashtagOrder = "popular" | "hot" | "new";

export interface Page<T> {
  items: T[];
  total: number | null;
  /** true when the API reported no more pages (or the limit was reached exactly at the end) */
  exhausted: boolean;
}

// ---------- read (public) ----------

export async function searchNotes(
  client: NoteClient,
  q: string,
  opts: { sort?: SearchSort; limit?: number; start?: number } = {},
): Promise<Page<NoteSummary>> {
  const limit = opts.limit ?? 20;
  const pageSize = 20; // the API caps size at ~20
  let start = opts.start ?? 0;
  const items: NoteSummary[] = [];
  let total: number | null = null;
  let exhausted = false;
  while (items.length < limit) {
    const res = await client.request("/v3/searches", {
      auth: "optional",
      query: { context: "note", q, size: Math.min(pageSize, limit - items.length), start, sort: opts.sort ?? "popular" },
    });
    const notes = res?.data?.notes ?? {};
    const contents: any[] = notes.contents ?? [];
    total = notes.total_count ?? total;
    items.push(...contents.map(normalizeNote));
    start += contents.length;
    if (notes.is_last_page || contents.length === 0) {
      exhausted = true;
      break;
    }
  }
  return { items: items.slice(0, limit), total, exhausted };
}

export async function hashtagNotes(
  client: NoteClient,
  tag: string,
  opts: { order?: HashtagOrder; limit?: number; paidOnly?: boolean } = {},
): Promise<Page<NoteSummary>> {
  const limit = opts.limit ?? 50;
  const name = tag.replace(/^#/, "");
  const items: NoteSummary[] = [];
  let total: number | null = null;
  let exhausted = false;
  for (let page = 1; items.length < limit; page++) {
    const res = await client.request(`/v3/hashtags/${encodeURIComponent(name)}/notes`, {
      auth: "optional",
      query: { order: opts.order ?? "popular", page, paid_only: opts.paidOnly ? "true" : undefined },
    });
    const data = res?.data ?? {};
    const notes: any[] = data.notes ?? [];
    total = data.count ?? total;
    items.push(...notes.map(normalizeNote));
    if (data.is_last_page || notes.length === 0) {
      exhausted = true;
      break;
    }
  }
  return { items: items.slice(0, limit), total, exhausted };
}

export async function creatorNotes(
  client: NoteClient,
  urlname: string,
  opts: { limit?: number } = {},
): Promise<Page<NoteSummary>> {
  const limit = opts.limit ?? 50;
  const items: NoteSummary[] = [];
  let total: number | null = null;
  let exhausted = false;
  for (let page = 1; items.length < limit; page++) {
    const res = await client.request(`/v2/creators/${encodeURIComponent(urlname)}/contents`, {
      auth: "optional",
      query: { kind: "note", page },
    });
    const data = res?.data ?? {};
    const contents: any[] = data.contents ?? [];
    total = data.totalCount ?? total;
    items.push(...contents.map(normalizeNote));
    if (data.isLastPage || contents.length === 0) {
      exhausted = true;
      break;
    }
  }
  return { items: items.slice(0, limit), total, exhausted };
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

/** Accept either a numeric id or an `n...` key and return the numeric id. */
export async function resolveNoteId(client: NoteClient, idOrKey: string): Promise<{ id: number; key: string | null }> {
  if (/^\d+$/.test(idOrKey)) return { id: Number(idOrKey), key: null };
  const key = idOrKey.match(/n[0-9a-f]{12,}/)?.[0] ?? idOrKey;
  const data = await getDraft(client, key);
  if (!data?.id) throw new CliError("NOT_FOUND", `Could not resolve note id for "${idOrKey}".`);
  return { id: Number(data.id), key: data.key ?? key };
}

export async function myNotes(client: NoteClient, page = 1): Promise<{ items: NoteSummary[]; isLastPage: boolean | null }> {
  const res = await client.request("/v2/note_list/contents", { auth: "required", query: { page } });
  const data = res?.data ?? {};
  const list: any[] = data.notes ?? data.contents ?? (Array.isArray(data) ? data : []);
  return { items: list.map(normalizeNote), isLastPage: data.isLastPage ?? data.is_last_page ?? null };
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

export type PvFilter = "all" | "daily" | "weekly" | "monthly";
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
