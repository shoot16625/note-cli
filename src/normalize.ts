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
  return normalizeRows(rows, tryNormalizeNote, offset);
}

// ---------- other entities ----------

export type Normalizer<T> = (raw: unknown) => T | string;

/** Normalize a list with any row normalizer, dropping unreadable rows and reporting why. */
export function normalizeRows<T>(
  rows: unknown,
  normalize: Normalizer<T>,
  offset = 0,
): { items: T[]; skipped: Skipped[] } {
  if (!Array.isArray(rows)) {
    return { items: [], skipped: rows === undefined || rows === null ? [] : [{ index: offset, reason: "list is not an array" }] };
  }
  const items: T[] = [];
  const skipped: Skipped[] = [];
  rows.forEach((row, i) => {
    const n = normalize(row);
    if (typeof n === "string") skipped.push({ index: offset + i, reason: n });
    else items.push(n);
  });
  return { items, skipped };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export interface UserSummary {
  id: number | null;
  urlname: string;
  nickname: string | null;
  url: string;
  profile: string | null;
  followerCount: number | null;
  followingCount: number | null;
  isOfficial: boolean | null;
}

export function tryNormalizeUser(raw: unknown): UserSummary | string {
  if (!raw || typeof raw !== "object") return "row is not an object";
  const r = raw as any;
  const urlname = str(r.urlname);
  if (!urlname) return "missing urlname";
  const profile = str(r.profile);
  return {
    id: toNumber(r.id),
    urlname,
    nickname: str(pick(r, "nickname", "name")),
    url: `https://note.com/${urlname}`,
    profile: profile ? truncate(profile.replace(/\s+/g, " ").trim(), EXCERPT_MAX_CHARS) : null,
    followerCount: toNumber(pick(r, "follower_count", "followerCount")),
    followingCount: toNumber(pick(r, "following_count", "followingCount")),
    isOfficial: typeof r.is_official === "boolean" ? r.is_official : null,
  };
}

export interface MagazineSummary {
  id: number | null;
  key: string;
  name: string;
  url: string;
  description: string | null;
  author: { urlname: string | null; nickname: string | null };
  price: number;
  isPaid: boolean;
  noteCount: number | null;
  updatedAt: string | null;
}

export function tryNormalizeMagazine(raw: unknown): MagazineSummary | string {
  if (!raw || typeof raw !== "object") return "row is not an object";
  const r = raw as any;
  const key = str(r.key);
  if (!key) return "missing key";
  const name = pick<string>(r, "name");
  if (typeof name !== "string") return `missing name (key ${key})`;
  const user = r.user ?? {};
  const urlname = str(user.urlname);
  const price = toNumber(r.price) ?? 0;
  const description = str(r.description);
  return {
    id: toNumber(r.id),
    key,
    name,
    url: str(pick(r, "magazine_url", "magazineUrl")) ?? (urlname ? `https://note.com/${urlname}/m/${key}` : `https://note.com/m/${key}`),
    description: description ? truncate(description, EXCERPT_MAX_CHARS) : null,
    author: { urlname, nickname: str(pick(user, "nickname", "name")) },
    price,
    isPaid: price > 0,
    noteCount: toNumber(pick(r, "note_count", "noteCount")),
    updatedAt: str(pick(r, "updated_at", "updatedAt")),
  };
}

export interface HashtagSummary {
  name: string;
  count: number | null;
  url: string;
}

export function tryNormalizeHashtag(raw: unknown): HashtagSummary | string {
  if (!raw || typeof raw !== "object") return "row is not an object";
  const r = raw as any;
  const full = str(r.name);
  if (!full) return "missing name";
  const name = full.replace(/^#/, "");
  return { name, count: toNumber(r.count), url: `https://note.com/hashtag/${encodeURIComponent(name)}` };
}

export interface LikeSummary {
  likedAt: string | null;
  user: { urlname: string | null; nickname: string | null; followerCount: number | null };
}

export function tryNormalizeLike(raw: unknown): LikeSummary | string {
  if (!raw || typeof raw !== "object") return "row is not an object";
  const r = raw as any;
  const user = r.user;
  if (!user || typeof user !== "object") return "missing user";
  return {
    likedAt: str(pick(r, "created_at", "createdAt")),
    user: {
      urlname: str(user.urlname),
      nickname: str(pick(user, "nickname", "name")),
      followerCount: toNumber(pick(user, "follower_count", "followerCount")),
    },
  };
}

export interface CommentSummary {
  key: string;
  text: string;
  author: { urlname: string | null; nickname: string | null };
  likeCount: number;
  replyCount: number;
  creatorReplied: boolean | null;
  createdAt: string | null;
}

/** Comments are stored as a small HTML-like AST ({type, children, value, tag_name}); flatten it to text. */
export function commentText(node: any): string {
  if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
  if (node.type === "text") return typeof node.value === "string" ? node.value : "";
  const children = Array.isArray(node.children) ? node.children : [];
  const inner = children.map(commentText).join("");
  if (node.tag_name === "br") return "\n";
  return node.tag_name === "p" ? `${inner}\n` : inner;
}

export function tryNormalizeComment(raw: unknown): CommentSummary | string {
  if (!raw || typeof raw !== "object") return "row is not an object";
  const r = raw as any;
  const key = str(r.key);
  if (!key) return "missing key";
  const user = r.user ?? {};
  const text = typeof r.comment === "string" ? r.comment : commentText(r.comment);
  return {
    key,
    text: text.trim(),
    author: { urlname: str(user.urlname), nickname: str(pick(user, "nickname", "name")) },
    likeCount: toNumber(pick(r, "like_count", "likeCount")) ?? 0,
    replyCount: toNumber(pick(r, "reply_count", "replyCount")) ?? 0,
    creatorReplied: typeof r.is_creator_replied === "boolean" ? r.is_creator_replied : null,
    createdAt: str(pick(r, "created_at", "createdAt")),
  };
}

export interface ContestSummary {
  id: number | null;
  name: string;
  type: string | null;
  state: string | null;
  hashtag: string | null;
  sponsor: string | null;
  openAt: string | null;
  closeAt: string | null;
  /** Announcement article, when the contest has one. */
  noteUrl: string | null;
}

export function tryNormalizeContest(raw: unknown): ContestSummary | string {
  if (!raw || typeof raw !== "object") return "row is not an object";
  const r = raw as any;
  const name = str(r.name);
  if (!name) return "missing name";
  const note = r.note && typeof r.note === "object" ? r.note : null;
  const noteUrl = note
    ? str(pick(note, "noteUrl", "note_url")) ??
      (str(note.key) && str(note.user?.urlname) ? `https://note.com/${note.user.urlname}/n/${note.key}` : null)
    : null;
  return {
    id: toNumber(r.id),
    name,
    type: str(r.type),
    state: str(r.state),
    hashtag: str(r.hashtag?.name)?.replace(/^#/, "") ?? null,
    sponsor: str(r.sponsor),
    openAt: str(r.openAt),
    // Ongoing themes use a far-future close date.
    closeAt: str(r.closeAt)?.startsWith("2999") ? null : str(r.closeAt),
    noteUrl,
  };
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
}
