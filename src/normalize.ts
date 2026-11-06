import { htmlToText } from "./markdown.ts";

/** A compact, stable shape for articles regardless of which endpoint returned them. */
export interface NoteSummary {
  id: number | null;
  key: string;
  title: string;
  url: string;
  status: string | null;
  author: { urlname: string | null; nickname: string | null };
  likeCount: number;
  commentCount: number | null;
  price: number;
  isPaid: boolean;
  publishAt: string | null;
  hashtags: string[];
  /** Short plain-text lead (description or the start of the body), when the endpoint provides one. */
  excerpt: string | null;
  eyecatch: string | null;
  imageCount: number | null;
}

/** Rows that could not be read, so callers can surface API drift instead of silently filling defaults. */
export interface Skipped {
  index: number;
  reason: string;
}

export const EXCERPT_MAX_CHARS = 200;

function pick<T = unknown>(obj: any, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function toNumber(v: unknown): number | null {
  const n = Number(v);
  return v === undefined || v === null || Number.isNaN(n) ? null : n;
}

function hashtagsOf(raw: any): string[] {
  // v3 note detail uses hashtag_notes[].hashtag.name; v2 creator lists use hashtags[].hashtag.name.
  const list = pick<any[]>(raw, "hashtag_notes", "hashtagNotes", "hashtags");
  if (!Array.isArray(list)) return [];
  return list
    .map((h) => h?.hashtag?.name ?? h?.name ?? (typeof h === "string" ? h : null))
    .filter((h): h is string => typeof h === "string" && h.length > 0)
    .map((h) => h.replace(/^#/, ""));
}

export function makeExcerpt(raw: any, max = EXCERPT_MAX_CHARS): string | null {
  const source = pick<string>(raw, "description") || pick<string>(raw, "body");
  if (typeof source !== "string" || !source.trim()) return null;
  const text = htmlToText(source).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/**
 * Normalize one article. Returns a reason string instead of a summary when the row lacks
 * the fields every consumer relies on (key and title). Accepts both snake_case (v3) and camelCase (v2).
 */
export function tryNormalizeNote(raw: unknown): NoteSummary | string {
  if (!raw || typeof raw !== "object") return "row is not an object";
  const r = raw as any;
  const key = pick<string>(r, "key");
  if (typeof key !== "string" || !key) return "missing key";
  const title = pick<string>(r, "name");
  if (typeof title !== "string") return `missing title (key ${key})`;

  const user = r.user ?? {};
  const urlname = typeof user.urlname === "string" ? user.urlname : null;
  const price = toNumber(pick(r, "price")) ?? 0;
  return {
    id: toNumber(pick(r, "id")),
    key,
    title,
    url:
      pick<string>(r, "noteUrl", "note_url") ??
      (urlname ? `https://note.com/${urlname}/n/${key}` : `https://note.com/n/${key}`),
    status: pick<string>(r, "status") ?? null,
    author: { urlname, nickname: pick<string>(user, "nickname", "name") ?? null },
    likeCount: toNumber(pick(r, "like_count", "likeCount")) ?? 0,
    commentCount: toNumber(pick(r, "comment_count", "commentCount")),
    price,
    isPaid: price > 0,
    publishAt: pick<string>(r, "publish_at", "publishAt") ?? null,
    hashtags: hashtagsOf(r),
    excerpt: makeExcerpt(r),
    eyecatch: pick<string>(r, "eyecatch", "eyecatch_url", "eyecatchUrl") || null,
    imageCount: toNumber(pick(r, "image_count", "imageCount")),
  };
}

/** Normalize a list of rows, dropping unreadable ones and reporting why. */
export function normalizeNotes(rows: unknown, offset = 0): { items: NoteSummary[]; skipped: Skipped[] } {
  if (!Array.isArray(rows)) {
    return { items: [], skipped: rows === undefined || rows === null ? [] : [{ index: offset, reason: "list is not an array" }] };
  }
  const items: NoteSummary[] = [];
  const skipped: Skipped[] = [];
  rows.forEach((row, i) => {
    const n = tryNormalizeNote(row);
    if (typeof n === "string") skipped.push({ index: offset + i, reason: n });
    else items.push(n);
  });
  return { items, skipped };
}
