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
  eyecatch: string | null;
  imageCount: number | null;
}

function pick<T = unknown>(obj: any, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** note's endpoints mix snake_case (v3) and camelCase (v2); accept both. */
export function normalizeNote(raw: any): NoteSummary {
  const user = raw.user ?? {};
  const urlname = pick<string>(user, "urlname") ?? null;
  const key = String(pick(raw, "key") ?? "");
  const price = Number(pick(raw, "price") ?? 0);
  const hashtags = (pick<any[]>(raw, "hashtags") ?? [])
    .map((h) => h?.hashtag?.name ?? h?.name ?? (typeof h === "string" ? h : null))
    .filter((h): h is string => Boolean(h))
    .map((h) => h.replace(/^#/, ""));
  return {
    id: (pick<number>(raw, "id") as number | undefined) ?? null,
    key,
    title: String(pick(raw, "name") ?? ""),
    url:
      pick<string>(raw, "noteUrl", "note_url") ??
      (urlname ? `https://note.com/${urlname}/n/${key}` : `https://note.com/n/${key}`),
    status: pick<string>(raw, "status") ?? null,
    author: { urlname, nickname: pick<string>(user, "nickname", "name") ?? null },
    likeCount: Number(pick(raw, "like_count", "likeCount") ?? 0),
    commentCount: (pick<number>(raw, "comment_count", "commentCount") as number | undefined) ?? null,
    price,
    isPaid: price > 0,
    publishAt: pick<string>(raw, "publish_at", "publishAt") ?? null,
    hashtags,
    eyecatch: pick<string>(raw, "eyecatch", "eyecatch_url", "eyecatchUrl") || null,
    imageCount: (pick<number>(raw, "image_count", "imageCount") as number | undefined) ?? null,
  };
}
